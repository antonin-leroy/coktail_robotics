"""What each policy accepts, and how a training request becomes an HF Job command.

`plan()` is pure: it takes the user's spec plus the datasets' metadata, reports what is
compatible (errors block the launch, warnings don't) and returns the exact shell script the
job runs. Camera selection goes through `--policy.input_features` (policies built from the
dataset) or `--rename_map` (policies loaded from a pretrained config with fixed camera slots).
Co-training merges both datasets inside the job with `lerobot-edit-dataset`, because
`lerobot-train` takes a single dataset and merging requires identical features.
"""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import asdict, dataclass, field

from pydantic import BaseModel, Field

WORK_DIR = "/tmp/studio"  # inside the job container
BROWSER_SAFE_CODECS = {"av1", "h264", "vp9", "vp8"}


@dataclass(frozen=True)
class Policy:
    id: str
    name: str
    summary: str
    base_args: tuple[str, ...]
    max_cameras: int | None  # None: any number
    # Camera inputs of the pretrained model, in its order: (policy key, role). Our cameras are
    # renamed onto them with --rename_map; empty means camera names come from the dataset.
    camera_slots: tuple[tuple[str, str], ...] = ()
    # Policy built with --policy.type (features from the dataset, so we set them in slot order and
    # mask unused slots with empty_cameras) rather than --policy.path (features from the checkpoint).
    slots_from_type: bool = False
    supports_depth: bool = False
    uses_language: bool = False
    max_state_dim: int | None = None
    min_vram_gb: int = 8
    default_steps: int = 20_000
    default_batch_size: int = 8
    default_flavor: str = "a10g-small"
    # Seconds per training sample on an A10G-class GPU (low, high), derived from LeRobot's
    # "Compute HW Guide" (5 epochs over ~45k frames at 640x480): ACT bs8 1-2 h on L4/A10G,
    # SmolVLA bs4 3-6 h on L4/A10G (and bs16 1-2 h on A100), pi0/pi05 bs4 4-8 h on A100.
    sec_per_sample: tuple[float, float] = (0.016, 0.032)
    # Hub repos the job downloads that may be gated (the HF token needs access).
    required_repos: tuple[str, ...] = ()


# Throughput relative to an A10G. T4/L4/A10G/A100 follow the guide's rows (T4 is its ACT-only
# tier, A100 ~3x from the SmolVLA rows); the others are extrapolated from their class.
GPU_SPEED: dict[str, tuple[float, bool]] = {  # model -> (speedup, extrapolated)
    "T4": (0.5, False),
    "L4": (1.0, False),
    "A10G": (1.0, False),
    "A100": (3.0, False),
    "L40S": (2.0, True),
    "RTX PRO 6000": (3.5, True),
    "H200": (5.0, True),
}
JOB_OVERHEAD_S = (300, 600)  # image pull, dataset download, model push: our estimate


POLICIES: dict[str, Policy] = {
    p.id: p
    for p in [
        Policy(
            id="act",
            name="ACT",
            summary="Trained from scratch. Small and fast, one model per task.",
            base_args=("--policy.type=act",),
            max_cameras=None,
            min_vram_gb=8,
            default_steps=30_000,
            default_batch_size=8,
            default_flavor="a10g-small",
            sec_per_sample=(0.016, 0.032),
        ),
        Policy(
            id="smolvla",
            name="SmolVLA",
            summary="450M VLA fine-tuned from lerobot/smolvla_base. Follows the task text.",
            base_args=("--policy.path=lerobot/smolvla_base",),
            max_cameras=3,
            camera_slots=(("observation.images.camera1", "Camera 1"),
                          ("observation.images.camera2", "Camera 2"),
                          ("observation.images.camera3", "Camera 3")),
            uses_language=True,
            max_state_dim=32,
            min_vram_gb=16,
            default_steps=20_000,
            default_batch_size=32,
            default_flavor="a10g-large",
            sec_per_sample=(0.048, 0.096),
            required_repos=("lerobot/smolvla_base", "HuggingFaceTB/SmolVLM2-500M-Video-Instruct"),
        ),
        Policy(
            id="pi05",
            name="π0.5",
            summary="VLA fine-tuned from lerobot/pi05_base, the base of Ego-Pi. Follows the task text.",
            base_args=("--policy.type=pi05", "--policy.pretrained_path=lerobot/pi05_base",
                       "--policy.dtype=bfloat16", "--policy.gradient_checkpointing=true"),
            max_cameras=3,
            # pi05_base was pretrained on these three views (openpi naming).
            # Pretraining roles, not constraints: a second external view can take slot 2.
            camera_slots=(("observation.images.base_0_rgb", "1 · main view"),
                          ("observation.images.left_wrist_0_rgb", "2 · left wrist / 2nd view"),
                          ("observation.images.right_wrist_0_rgb", "3 · right wrist / 3rd view")),
            slots_from_type=True,
            uses_language=True,
            max_state_dim=32,
            min_vram_gb=40,
            default_steps=10_000,
            default_batch_size=16,
            default_flavor="a100-large",
            sec_per_sample=(0.19, 0.38),
            # Its tokenizer is PaliGemma's, gated by Google (access is reviewed by hand).
            required_repos=("lerobot/pi05_base", "google/paligemma-3b-pt-224"),
        ),
    ]
}


