"""Camera streams of an episode, playable in the browser.

v3 videos hold many episodes per mp4; an episode is a [from_timestamp, to_timestamp] span.
RGB in a browser codec (AV1/H.264/VP9, yuv420p) up to 1280 px wide streams from the Hub as is.
Anything else - 12-bit HEVC depth, PNG frames, other codecs, and big videos (e.g. 1080p AV1,
which stutters where AV1 isn't hardware-decoded) - gets a preview: the episode re-encoded to
640 px H.264 (depth through a turbo colormap), stored in S3, built by the worker from the
`previews` queue.
"""

import io
import math
import tempfile
from collections.abc import Iterator

import av
import numpy as np
import pyarrow.parquet as pq
from PIL import Image

from .db import fetch_one, pool
from .hub import download, signed_url
from .policies import BROWSER_SAFE_CODECS, is_depth
from .settings import settings
from .storage import s3

PREVIEW_MAX_WIDTH = 640
DIRECT_MAX_WIDTH = 1280  # wider videos are served as previews


def _playable(feature: dict) -> bool:
    i = feature.get("info") or {}
    return (feature["dtype"] == "video" and i.get("video.codec") in BROWSER_SAFE_CODECS
            and i.get("video.pix_fmt", "yuv420p") == "yuv420p" and feature["shape"][1] <= DIRECT_MAX_WIDTH)


def episode_streams(repo_id: str, episode_index: int) -> list[dict]:
    row = fetch_one(
        """SELECT d.info, d.revision, e.video, e.length FROM episodes e JOIN datasets d USING (repo_id)
           WHERE e.repo_id = %s AND e.episode_index = %s""",
        (repo_id, episode_index),
    )
    if row is None:
        raise KeyError(episode_index)
    info, fps = row["info"], row["info"]["fps"]
    streams = []
    for key, feature in info["features"].items():
        if feature["dtype"] not in ("video", "image", "depth"):
            continue
        stream = {
            "key": key,
            "label": key.removeprefix("observation.images."),
            "shape": feature["shape"],
            "depth": is_depth(feature),
            "codec": (feature.get("info") or {}).get("video.codec"),
        }
        span = row["video"].get(key)
        if _playable(feature) and span:
            path = info["video_path"].format(video_key=key, chunk_index=span["chunk_index"],
                                             file_index=span["file_index"])
            stream |= {"mode": "direct", "status": "ready", "from_ts": span["from_timestamp"],
                       "to_ts": span["to_timestamp"],
                       # Straight from the Hub's CDN; our proxy is the fallback.
                       "url": signed_url(repo_id, path, row["revision"])
                       or f"/api/media/hf?repo={repo_id}&file={path}&rev={row['revision']}"}
        else:
            with pool.connection() as conn:
                p = conn.execute(
                    """INSERT INTO previews (repo_id, episode_index, camera) VALUES (%s, %s, %s)
                       ON CONFLICT (repo_id, episode_index, camera) DO UPDATE SET camera = EXCLUDED.camera
                       RETURNING id, status, error, s3_key""",
                    (repo_id, episode_index, key),
                ).fetchone()
                # Queue the next episode too, so it is ready when the user moves on.
                conn.execute(
                    """INSERT INTO previews (repo_id, episode_index, camera)
                       SELECT repo_id, episode_index, %s FROM episodes WHERE repo_id = %s AND episode_index = %s
                       ON CONFLICT DO NOTHING""",
                    (key, repo_id, episode_index + 1),
                )
            stream |= {"mode": "preview", "status": p["status"], "error": p["error"], "preview_id": p["id"],
                       "from_ts": 0.0,
                       "to_ts": row["length"] / fps,
                       # Straight from S3: keeps the video off the API's (and browser's per-host) connections.
                       "url": preview_url(p["s3_key"]) if p["status"] == "ready" else None}
        streams.append(stream)
    return streams


def turbo(x: np.ndarray) -> np.ndarray:
    """Google's turbo colormap (polynomial fit), x in [0, 1] -> uint8 RGB."""
    r = 0.13572138 + x * (4.61539260 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))))
    g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))))
    b = 0.10667330 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))))
    return (np.clip(np.stack([r, g, b], -1), 0, 1) * 255).astype(np.uint8)


class DepthColorizer:
    """Near = red, far = blue, invalid (0) = black. The range comes from the first frames."""

    def __init__(self, sample: list[np.ndarray]):
        valid = np.concatenate([f[f > 0].ravel()[::7] for f in sample]) if sample else np.array([])
        self.lo, self.hi = (np.percentile(valid, [2, 98]) if valid.size else (0, 1))
        self.hi = max(self.hi, self.lo + 1)

    def __call__(self, depth: np.ndarray) -> np.ndarray:
        t = np.clip((depth.astype(np.float32) - self.lo) / (self.hi - self.lo), 0, 1)
        rgb = turbo(1 - t)
        rgb[depth == 0] = 0
        return rgb


