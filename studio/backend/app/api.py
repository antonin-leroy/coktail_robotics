"""HTTP API for the Skill Studio web app: `uv run uvicorn app.api:app --reload --port 8000`."""

import asyncio
import threading
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from functools import lru_cache

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse, StreamingResponse
from huggingface_hub import auth_check, hf_hub_url, list_jobs_hardware
from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError
from psycopg.types.json import Jsonb
from pydantic import BaseModel
from starlette.background import BackgroundTask

from . import hub, media
from .db import execute, fetch_all, fetch_one, migrate, pool
from .jobs import backend
from .policies import POLICIES, DatasetMeta, Issue, TrainSpec, plan
from .settings import settings
from .storage import ensure_bucket


class Broadcaster:
    """One LISTEN connection, fanned out to every open SSE stream."""

    def __init__(self):
        self.queues: set[asyncio.Queue] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        threading.Thread(target=self._listen, daemon=True, name="pg-listen").start()

    def _listen(self) -> None:
        while True:
            try:
                with psycopg.connect(settings.database_url, autocommit=True) as conn:
                    conn.execute("LISTEN studio")
                    for note in conn.notifies():
                        for q in list(self.queues):
                            self.loop.call_soon_threadsafe(q.put_nowait, note.payload)
            except psycopg.OperationalError:
                time.sleep(2)


broadcaster = Broadcaster()
http = httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=120))


@asynccontextmanager
async def lifespan(_: FastAPI):
    pool.open()
    migrate()
    ensure_bucket()
    broadcaster.start(asyncio.get_running_loop())
    yield
    await http.aclose()
    pool.close()


app = FastAPI(title="Skill Studio", lifespan=lifespan)


# --- Account, hardware, policies ---------------------------------------------------------

@app.get("/api/me")
def me():
    user = None
    if settings.hf_token:
        try:
            u = hub.whoami()
            user = {"name": u["name"], "fullname": u.get("fullname"), "avatar_url": u.get("avatarUrl"),
                    "orgs": [o["name"] for o in u.get("orgs", [])]}
        except Exception:
            user = None
    return {"user": user, "token": bool(settings.hf_token), "fake_jobs": settings.studio_fake_jobs,
            "namespace": hub.namespace() if (user or settings.studio_fake_jobs) else None}


@lru_cache(maxsize=1)
def _hardware(_hour: int) -> list[dict]:
    out = []
    for h in list_jobs_hardware(token=settings.hf_token):
        acc = h.accelerator
        # lerobot-train runs as one process: multi-GPU flavors would bill idle GPUs.
        if acc is None or acc.type != "gpu" or str(acc.quantity) != "1":
            continue
        out.append({
            "name": h.name, "label": h.pretty_name, "gpu": acc.model,
            "vram_gb": int(str(acc.vram).split()[0]), "cost_per_min": h.unit_cost_usd,
            "cost_per_hour": round(h.unit_cost_usd * 60, 2),
        })
    return sorted(out, key=lambda f: f["cost_per_min"])