def default_camera_map(policy: Policy, cameras: list[str]) -> dict[str, str]:
    """Guess each camera's slot from its name (left/right wrist, else the head/base view)."""
    slots = [k for k, _ in policy.camera_slots]
    if policy.id != "pi05":
        return dict(zip(cameras, slots))
    out: dict[str, str] = {}
    for cam in cameras:
        name = cam.rsplit(".", 1)[-1]
        wanted = slots[1] if "left" in name else slots[2] if "right" in name else slots[0]
        free = [wanted] + [s for s in slots if s != wanted]
        slot = next((s for s in free if s not in out.values()), None)
        if slot:
            out[cam] = slot
    return out


class TrainSpec(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    policy: str
    dataset_repo_id: str
    ego_repo_id: str | None = None
    ego_max_episodes: int | None = Field(default=None, ge=1)
    cameras: list[str]
    # dataset camera key -> policy slot key, for policies with camera_slots (guessed if omitted)
    camera_map: dict[str, str] | None = None
    steps: int = Field(ge=100, le=1_000_000)
    batch_size: int = Field(ge=1, le=512)
    flavor: str
    timeout: str = "6h"
    log_freq: int = Field(default=100, ge=10)


@dataclass
class DatasetMeta:
    repo_id: str
    info: dict
    tasks: list[str]
    excluded: list[int]  # episode indices curated out
    has_quantiles: bool = True


@dataclass
class Issue:
    level: str  # error | warning | info
    message: str


@dataclass
class Plan:
    ok: bool
    issues: list[Issue]
    script: str
    model_repo_id: str
    merged: bool
    frames: dict[str, int]
    epochs: float
    camera_map: dict[str, str] = field(default_factory=dict)
    # Order-of-magnitude wall-clock (s) and cost (USD), or None for an unknown GPU.
    estimate: dict | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "run"


def camera_keys(info: dict) -> list[str]:
    return [k for k, f in info["features"].items() if f["dtype"] in ("video", "image", "depth")]


def is_depth(feature: dict) -> bool:
    i = feature.get("info") or {}
    return bool(i.get("is_depth_map") or i.get("video.is_depth_map") or feature["dtype"] == "depth")


def policy_feature(key: str, feature: dict) -> dict:
    """Same mapping as lerobot's dataset_to_policy_features, for the keys we keep."""
    shape = list(feature["shape"])
    if feature["dtype"] in ("video", "image", "depth"):
        names = feature.get("names") or []
        if len(names) == 3 and names[2] in ("channel", "channels"):
            shape = [shape[2], shape[0], shape[1]]
        return {"type": "VISUAL", "shape": shape}
    if key == "observation.environment_state":
        return {"type": "ENV", "shape": shape}
    return {"type": "STATE", "shape": shape}


def _num_frames(meta: DatasetMeta, keep: int | None = None) -> int:
    total = meta.info["total_frames"]
    episodes = meta.info["total_episodes"]
    if not episodes:
        return 0
    kept = episodes - len(meta.excluded)
    if keep is not None:
        kept = min(kept, keep)
    return round(total * kept / episodes)


def _q(value) -> str:
    """Shell-quote a CLI value; lists and dicts are passed as JSON."""
    if isinstance(value, (list, dict)):
        value = json.dumps(value, separators=(",", ":"))
    return shlex.quote(str(value))


def estimate(policy: Policy, spec: TrainSpec, gpu: str | None, cost_per_min: float | None) -> dict | None:
    speed = GPU_SPEED.get(gpu or "")
    if speed is None:
        return None
    factor, extrapolated = speed
    lo, hi = (spec.steps * spec.batch_size * s / factor for s in policy.sec_per_sample)
    lo, hi = lo + JOB_OVERHEAD_S[0], hi + JOB_OVERHEAD_S[1]
    return {
        "low_s": round(lo),
        "high_s": round(hi),
        "low_usd": round(lo / 60 * cost_per_min, 2) if cost_per_min else None,
        "high_usd": round(hi / 60 * cost_per_min, 2) if cost_per_min else None,
        "extrapolated": extrapolated,
    }


def plan(
    spec: TrainSpec,
    teleop: DatasetMeta,
    ego: DatasetMeta | None,
    namespace: str,
    timestamp: str,
    flavor_vram_gb: int | None = None,
    flavor_gpu: str | None = None,
    cost_per_min: float | None = None,
) -> Plan:
    issues: list[Issue] = []
    err = lambda m: issues.append(Issue("error", m))  # noqa: E731
    warn = lambda m: issues.append(Issue("warning", m))  # noqa: E731
    info = lambda m: issues.append(Issue("info", m))  # noqa: E731

    policy = POLICIES.get(spec.policy)
    slug = slugify(spec.name)
    model_repo_id = f"{namespace}/{slug}-{timestamp}"
    if policy is None:
        err(f"Unknown policy '{spec.policy}'.")
        return Plan(False, issues, "", model_repo_id, False, {}, 0.0)

    feats = teleop.info["features"]
    for ds in (teleop, ego):
        if ds is not None and ds.repo_id.count("/") > 1:
            err(f"{ds.repo_id} lives in a folder of a Hub repo; lerobot-train needs a dataset at a repo's root.")
    if not str(teleop.info.get("codebase_version", "")).startswith("v3"):
        err(f"{teleop.repo_id} is {teleop.info.get('codebase_version')}; lerobot-train needs a v3.0 dataset "
            "(convert it with lerobot's convert_dataset_v21_to_v30).")

    # Cameras
    if not spec.cameras:
        err("Select at least one camera.")
    for cam in spec.cameras:
        if cam not in feats:
            err(f"Camera {cam} is not in {teleop.repo_id}.")
        elif is_depth(feats[cam]) and not policy.supports_depth:
            err(f"{policy.name} takes RGB images only; deselect the depth stream {cam}.")
    if policy.max_cameras is not None and len(spec.cameras) > policy.max_cameras:
        err(f"{policy.name} accepts at most {policy.max_cameras} cameras ({len(spec.cameras)} selected).")
    unused = [c for c in camera_keys(teleop.info) if c not in spec.cameras]
    camera_map: dict[str, str] = {}
    if policy.camera_slots:
        camera_map = spec.camera_map or default_camera_map(policy, spec.cameras)
        slots = dict(policy.camera_slots)
        for cam in spec.cameras:
            if camera_map.get(cam) not in slots:
                err(f"Choose which {policy.name} input {cam} feeds.")
        taken = [camera_map[c] for c in spec.cameras if c in camera_map]
        if len(taken) != len(set(taken)):
            err("Two cameras feed the same policy input.")

    # State / action
    for key in ("observation.state", "action"):
        if key not in feats:
            err(f"{teleop.repo_id} has no '{key}' feature.")
        elif policy.max_state_dim and feats[key]["shape"][0] > policy.max_state_dim:
            err(f"{policy.name} handles up to {policy.max_state_dim} dims; '{key}' has {feats[key]['shape'][0]}.")

    if policy.uses_language:
        tasks = set(teleop.tasks) | set(ego.tasks if ego else [])
        if not any(t.strip() for t in tasks):
            warn(f"{policy.name} conditions on the task text, but the datasets have no task strings.")
    if spec.policy == "pi05" and not (teleop.has_quantiles and (ego is None or ego.has_quantiles)):
        info("Dataset stats have no quantiles: π0.5 will normalize with mean/std instead.")

    # Co-training
    merged = ego is not None
    frames = {"teleop": _num_frames(teleop)}
    drop_teleop: list[str] = []
    drop_ego: list[str] = []
    if ego is not None:
        efeats = ego.info["features"]
        frames["ego"] = _num_frames(ego, spec.ego_max_episodes)
        if teleop.info.get("fps") != ego.info.get("fps"):
            err(f"fps differ ({teleop.info.get('fps')} vs {ego.info.get('fps')}): datasets can't be merged.")
        if teleop.info.get("robot_type") != ego.info.get("robot_type"):
            err(f"robot_type differ ('{teleop.info.get('robot_type')}' vs '{ego.info.get('robot_type')}'): "
                "record the egocentric dataset with the robot_type of the teleop one.")
        for key in ("observation.state", "action"):
            a, b = feats.get(key), efeats.get(key)
            if a and not b:
                err(f"{ego.repo_id} has no '{key}': human poses must first be retargeted to the robot's "
                    "joints (same names and size as the teleop dataset).")
            if a and b and (a["shape"] != b["shape"] or a.get("names") != b.get("names")):
                err(f"'{key}' differs between datasets (shape {a['shape']} vs {b['shape']}): the "
                    "retargeted human actions must use the robot's joint space.")
        for cam in spec.cameras:
            if cam not in efeats:
                err(f"Camera {cam} is missing from {ego.repo_id}; co-training keeps only cameras both "
                    "datasets have.")
            elif cam in feats and efeats[cam]["shape"] != feats[cam]["shape"]:
                err(f"Camera {cam} has resolution {efeats[cam]['shape']} in {ego.repo_id} but "
                    f"{feats[cam]['shape']} in {teleop.repo_id}.")
        # Merging needs identical feature sets: drop what isn't shared, and unselected cameras.
        shared = (set(feats) & set(efeats)) - set(unused)
        drop_teleop = sorted(set(feats) - shared)
        drop_ego = sorted(set(efeats) - shared)
        if drop_teleop or drop_ego:
            info("Dropped before merging: " + ", ".join(sorted(set(drop_teleop) | set(drop_ego))) + ".")
        total = frames["teleop"] + frames["ego"]
        if total:
            info(f"Human share of training frames: {100 * frames['ego'] / total:.0f}% "
                 "(Ego-Pi used ~50%; cap egocentric episodes to lower it).")

    # Budget
    total_frames = sum(frames.values())
    epochs = spec.steps * spec.batch_size / total_frames if total_frames else 0.0
    if total_frames and epochs < 3:
        warn(f"≈{epochs:.1f} epochs: likely undertrained (imitation learning usually needs 5-10+).")
    if flavor_vram_gb is not None and flavor_vram_gb < policy.min_vram_gb:
        warn(f"{policy.name} needs ~{policy.min_vram_gb} GB of VRAM; {spec.flavor} has {flavor_vram_gb} GB.")

    # Command
    lines = ["set -euo pipefail"]
    excluded = list(teleop.excluded)
    if merged:
        assert ego is not None
        teleop_src, ego_src = teleop.repo_id, ego.repo_id
        teleop_root = ego_root = None
        if drop_teleop:
            teleop_src, teleop_root = f"studio/{slug}-teleop", f"{WORK_DIR}/teleop"
            lines.append(
                f"lerobot-edit-dataset --repo_id={_q(teleop.repo_id)} --new_repo_id={teleop_src} "
                f"--new_root={teleop_root} --operation.type=remove_feature "
                f"--operation.feature_names={_q(drop_teleop)}")
        if drop_ego:
            ego_src, ego_root = f"studio/{slug}-ego", f"{WORK_DIR}/ego"
            lines.append(
                f"lerobot-edit-dataset --repo_id={_q(ego.repo_id)} --new_repo_id={ego_src} "
                f"--new_root={ego_root} --operation.type=remove_feature "
                f"--operation.feature_names={_q(drop_ego)}")
        merge = (f"lerobot-edit-dataset --new_repo_id=studio/{slug}-mix --new_root={WORK_DIR}/mix "
                 f"--operation.type=merge --operation.repo_ids={_q([teleop_src, ego_src])}")
        if teleop_root or ego_root:
            # Unedited inputs come from the Hub; pass their download location explicitly.
            hub_root = lambda rid: f"{WORK_DIR}/hub/{rid}"  # noqa: E731
            roots = [teleop_root or hub_root(teleop.repo_id), ego_root or hub_root(ego.repo_id)]
            for rid, root in ((teleop.repo_id, teleop_root), (ego.repo_id, ego_root)):
                if root is None:
                    lines.append(f"hf download {_q(rid)} --repo-type=dataset --local-dir={hub_root(rid)}")
            merge += f" --operation.roots={_q(roots)}"
        lines.append(merge)
        # The merged dataset keeps teleop episodes first, so ego index j becomes n_teleop + j.
        n_teleop = teleop.info["total_episodes"]
        ego_kept = [i for i in range(ego.info["total_episodes"]) if i not in set(ego.excluded)]
        if spec.ego_max_episodes is not None:
            ego_kept = ego_kept[: spec.ego_max_episodes]
        excluded += [n_teleop + i for i in range(ego.info["total_episodes"]) if i not in set(ego_kept)]
        dataset_args = [f"--dataset.repo_id=studio/{slug}-mix", f"--dataset.root={WORK_DIR}/mix"]
    else:
        dataset_args = [f"--dataset.repo_id={_q(teleop.repo_id)}"]
    if excluded:
        # The released trainer image (lerobot 0.6.1) has --dataset.episodes but not
        # --dataset.exclude_episodes, so pass the episodes to keep.
        total = teleop.info["total_episodes"] + (ego.info["total_episodes"] if merged and ego else 0)
        kept = [i for i in range(total) if i not in set(excluded)]
        dataset_args.append(f"--dataset.episodes={_q(kept)}")

    policy_args = list(policy.base_args)
    # Policies read observation.state (+ environment_state) and images; extra state streams
    # such as velocity or torque would only be dead inputs.
    state = {k: policy_feature(k, feats[k]) for k in ("observation.state", "observation.environment_state")
             if k in feats}
    selected = [c for c in spec.cameras if c in feats]
    if policy.camera_slots:
        rename = {c: camera_map[c] for c in selected if c in camera_map}
        policy_args.append(f"--rename_map={_q(rename)}")
        if policy.slots_from_type:
            # Keep the pretrained view order; views we don't have become masked empty cameras.
            by_slot = {slot: cam for cam, slot in rename.items()}
            images = {slot: policy_feature(cam, feats[cam]) for slot, _ in policy.camera_slots
                      if (cam := by_slot.get(slot))}
            policy_args.append(f"--policy.input_features={_q(state | images)}")
            if len(images) < len(policy.camera_slots):
                policy_args.append(f"--policy.empty_cameras={len(policy.camera_slots) - len(images)}")
    else:
        images = {c: policy_feature(c, feats[c]) for c in selected}
        policy_args.append(f"--policy.input_features={_q(state | images)}")
    if spec.policy == "pi05" and not (teleop.has_quantiles and (ego is None or ego.has_quantiles)):
        policy_args.append("--policy.normalization_mapping="
                           + _q({"ACTION": "MEAN_STD", "STATE": "MEAN_STD", "VISUAL": "IDENTITY"}))

    train = [
        "lerobot-train",
        *dataset_args,
        *policy_args,
        f"--policy.repo_id={model_repo_id}",
        "--policy.push_to_hub=true",
        "--policy.private=true",
        "--policy.device=cuda",
        f"--steps={spec.steps}",
        f"--batch_size={spec.batch_size}",
        f"--log_freq={spec.log_freq}",
        # A checkpoint every quarter, pushed to <model repo>/checkpoints/<step>: a crashed or
        # timed-out run still leaves a usable model.
        f"--save_freq={max(1, spec.steps // 4)}",
        "--save_checkpoint_to_hub=true",
        f"--output_dir={WORK_DIR}/outputs/{slug}",
        f"--job_name={slug}",
        "--wandb.enable=false",
    ]
    lines.append(" \\\n  ".join(train))
    script = "\n".join(lines) + "\n"

    ok = not any(i.level == "error" for i in issues)
    return Plan(ok, issues, script, model_repo_id, merged, frames, round(epochs, 2), camera_map,
                estimate(policy, spec, flavor_gpu, cost_per_min))