def _video_frames(path: str, start: float, end: float, depth: bool) -> Iterator[np.ndarray]:
    with av.open(path) as container:
        stream = container.streams.video[0]
        container.seek(int(start / stream.time_base), stream=stream, backward=True)
        half_frame = 0.5 / float(stream.average_rate or 30)
        for frame in container.decode(stream):
            if frame.time is None or frame.time < start - half_frame:
                continue
            if frame.time >= end - half_frame:
                break
            if depth:
                arr = frame.to_ndarray(format=frame.format.name) if frame.format.name.startswith("gray") \
                    else frame.to_ndarray(format="gray")
                yield arr[..., 0] if arr.ndim == 3 else arr
            else:
                # Scale with FFmpeg's filter (a stride would alias); even sizes for yuv420p.
                scale = min(1.0, PREVIEW_MAX_WIDTH / frame.width)
                yield frame.reformat(width=int(frame.width * scale) // 2 * 2,
                                     height=int(frame.height * scale) // 2 * 2, format="rgb24").to_ndarray()


def _image_frames(repo_id: str, revision: str, info: dict, ep: dict, key: str) -> Iterator[np.ndarray]:
    path = info["data_path"].format(chunk_index=ep["data_chunk"], file_index=ep["data_file"])
    table = pq.read_table(download(repo_id, path, revision), columns=["frame_index", "episode_index", key],
                          filters=[("episode_index", "=", ep["episode_index"])]).sort_by("frame_index")
    for cell in table.column(key).to_pylist():
        if cell.get("bytes"):
            img = Image.open(io.BytesIO(cell["bytes"]))
        else:
            img = Image.open(download(repo_id, cell["path"], revision))
        arr = np.asarray(img)
        yield arr[..., 0] if arr.ndim == 3 and arr.shape[-1] == 1 else arr


def build_preview(preview_id: int) -> str:
    """Encode one episode/camera to H.264 and upload it; returns the S3 key."""
    p = fetch_one(
        """SELECT p.*, d.info, d.revision, e.video, e.data_chunk, e.data_file, e.length
           FROM previews p JOIN datasets d USING (repo_id)
           JOIN episodes e ON e.repo_id = p.repo_id AND e.episode_index = p.episode_index
           WHERE p.id = %s""",
        (preview_id,),
    )
    info, key = p["info"], p["camera"]
    feature = info["features"][key]
    depth = is_depth(feature)
    fps = info["fps"]
    if feature["dtype"] == "video":
        span = p["video"][key]
        path = info["video_path"].format(video_key=key, chunk_index=span["chunk_index"], file_index=span["file_index"])
        frames = _video_frames(download(p["repo_id"], path, p["revision"]),
                               span["from_timestamp"], span["to_timestamp"], depth)
    else:
        frames = _image_frames(p["repo_id"], p["revision"], info, p, key)

    first = []
    for frame in frames:
        first.append(frame)
        if len(first) == 15:
            break
    if not first:
        raise RuntimeError("No frames decoded for this episode.")
    colorize = DepthColorizer(first) if depth else None

    h, w = first[0].shape[:2]
    stride = math.ceil(w / PREVIEW_MAX_WIDTH)
    out_h, out_w = (math.ceil(h / stride) // 2) * 2, (math.ceil(w / stride) // 2) * 2

    def rgb(frame: np.ndarray) -> np.ndarray:
        frame = frame[::stride, ::stride][:out_h, :out_w]
        if colorize is not None:
            return colorize(frame)
        return frame if frame.ndim == 3 else np.repeat(frame[..., None], 3, -1)

    with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
        with av.open(tmp.name, "w", options={"movflags": "+faststart"}) as out:
            stream = out.add_stream("libx264", rate=round(fps))
            stream.width, stream.height, stream.pix_fmt = out_w, out_h, "yuv420p"
            stream.options = {"crf": "23", "preset": "veryfast"}
            for frame in [*first, *frames]:
                for packet in stream.encode(av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb(frame)), format="rgb24")):
                    out.mux(packet)
            for packet in stream.encode():
                out.mux(packet)
        s3_key = f"previews/{p['repo_id']}/{p['revision']}/{key}/episode_{p['episode_index']:06d}.mp4"
        s3.upload_file(tmp.name, settings.s3_bucket, s3_key, ExtraArgs={"ContentType": "video/mp4"})
    return s3_key


def preview_url(s3_key: str) -> str:
    return s3.generate_presigned_url("get_object", Params={"Bucket": settings.s3_bucket, "Key": s3_key},
                                     ExpiresIn=3600)
