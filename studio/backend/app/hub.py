"""LeRobot datasets on the Hugging Face Hub: search, import into Postgres, read an episode.

A v3 dataset is meta/info.json + meta/episodes/*.parquet (one row per episode, with the file
and time span of each camera) + data/*.parquet (frames). Files are fetched with
hf_hub_download at the dataset's commit and cached by huggingface_hub.

A dataset id is `owner/repo`, or `owner/repo/sub/folder` when a repo holds several datasets
(e.g. EgoDex, one dataset per task); file paths are relative to that folder.
"""

import json
import time
from functools import lru_cache

import httpx

import numpy as np
import pyarrow.compute as pc
import pyarrow.parquet as pq
from huggingface_hub import HfApi, hf_hub_download, hf_hub_url
from huggingface_hub.hf_api import RepoFolder
from psycopg.types.json import Jsonb

from .db import fetch_one, pool
from .settings import settings

api = HfApi(token=settings.hf_token)


class NotADataset(Exception):
    """The repo has no meta/info.json at this path; `subsets` lists the datasets found below it."""

    def __init__(self, dataset_id: str, subsets: list[str]):
        super().__init__(f"{dataset_id} has no meta/info.json.")
        self.subsets = subsets


def split_id(dataset_id: str) -> tuple[str, str]:
    """`owner/repo/sub/folder` -> (`owner/repo`, `sub/folder/`)."""
    parts = dataset_id.strip("/").split("/")
    prefix = "/".join(parts[2:])
    return "/".join(parts[:2]), f"{prefix}/" if prefix else ""


def download(dataset_id: str, filename: str, revision: str | None = None) -> str:
    repo, prefix = split_id(dataset_id)
    return hf_hub_download(repo, prefix + filename, repo_type="dataset", revision=revision,
                           token=settings.hf_token)


_signed: dict[tuple[str, str, str], tuple[str, float]] = {}


def signed_url(dataset_id: str, filename: str, revision: str) -> str | None:
    """The CDN URL the Hub redirects to (signed, valid ~1 h), cached for 30 min, so the browser
    streams videos straight from the CDN instead of through our API."""
    key = (dataset_id, filename, revision)
    hit = _signed.get(key)
    if hit and time.time() - hit[1] < 1800:
        return hit[0]
    repo, prefix = split_id(dataset_id)
    headers = {"Authorization": f"Bearer {settings.hf_token}"} if settings.hf_token else {}
    try:
        r = httpx.head(hf_hub_url(repo, prefix + filename, repo_type="dataset", revision=revision),
                       headers=headers, follow_redirects=False, timeout=10)
    except httpx.HTTPError:
        return None
    location = r.headers.get("location")
    if r.status_code not in (301, 302, 307) or not location or not location.startswith("https://"):
        return None
    _signed[key] = (location, time.time())
    return location


def _tree(repo: str, path: str, revision: str, recursive: bool = False):
    return api.list_repo_tree(repo, path_in_repo=path or None, repo_type="dataset", revision=revision,
                              recursive=recursive)


def find_subsets(dataset_id: str, revision: str) -> list[str]:
    """Datasets (folders with a meta/ dir) one or two levels below `dataset_id`."""
    repo, prefix = split_id(dataset_id)
    found = []
    for top in _tree(repo, prefix.rstrip("/"), revision):
        if not isinstance(top, RepoFolder):
            continue
        children = [c for c in _tree(repo, top.path, revision) if isinstance(c, RepoFolder)]
        if any(c.path.endswith("/meta") for c in children):
            found.append(top.path)
        else:
            found += [c.path for c in children]  # e.g. train/<task>: checked on import
    return sorted(f"{repo}/{path}" for path in found)


@lru_cache(maxsize=1)
def whoami() -> dict | None:
    if not settings.hf_token:
        return None
    return api.whoami()


def namespace() -> str:
    if settings.hf_namespace:
        return settings.hf_namespace
    me = whoami()
    if me is None:
        return "local"  # fake jobs without a token
    return me["name"]


def search(query: str = "", author: str | None = None, limit: int = 30) -> list[dict]:
    results = api.list_datasets(search=query or None, author=author or None, filter="LeRobot",
                                limit=limit, sort="downloads", full=False)
    return [
        {
            "repo_id": d.id,
            "downloads": d.downloads,
            "likes": d.likes,
            "private": bool(d.private),
            "last_modified": d.last_modified.isoformat() if d.last_modified else None,
        }
        for d in results
    ]


