"""Demo only: reshape an EgoDex subset into the teleop dataset's schema so co-training can launch.

The "retargeting" is a placeholder (wrist xyz + rotation + hand openness per arm), not robot
joints, and the single egocentric camera is copied into every camera of the teleop dataset.
Good enough to show the pipeline end to end; a real ego dataset needs proper retargeting.

    uv run python studio/scripts/ego_to_robot.py \
        --ego griffinlabs/EgoDex-LeRobot-v3.0/test/add_remove_lid \
        --teleop antonin-leroy/cocktail-grasp --out lleeoogg/egodex-openarm-demo --episodes 10
"""

import argparse
import json
import shutil
from pathlib import Path

import av
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download, snapshot_download
from PIL import Image
from scipy.spatial.transform import Rotation

from lerobot.configs.video import RGBEncoderConfig
from lerobot.datasets.lerobot_dataset import LeRobotDataset


def split(dataset_id: str) -> tuple[str, str]:
    owner, name, *rest = dataset_id.split("/")
    return f"{owner}/{name}", "/".join(rest)


def arm(poses: dict[str, np.ndarray], side: str, i: int) -> list[float]:
    hand = poses[f"{side}Hand"][i]
    xyz = hand[:3, 3]
    rot = Rotation.from_matrix(hand[:3, :3]).as_euler("xyz")
    elbow = np.linalg.norm(poses[f"{side}Forearm"][i][:3, 3] - xyz)
    grip = np.linalg.norm(poses[f"{side}ThumbTip"][i][:3, 3] - poses[f"{side}IndexFingerTip"][i][:3, 3])
    return [*xyz, *rot, elbow, grip]


def frames(path: Path, start: float, n: int, size: tuple[int, int]):
    """n RGB frames from `start` (seconds into the file), center-cropped to size's aspect ratio."""
    w, h = size
    with av.open(str(path)) as c:
        stream = c.streams.video[0]
        c.seek(int(start / stream.time_base), stream=stream, backward=True)
        out = 0
        for f in c.decode(stream):
            if f.time < start - 1e-3:
                continue
            img = f.to_image()
            cw = min(img.width, img.height * w // h)
            ch = cw * h // w
            left, top = (img.width - cw) // 2, (img.height - ch) // 2
            yield np.asarray(img.crop((left, top, left + cw, top + ch)).resize(size))
            out += 1
            if out == n:
                return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ego", required=True)
    ap.add_argument("--teleop", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--episodes", type=int, default=10)
    ap.add_argument("--root", default="studio/.cache/ego_to_robot")
    args = ap.parse_args()

    teleop = json.loads(Path(hf_hub_download(args.teleop, "meta/info.json", repo_type="dataset")).read_text())
    repo, prefix = split(args.ego)
    src = Path(snapshot_download(repo, repo_type="dataset", allow_patterns=[f"{prefix}/*", f"{prefix}/**"])) / prefix
    info = json.loads((src / "meta/info.json").read_text())
    assert info["fps"] == teleop["fps"], "fps differ"
    ego_cam = next(k for k, v in info["features"].items() if v["dtype"] == "video")

    episodes = pd.concat(pd.read_parquet(p) for p in sorted((src / "meta/episodes").rglob("*.parquet")))
    tasks = pd.read_parquet(src / "meta/tasks.parquet")
    task_of = dict(zip(tasks["task_index"], tasks.index))
    joints = [f"{side}{part}" for side in ("left", "right") for part in ("Hand", "Forearm", "ThumbTip", "IndexFingerTip")]
    cols = ["episode_index", "frame_index", "task_index"] + [f"observation.state.{j}" for j in joints]
    table = pa.concat_tables(pq.read_table(p, columns=cols) for p in sorted((src / "data").rglob("*.parquet")))
    data = {c: np.array(table[c].to_pylist(), np.float32) for c in cols}

    keep = ("index", "timestamp", "task_index", "frame_index", "episode_index")
    features = {k: v for k, v in teleop["features"].items() if k not in keep}
    cameras = [k for k, v in features.items() if v["dtype"] == "video"]
    out_dir = Path(args.root) / args.out
    shutil.rmtree(out_dir, ignore_errors=True)  # rebuilt from scratch each run
    ds = LeRobotDataset.create(
        args.out,
        fps=teleop["fps"],
        features=features,
        root=out_dir,
        robot_type=teleop["robot_type"],
        rgb_encoder=RGBEncoderConfig(vcodec="h264", crf=23, preset="ultrafast"),
    )
    for _, ep in episodes.head(args.episodes).iterrows():
        rows = np.flatnonzero(data["episode_index"] == ep["episode_index"])
        rows = rows[np.argsort(data["frame_index"][rows])]
        poses = {j: data[f"observation.state.{j}"][rows] for j in joints}
        state = np.array([arm(poses, "left", i) + arm(poses, "right", i) for i in range(len(rows))], np.float32)
        action = np.vstack([state[1:], state[-1:]])  # next pose as the command
        video = src / info["video_path"].format(
            video_key=ego_cam,
            chunk_index=ep[f"videos/{ego_cam}/chunk_index"],
            file_index=ep[f"videos/{ego_cam}/file_index"],
        )
        h, w, _ = features[cameras[0]]["shape"]
        task = task_of[int(data["task_index"][rows[0]])]
        for i, img in enumerate(frames(video, ep[f"videos/{ego_cam}/from_timestamp"], len(rows), (w, h))):
            ds.add_frame({"observation.state": state[i], "action": action[i], "task": task}
                         | {cam: img for cam in cameras})
        ds.save_episode()
        print(f"episode {ep['episode_index']}: {len(rows)} frames")
    ds.finalize()
    ds.push_to_hub(private=True)
    print(f"https://huggingface.co/datasets/{args.out}")


if __name__ == "__main__":
    main()