def hardware() -> list[dict]:
    return _hardware(int(time.time() // 3600))


@app.get("/api/flavors")
def flavors():
    return hardware()


@app.get("/api/policies")
def policies():
    return [
        {"id": p.id, "name": p.name, "summary": p.summary, "max_cameras": p.max_cameras,
         "supports_depth": p.supports_depth, "uses_language": p.uses_language, "min_vram_gb": p.min_vram_gb,
         "default_steps": p.default_steps, "default_batch_size": p.default_batch_size,
         "default_flavor": p.default_flavor,
         "camera_slots": [{"key": k, "label": label} for k, label in p.camera_slots]}
        for p in POLICIES.values()
    ]


# --- Datasets ----------------------------------------------------------------------------

DATASET_SELECT = """
SELECT d.repo_id, d.kind, d.total_episodes, d.total_frames, d.fps, d.robot_type, d.codebase, d.tasks,
       d.private, d.revision, d.updated_at,
       (SELECT count(*) FROM episodes e WHERE e.repo_id = d.repo_id AND e.excluded) AS excluded_episodes,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('key', c.key, 'dtype', c.dtype, 'shape', c.shape,
                                  'depth', c.is_depth, 'codec', c.codec, 'pix_fmt', c.pix_fmt) ORDER BY c.key)
                 FROM dataset_cameras c WHERE c.repo_id = d.repo_id), '[]') AS cameras
FROM datasets d
"""


class ImportRequest(BaseModel):
    repo_id: str
    kind: str = "teleop"


class DatasetPatch(BaseModel):
    kind: str


class EpisodePatch(BaseModel):
    excluded: bool


@app.get("/api/hub/datasets")
def hub_search(q: str = "", author: str | None = None):
    imported = {r["repo_id"] for r in fetch_all("SELECT repo_id FROM datasets")}
    return [d | {"imported": d["repo_id"] in imported} for d in hub.search(q, author)]


@app.get("/api/datasets")
def list_datasets():
    return fetch_all(DATASET_SELECT + " ORDER BY d.updated_at DESC")


@app.post("/api/datasets")
def import_dataset(req: ImportRequest):
    try:
        hub.import_dataset(req.repo_id, req.kind)
    except hub.NotADataset as e:
        # A repo of several datasets: let the client pick one.
        raise HTTPException(409, {"message": str(e), "subsets": e.subsets})
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception as e:
        raise HTTPException(502, f"Could not read {req.repo_id} from the Hub: {e}")
    return get_dataset(req.repo_id)


# Dataset ids may contain more than one slash (owner/repo/sub/folder), so they are `path`
# parameters; routes with a suffix are declared before the bare /api/datasets/{id} ones.

@app.get("/api/datasets/{dataset_id:path}/episodes")
def list_episodes(dataset_id: str):
    return fetch_all(
        """SELECT e.episode_index, e.length, e.tasks, e.excluded, round((e.length / d.fps)::numeric, 1) AS duration_s
           FROM episodes e JOIN datasets d USING (repo_id) WHERE e.repo_id = %s ORDER BY e.episode_index""",
        (dataset_id,),
    )


@app.patch("/api/datasets/{dataset_id:path}/episodes/{index}")
def patch_episode(dataset_id: str, index: int, patch: EpisodePatch):
    execute("UPDATE episodes SET excluded = %s WHERE repo_id = %s AND episode_index = %s",
            (patch.excluded, dataset_id, index))
    return {"ok": True}


@app.get("/api/datasets/{dataset_id:path}/episodes/{index}/signals")
def episode_signals(dataset_id: str, index: int):
    try:
        return hub.episode_signals(dataset_id, index)
    except KeyError:
        raise HTTPException(404)


@app.get("/api/datasets/{dataset_id:path}/episodes/{index}/streams")
def episode_streams(dataset_id: str, index: int):
    try:
        return media.episode_streams(dataset_id, index)
    except KeyError:
        raise HTTPException(404)


@app.get("/api/datasets/{dataset_id:path}/episodes/{index}/keypoints")
def episode_keypoints(dataset_id: str, index: int):
    try:
        return hub.episode_keypoints(dataset_id, index)
    except KeyError:
        raise HTTPException(404)


@app.post("/api/datasets/{dataset_id:path}/sync")
def sync_dataset(dataset_id: str):
    row = fetch_one("SELECT kind FROM datasets WHERE repo_id = %s", (dataset_id,))
    if row is None:
        raise HTTPException(404)
    return import_dataset(ImportRequest(repo_id=dataset_id, kind=row["kind"]))


@app.get("/api/datasets/{dataset_id:path}")
def get_dataset(dataset_id: str):
    row = fetch_one(DATASET_SELECT + " WHERE d.repo_id = %s", (dataset_id,))
    if row is None:
        raise HTTPException(404, f"{dataset_id} is not imported.")
    info = fetch_one("SELECT info FROM datasets WHERE repo_id = %s", (dataset_id,))["info"]
    row["features"] = [
        {"key": k, "dtype": f["dtype"], "shape": f["shape"],
         "names": f.get("names") if isinstance(f.get("names"), list) else None}
        for k, f in info["features"].items() if f["dtype"] not in ("video", "image", "depth")
    ]
    return row


@app.patch("/api/datasets/{dataset_id:path}")
def patch_dataset(dataset_id: str, patch: DatasetPatch):
    execute("UPDATE datasets SET kind = %s WHERE repo_id = %s", (patch.kind, dataset_id))
    return get_dataset(dataset_id)


@app.delete("/api/datasets/{dataset_id:path}")
def delete_dataset(dataset_id: str):
    if fetch_one("SELECT 1 FROM training_runs WHERE dataset_repo_id = %s OR ego_repo_id = %s LIMIT 1",
                 (dataset_id, dataset_id)):
        raise HTTPException(409, "Training runs use this dataset; delete them first.")
    execute("DELETE FROM datasets WHERE repo_id = %s", (dataset_id,))
    return {"ok": True}


# --- Media -------------------------------------------------------------------------------

@app.get("/api/media/hf")
async def hf_video(repo: str, file: str, rev: str, request: Request):
    """Range-aware proxy to a dataset video on the Hub (adds the token for private datasets)."""
    if not file.startswith("videos/") or fetch_one("SELECT 1 FROM datasets WHERE repo_id = %s", (repo,)) is None:
        raise HTTPException(404)
    headers = {"Authorization": f"Bearer {settings.hf_token}"} if settings.hf_token else {}
    if r := request.headers.get("range"):
        headers["Range"] = r
    hub_repo, prefix = hub.split_id(repo)
    url = hf_hub_url(hub_repo, prefix + file, repo_type="dataset", revision=rev)
    resp = await http.send(http.build_request("GET", url, headers=headers), stream=True)
    passthrough = {k: v for k in ("content-length", "content-range", "accept-ranges", "etag", "last-modified")
                   if (v := resp.headers.get(k))}
    passthrough["content-type"] = "video/mp4"
    passthrough["cache-control"] = "private, max-age=86400"
    return StreamingResponse(resp.aiter_raw(), status_code=resp.status_code, headers=passthrough,
                             background=BackgroundTask(resp.aclose))


@app.get("/api/media/previews/{preview_id}")
def preview(preview_id: int):
    row = fetch_one("SELECT s3_key FROM previews WHERE id = %s AND status = 'ready'", (preview_id,))
    if row is None:
        raise HTTPException(404)
    return RedirectResponse(media.preview_url(row["s3_key"]), status_code=307)


@app.post("/api/media/previews/{preview_id}/retry")
def retry_preview(preview_id: int):
    execute("UPDATE previews SET status = 'pending', error = NULL WHERE id = %s AND status = 'failed'",
            (preview_id,))
    return {"ok": True}


# --- Training ----------------------------------------------------------------------------

def _dataset_meta(repo_id: str) -> DatasetMeta:
    row = fetch_one(
        """SELECT d.info, d.tasks, d.has_quantiles,
                  ARRAY(SELECT episode_index FROM episodes e WHERE e.repo_id = d.repo_id AND e.excluded
                        ORDER BY episode_index) AS excluded
           FROM datasets d WHERE d.repo_id = %s""",
        (repo_id,),
    )
    if row is None:
        raise HTTPException(404, f"{repo_id} is not imported.")
    return DatasetMeta(repo_id, row["info"], row["tasks"], row["excluded"], row["has_quantiles"])


@lru_cache(maxsize=64)
def _access(repo_id: str, _minute: int) -> str | None:
    """None if the token can download `repo_id`, else why not (cached a minute)."""
    try:
        auth_check(repo_id, token=settings.hf_token)
        return None
    except GatedRepoError as e:
        last = str(e).strip().splitlines()[-1]
        return last if "awaiting" in last else "access not granted yet"
    except RepositoryNotFoundError:
        return "not found, or private without access"
    except Exception:
        return None  # don't block a launch on a Hub hiccup


def _plan(spec: TrainSpec):
    teleop = _dataset_meta(spec.dataset_repo_id)
    ego = _dataset_meta(spec.ego_repo_id) if spec.ego_repo_id else None
    flavor = next((f for f in hardware() if f["name"] == spec.flavor), None)
    ns = hub.namespace() if (settings.hf_token or settings.studio_fake_jobs) else "<your-hf-user>"
    p = plan(spec, teleop, ego, ns, datetime.now(UTC).strftime("%Y%m%d-%H%M%S"),
             flavor["vram_gb"] if flavor else None, flavor["gpu"] if flavor else None,
             flavor["cost_per_min"] if flavor else None)
    policy = POLICIES.get(spec.policy)
    if policy and settings.hf_token:
        for repo in policy.required_repos:
            if reason := _access(repo, int(time.time() // 60)):
                p.issues.insert(0, Issue("error", f"Your HF token can't download {repo} ({reason}). "
                                                  f"Request access at https://huggingface.co/{repo}."))
                p.ok = False
    return p, flavor, teleop


@app.post("/api/training/plan")
def training_plan(spec: TrainSpec):
    p, flavor, _ = _plan(spec)
    out = p.to_dict()
    if flavor:
        out["cost_per_min"] = flavor["cost_per_min"]
    return out


@app.post("/api/training/runs", status_code=201)
def create_run(spec: TrainSpec):
    if not settings.hf_token and not settings.studio_fake_jobs:
        raise HTTPException(400, "Set HF_TOKEN in studio/.env (or STUDIO_FAKE_JOBS=1) to launch training.")
    p, flavor, teleop = _plan(spec)
    if not p.ok:
        raise HTTPException(422, [i.message for i in p.issues if i.level == "error"])
    stored = spec.model_dump() | {"script": p.script, "task": next(iter(teleop.tasks), ""),
                                  "camera_map": p.camera_map,
                                  "frames": p.frames, "epochs": p.epochs}
    row = fetch_one(
        """INSERT INTO training_runs (name, policy, dataset_repo_id, ego_repo_id, spec, command, flavor,
                                      cost_per_min, total_steps, model_repo_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
        (spec.name, spec.policy, spec.dataset_repo_id, spec.ego_repo_id, Jsonb(stored),
         ["bash", "-c", p.script], spec.flavor, flavor["cost_per_min"] if flavor else None,
         spec.steps, p.model_repo_id),
    )
    return {"id": row["id"]}


@app.post("/api/training/runs/{run_id}/rerun", status_code=201)
def rerun(run_id: str):
    """Launch the same request again. It is planned afresh (current dataset curation, current
    command format) and gets its own model repo."""
    row = fetch_one("SELECT spec, status FROM training_runs WHERE id = %s", (run_id,))
    if row is None:
        raise HTTPException(404)
    if row["status"] in ("queued", "submitting", "running"):
        raise HTTPException(409, "This run is still active.")
    spec = TrainSpec(**{k: v for k, v in row["spec"].items() if k in TrainSpec.model_fields})
    return create_run(spec)


RUN_LIST = """
SELECT r.id, r.name, r.status, r.policy, r.dataset_repo_id, r.ego_repo_id, r.flavor, r.total_steps,
       r.last_step, r.model_repo_id, r.hf_job_id, r.hf_job_url, r.error, r.created_at, r.started_at,
       r.finished_at, r.duration_s, r.cost_usd, r.min_loss, r.last_values, r.skill_id,
       r.spec -> 'cameras' AS cameras,
       COALESCE((SELECT array_agg(v ORDER BY b) FROM (
           SELECT b, avg(v) AS v FROM (
               SELECT ntile(32) OVER (ORDER BY step) AS b, (m.values ->> 'loss')::float8 AS v
               FROM training_metrics m WHERE m.run_id = r.id) x GROUP BY b) y), '{}') AS loss_spark
FROM run_overview r
"""


@app.get("/api/training/runs")
def list_runs(status: str | None = None):
    if status:
        return fetch_all(RUN_LIST + " WHERE r.status = %s::run_status ORDER BY r.created_at DESC", (status,))
    return fetch_all(RUN_LIST + " ORDER BY r.created_at DESC")


@app.get("/api/training/runs/{run_id}")
def get_run(run_id: str):
    row = fetch_one(RUN_LIST.replace("FROM run_overview r", ", r.spec, r.command FROM run_overview r")
                    + " WHERE r.id = %s", (run_id,))
    if row is None:
        raise HTTPException(404)
    return row


@app.get("/api/training/runs/{run_id}/metrics")
def run_metrics(run_id: str, smoothing: int = 0, points: int = 300):
    """Every metric, bucketed to `points` per series, with a trailing moving average of
    `smoothing` logged steps - both done by Postgres window functions."""
    rows = fetch_all(
        """
        WITH m AS (
            SELECT step, kv.key AS name, (kv.value #>> '{}')::float8 AS v
            FROM training_metrics, jsonb_each(values) AS kv
            WHERE run_id = %(id)s AND jsonb_typeof(kv.value) = 'number'
        ), s AS (
            SELECT name, step, v,
                   avg(v) OVER (PARTITION BY name ORDER BY step
                                ROWS BETWEEN %(win)s PRECEDING AND CURRENT ROW) AS smooth,
                   ntile(%(points)s) OVER (PARTITION BY name ORDER BY step) AS bucket
            FROM m
        )
        SELECT name, max(step) AS step, avg(v) AS value, avg(smooth) AS smooth
        FROM s GROUP BY name, bucket ORDER BY name, step
        """,
        {"id": run_id, "win": max(smoothing, 0), "points": max(min(points, 2000), 10)},
    )
    series: dict[str, list] = {}
    for r in rows:
        series.setdefault(r["name"], []).append({"step": r["step"], "value": r["value"], "smooth": r["smooth"]})
    system = fetch_all(
        """SELECT extract(epoch FROM recorded_at - (SELECT started_at FROM training_runs WHERE id = %(id)s))::int AS t,
                  values FROM system_metrics WHERE run_id = %(id)s ORDER BY recorded_at""",
        {"id": run_id},
    )
    return {"series": series, "system": [{"t": s["t"], **s["values"]} for s in system]}


@app.get("/api/training/runs/{run_id}/logs")
def run_logs(run_id: str, tail: int = 400):
    rows = fetch_all("SELECT seq, line FROM training_logs WHERE run_id = %s ORDER BY seq DESC LIMIT %s",
                     (run_id, tail))
    return rows[::-1]


@app.post("/api/training/runs/{run_id}/cancel")
def cancel_run(run_id: str):
    run = fetch_one("SELECT * FROM training_runs WHERE id = %s", (run_id,))
    if run is None:
        raise HTTPException(404)
    if run["status"] not in ("queued", "submitting", "running"):
        raise HTTPException(409, f"Run is {run['status']}.")
    if run["hf_job_id"]:
        backend.cancel(run)
    execute("UPDATE training_runs SET status = 'canceled', finished_at = now() WHERE id = %s", (run_id,))
    return {"ok": True}


@app.delete("/api/training/runs/{run_id}")
def delete_run(run_id: str):
    row = fetch_one("DELETE FROM training_runs WHERE id = %s AND status NOT IN ('queued', 'submitting', 'running') "
                    "RETURNING id", (run_id,))
    if row is None:
        raise HTTPException(409, "Only finished runs can be deleted.")
    return {"ok": True}


# --- Skills ------------------------------------------------------------------------------

class SkillPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    task_prompt: str | None = None
    tags: list[str] | None = None


SKILL_SELECT = """
SELECT s.id, s.slug, s.title, s.description, s.task_prompt, s.policy, s.model_repo_id, s.cameras, s.tags,
       s.created_at, s.updated_at, s.run_id, r.dataset_repo_id, r.ego_repo_id, r.total_steps, r.min_loss,
       r.duration_s, r.cost_usd, r.flavor, COALESCE(r.spec -> 'camera_map', '{}') AS camera_map
FROM skills s LEFT JOIN run_overview r ON r.id = s.run_id
"""


@app.get("/api/skills")
def list_skills(q: str = ""):
    if q.strip():
        return fetch_all(
            SKILL_SELECT + """, websearch_to_tsquery('english', %(q)s) query
               WHERE s.search @@ query OR s.title ILIKE '%%' || %(q)s || '%%'
               ORDER BY ts_rank(s.search, query) DESC, s.created_at DESC""",
            {"q": q},
        )
    return fetch_all(SKILL_SELECT + " ORDER BY s.created_at DESC")


@app.get("/api/skills/{skill_id}")
def get_skill(skill_id: str):
    row = fetch_one(SKILL_SELECT + " WHERE s.id::text = %s OR s.slug = %s", (skill_id, skill_id))
    if row is None:
        raise HTTPException(404)
    return row


@app.patch("/api/skills/{skill_id}")
def patch_skill(skill_id: str, patch: SkillPatch):
    fields = patch.model_dump(exclude_none=True)
    if fields:
        sets = ", ".join(f"{k} = %({k})s" for k in fields)
        execute(f"UPDATE skills SET {sets} WHERE id = %(id)s", fields | {"id": skill_id})
    return get_skill(skill_id)


@app.delete("/api/skills/{skill_id}")
def delete_skill(skill_id: str):
    execute("DELETE FROM skills WHERE id = %s", (skill_id,))
    return {"ok": True}


# --- Live updates ------------------------------------------------------------------------

@app.get("/api/events")
async def events(request: Request):
    queue: asyncio.Queue = asyncio.Queue()
    broadcaster.queues.add(queue)

    async def stream():
        try:
            yield "retry: 2000\n\n"
            while not await request.is_disconnected():
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"data: {payload}\n\n"
                except TimeoutError:
                    yield ": ping\n\n"
        finally:
            broadcaster.queues.discard(queue)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/health")
def health():
    fetch_one("SELECT 1")
    return {"ok": True, "jobs": type(backend).__name__}