def import_dataset(repo_id: str, kind: str) -> None:
    """Fetch metadata and episode index, then upsert the dataset and its episodes."""
    repo, prefix = split_id(repo_id)
    meta = api.dataset_info(repo, files_metadata=False)
    revision = meta.sha
    if not api.file_exists(repo, f"{prefix}meta/info.json", repo_type="dataset", revision=revision):
        raise NotADataset(repo_id, find_subsets(repo_id, revision))
    info = json.load(open(download(repo_id, "meta/info.json", revision)))
    if not str(info.get("codebase_version", "")).startswith("v3"):
        raise ValueError(f"{repo_id} is {info.get('codebase_version')}; only LeRobotDataset v3 is supported.")

    tasks_table = pq.read_table(download(repo_id, "meta/tasks.parquet", revision))
    task_col = "task" if "task" in tasks_table.column_names else "__index_level_0__"
    tasks = [t for t in tasks_table.column(task_col).to_pylist() if t]

    try:
        stats = json.load(open(download(repo_id, "meta/stats.json", revision)))
        has_quantiles = all("q01" in stats.get(k, {}) for k in ("action", "observation.state"))
    except Exception:
        has_quantiles = False

    # Only list meta/episodes: big repos (EgoDex) have far too many files to list whole.
    episode_files = sorted(f.path.removeprefix(prefix) for f in _tree(repo, f"{prefix}meta/episodes", revision, True)
                           if f.path.endswith(".parquet"))
    rows = []
    for f in episode_files:
        table = pq.read_table(download(repo_id, f, revision))
        cols = [c for c in table.column_names if not c.startswith("stats/")]
        for ep in table.select(cols).to_pylist():
            video = {}
            for col, value in ep.items():
                if col.startswith("videos/"):
                    key, field = col[len("videos/"):].rsplit("/", 1)
                    video.setdefault(key, {})[field] = value
            rows.append((repo_id, ep["episode_index"], ep["length"], ep.get("tasks") or [],
                         ep.get("data/chunk_index"), ep.get("data/file_index"), Jsonb(video)))

    with pool.connection() as conn, conn.transaction():
        conn.execute(
            """
            INSERT INTO datasets (repo_id, kind, info, tasks, private, revision, has_quantiles)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (repo_id) DO UPDATE SET info = EXCLUDED.info, tasks = EXCLUDED.tasks,
                private = EXCLUDED.private, revision = EXCLUDED.revision,
                has_quantiles = EXCLUDED.has_quantiles
            """,
            (repo_id, kind, Jsonb(info), tasks, bool(meta.private), revision, has_quantiles),
        )
        # Keep curation (excluded) across re-syncs; drop episodes that no longer exist.
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO episodes (repo_id, episode_index, length, tasks, data_chunk, data_file, video)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (repo_id, episode_index) DO UPDATE SET length = EXCLUDED.length,
                    tasks = EXCLUDED.tasks, data_chunk = EXCLUDED.data_chunk,
                    data_file = EXCLUDED.data_file, video = EXCLUDED.video
                """,
                rows,
            )
        conn.execute("DELETE FROM episodes WHERE repo_id = %s AND episode_index >= %s",
                     (repo_id, info["total_episodes"]))


def episode_signals(repo_id: str, episode_index: int) -> dict:
    """Numeric streams of one episode with their names. Vectors (state, action, ...) come as
    is; 4x4 poses (e.g. EgoDex hand joints) are reduced to their x/y/z translation."""
    row = fetch_one(
        """SELECT d.info, d.revision, e.data_chunk, e.data_file, e.length
           FROM episodes e JOIN datasets d USING (repo_id)
           WHERE e.repo_id = %s AND e.episode_index = %s""",
        (repo_id, episode_index),
    )
    if row is None:
        raise KeyError(episode_index)
    info = row["info"]
    path = info["data_path"].format(chunk_index=row["data_chunk"], file_index=row["data_file"])
    floats = {k: f for k, f in info["features"].items()
              if f["dtype"] in ("float32", "float64") and k != "timestamp" and k.startswith(("observation.", "action"))}
    vectors = [k for k, f in floats.items() if len(f["shape"]) == 1]
    poses = [k for k, f in floats.items() if list(f["shape"]) == [4, 4]]
    table = pq.read_table(download(repo_id, path, row["revision"]),
                          columns=["timestamp", "episode_index", *vectors, *poses],
                          filters=[("episode_index", "=", episode_index)])
    table = table.sort_by("timestamp")
    series = {}
    for key in vectors:
        values = np.asarray(table.column(key).to_pylist(), dtype=np.float32)
        names = info["features"][key].get("names")
        if isinstance(names, dict):  # older layout: {"motors": [...]}
            names = next(iter(names.values()), None)
        if not isinstance(names, list) or len(names) != values.shape[-1]:
            names = [f"{key}[{i}]" for i in range(values.shape[-1])]
        series[key] = {"kind": "vector", "names": names, "values": np.round(values, 5).T.tolist()}
    for key in poses:
        xyz = np.asarray(table.column(key).to_pylist(), dtype=np.float32)[:, :3, 3]
        series[key] = {"kind": "pose", "names": ["x", "y", "z"], "values": np.round(xyz, 4).T.tolist()}
    return {
        "timestamps": pc.round(table.column("timestamp"), 4).to_pylist(),
        "series": series,
    }


# Hand skeleton of datasets that track joints as 4x4 world poses (EgoDex / ARKit naming).
FINGERS = {
    "thumb": ["ThumbKnuckle", "ThumbIntermediateBase", "ThumbIntermediateTip", "ThumbTip"],
    "index": ["IndexFingerMetacarpal", "IndexFingerKnuckle", "IndexFingerIntermediateBase",
              "IndexFingerIntermediateTip", "IndexFingerTip"],
    "middle": ["MiddleFingerMetacarpal", "MiddleFingerKnuckle", "MiddleFingerIntermediateBase",
               "MiddleFingerIntermediateTip", "MiddleFingerTip"],
    "ring": ["RingFingerMetacarpal", "RingFingerKnuckle", "RingFingerIntermediateBase",
             "RingFingerIntermediateTip", "RingFingerTip"],
    "little": ["LittleFingerMetacarpal", "LittleFingerKnuckle", "LittleFingerIntermediateBase",
               "LittleFingerIntermediateTip", "LittleFingerTip"],
}


def _skeleton(available: set[str]) -> tuple[list[str], list[tuple[int, int, str]]]:
    """Joint names and (from, to, group) edges: arm, palm and one chain per finger, per side."""
    joints: list[str] = []
    edges: list[tuple[int, int, str]] = []

    def idx(name: str) -> int | None:
        if name not in available:
            return None
        if name not in joints:
            joints.append(name)
        return joints.index(name)

    def chain(names: list[str], group: str) -> None:
        for a, b in zip(names, names[1:]):
            i, j = idx(a), idx(b)
            if i is not None and j is not None:
                edges.append((i, j, group))

    for side in ("left", "right"):
        chain([f"{side}Shoulder", f"{side}Arm", f"{side}Forearm", f"{side}Hand"], "arm")
        for finger, names in FINGERS.items():
            chain([f"{side}Hand", *[side + n for n in names]], finger)
        chain([f"{side}{f}FingerKnuckle" for f in ("Index", "Middle", "Ring", "Little")], "palm")
    return joints, edges


def episode_keypoints(repo_id: str, episode_index: int) -> dict:
    """Arm and hand joints projected into the camera image, per frame, normalized to [0, 1].

    Needs the camera's world pose (observation.state.camera, OpenCV axes: x right, y down,
    z forward) and its intrinsics (camera_intrinsics, 3x3), as EgoDex provides."""
    row = fetch_one(
        """SELECT d.info, d.revision, e.data_chunk, e.data_file
           FROM episodes e JOIN datasets d USING (repo_id)
           WHERE e.repo_id = %s AND e.episode_index = %s""",
        (repo_id, episode_index),
    )
    if row is None:
        raise KeyError(episode_index)
    info = row["info"]
    feats = info["features"]
    images = [k for k, f in feats.items() if f["dtype"] == "video"]
    if "observation.state.camera" not in feats or "camera_intrinsics" not in feats or not images:
        return {"available": False}
    available = {k.removeprefix("observation.state.") for k, f in feats.items() if list(f["shape"]) == [4, 4]}
    joints, edges = _skeleton(available)
    if not edges:
        return {"available": False}

    path = info["data_path"].format(chunk_index=row["data_chunk"], file_index=row["data_file"])
    cols = ["frame_index", "episode_index", "camera_intrinsics", "observation.state.camera",
            *[f"observation.state.{j}" for j in joints]]
    table = pq.read_table(download(repo_id, path, row["revision"]), columns=cols,
                          filters=[("episode_index", "=", episode_index)]).sort_by("frame_index")
    K = np.asarray(table.column("camera_intrinsics").to_pylist(), dtype=np.float64)          # (T, 3, 3)
    world_to_cam = np.linalg.inv(np.asarray(table.column("observation.state.camera").to_pylist()))  # (T, 4, 4)
    points = np.stack([np.asarray(table.column(f"observation.state.{j}").to_pylist())[:, :, 3]
                       for j in joints], axis=1)                                             # (T, J, 4)
    cam = np.einsum("tij,tkj->tki", world_to_cam, points)[..., :3]                           # (T, J, 3)
    h, w = feats[images[0]]["shape"][:2]
    z = cam[..., 2]
    u = (K[:, None, 0, 0] * cam[..., 0] / z + K[:, None, 0, 2]) / w
    v = (K[:, None, 1, 1] * cam[..., 1] / z + K[:, None, 1, 2]) / h
    uv = np.round(np.stack([u, v], axis=-1), 4)
    frames = [[None if z[t, j] <= 0 else uv[t, j].tolist() for j in range(len(joints))] for t in range(len(z))]
    return {"available": True, "camera": images[0], "joints": joints, "edges": edges, "frames": frames}
