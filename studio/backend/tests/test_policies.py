import json
import shlex

from app.policies import DatasetMeta, TrainSpec, plan

STATE = {"dtype": "float32", "shape": [16], "names": [f"j{i}" for i in range(16)]}


def video(shape=(480, 640, 3), depth=False):
    info = {"video.codec": "hevc" if depth else "av1", "is_depth_map": depth}
    return {"dtype": "video", "shape": list(shape), "names": ["height", "width", "channels"], "info": info}


def meta(repo, cams, episodes=10, frames=3000, excluded=(), robot="bi_openarm_follower", extra=None):
    features = {"observation.state": STATE, "action": STATE, **cams, **(extra or {})}
    info = {"codebase_version": "v3.0", "robot_type": robot, "fps": 30, "total_episodes": episodes,
            "total_frames": frames, "features": features}
    return DatasetMeta(repo, info, ["pour"], list(excluded))


TELEOP = meta("me/teleop", {"observation.images.front": video(), "observation.images.left_wrist": video(),
                            "observation.images.front_depth": video((480, 640, 1), depth=True)},
              excluded=[2], extra={"observation.torque": STATE})
EGO = meta("me/ego", {"observation.images.front": video()}, episodes=20, frames=6000, excluded=[0])


def spec(**kw):
    base = dict(name="Pour", policy="act", dataset_repo_id="me/teleop", cameras=["observation.images.front"],
                steps=10_000, batch_size=8, flavor="a10g-small")
    return TrainSpec(**(base | kw))


def errors(p):
    return [i.message for i in p.issues if i.level == "error"]


def arg(script, name):
    for tok in shlex.split(script.replace("\\\n", " ")):
        if tok.startswith(f"--{name}="):
            return tok.split("=", 1)[1]
    return None


def test_act_feeds_only_selected_cameras_and_state():
    p = plan(spec(cameras=["observation.images.front"]), TELEOP, None, "me", "t")
    assert p.ok, errors(p)
    feats = json.loads(arg(p.script, "policy.input_features"))
    assert list(feats) == ["observation.state", "observation.images.front"]
    assert feats["observation.images.front"] == {"type": "VISUAL", "shape": [3, 480, 640]}
    assert json.loads(arg(p.script, "dataset.episodes")) == [0, 1, *range(3, 10)]
    assert arg(p.script, "save_freq") == "2500" and arg(p.script, "save_checkpoint_to_hub") == "true"
    assert arg(p.script, "policy.repo_id") == "me/pour-t"


def test_depth_is_rejected():
    p = plan(spec(cameras=["observation.images.front_depth"]), TELEOP, None, "me", "t")
    assert any("RGB images only" in e for e in errors(p))


def test_camera_limit():
    many = meta("me/many", {f"observation.images.c{i}": video() for i in range(4)})
    p = plan(spec(policy="pi05", dataset_repo_id="me/many", cameras=[f"observation.images.c{i}" for i in range(4)]),
             many, None, "me", "t")
    assert any("at most 3 cameras" in e for e in errors(p))


def test_smolvla_renames_onto_pretrained_slots():
    p = plan(spec(policy="smolvla", cameras=["observation.images.left_wrist", "observation.images.front"]),
             TELEOP, None, "me", "t")
    assert p.ok, errors(p)
    assert json.loads(arg(p.script, "rename_map")) == {
        "observation.images.left_wrist": "observation.images.camera1",
        "observation.images.front": "observation.images.camera2",
    }
    assert arg(p.script, "policy.input_features") is None


def test_cotraining_merges_shared_features_and_offsets_exclusions():
    p = plan(spec(ego_repo_id="me/ego", ego_max_episodes=5), TELEOP, EGO, "me", "t")
    assert p.ok, errors(p)
    lines = p.script.splitlines()
    # teleop loses what the ego dataset lacks; ego has nothing extra, so it is downloaded as is
    assert "--operation.type=remove_feature" in lines[1] and "observation.torque" in lines[1]
    assert lines[2].startswith("hf download me/ego")
    assert "--operation.type=merge" in lines[3]
    assert arg(p.script, "dataset.root") == "/tmp/studio/mix"
    # teleop ep 2 excluded; ego eps 1..5 kept (0 excluded, cap 5), offset by the 10 teleop episodes
    assert json.loads(arg(p.script, "dataset.episodes")) == [0, 1, *range(3, 10), *range(11, 16)]
    assert p.frames == {"teleop": 2700, "ego": 1500}


def test_cotraining_rejects_other_robot_and_missing_camera():
    so101 = meta("me/so101", {"observation.images.top": video()}, robot="so_follower")
    p = plan(spec(ego_repo_id="me/so101"), TELEOP, so101, "me", "t")
    msgs = " ".join(errors(p))
    assert "robot_type differ" in msgs
    assert "missing from me/so101" in msgs


def test_pi05_cameras_go_to_their_pretrained_views():
    p = plan(spec(policy="pi05", cameras=["observation.images.left_wrist", "observation.images.front"]),
             TELEOP, None, "me", "t")
    assert p.ok, errors(p)
    assert json.loads(arg(p.script, "rename_map")) == {
        "observation.images.left_wrist": "observation.images.left_wrist_0_rgb",
        "observation.images.front": "observation.images.base_0_rgb",
    }
    # pretrained order (base, left, right); the missing right wrist is a masked empty camera
    assert list(json.loads(arg(p.script, "policy.input_features"))) == [
        "observation.state", "observation.images.base_0_rgb", "observation.images.left_wrist_0_rgb"]
    assert arg(p.script, "policy.empty_cameras") == "1"


def test_duplicate_slot_is_an_error():
    both = {"observation.images.front": "observation.images.base_0_rgb",
            "observation.images.left_wrist": "observation.images.base_0_rgb"}
    p = plan(spec(policy="pi05", cameras=list(both), camera_map=both), TELEOP, None, "me", "t")
    assert any("same policy input" in e for e in errors(p))


def test_subfolder_dataset_cannot_be_trained():
    sub = meta("griffinlabs/EgoDex-LeRobot-v3.0/test/add_remove_lid", {"observation.images.front": video()})
    p = plan(spec(dataset_repo_id=sub.repo_id), sub, None, "me", "t")
    assert any("folder of a Hub repo" in e for e in errors(p))


def test_estimate_matches_the_hardware_guide():
    from app.policies import POLICIES, estimate
    # Guide: ACT, batch 8, 5 epochs over ~45k frames on an A10G -> ~1-2 h (+ job overhead).
    steps = 5 * 45_000 // 8
    e = estimate(POLICIES["act"], spec(steps=steps, batch_size=8), "A10G", 0.025)
    assert 3600 <= e["low_s"] <= 1.2 * 3600 and 2 * 3600 <= e["high_s"] <= 2.2 * 3600
    assert not e["extrapolated"] and e["low_usd"] > 0
    assert estimate(POLICIES["act"], spec(), "Unknown GPU", None) is None
