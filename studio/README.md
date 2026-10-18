# Skill Studio

Fine-tune LeRobot policies (ACT, SmolVLA, π0.5) on our OpenArm datasets from a web UI:
pick a dataset on the Hugging Face Hub, look at its episodes (every camera, depth included,
plus joint signals), choose the policy and the cameras it gets, optionally mix in an
egocentric human dataset, and launch the training on HF Jobs. Runs, metrics and the
resulting skills live in Postgres.

Built for ERH Physical AI Hackathon track 2 (*Watch, Learn, Do*: teach the bimanual OpenArm
from egocentric human video, cf. Ego-Pi).

```
browser ── Vite (React, TanStack Router/Query, shadcn, Tailwind) ── /api ──▶ FastAPI ──▶ Postgres
                                                                        │       ▲  LISTEN/NOTIFY → SSE
            <video> ◀── Hub (RGB, proxied) / S3 (previews) ◀────────────┘       │
                                                                     worker ────┘──▶ HF Jobs (lerobot-train)
```

Everything runs locally except training (HF Jobs) and the datasets/models (the Hub).

## Run it

```bash
cd studio
cp .env.example .env              # HF_TOKEN (write), or STUDIO_FAKE_JOBS=1 to simulate jobs
docker compose up -d              # Postgres :5433, RustFS (S3) :9000, console :9001

cd backend
uv sync
uv run uvicorn app.api:app --reload --timeout-graceful-shutdown 1 --port 8000   # terminal 1
uv run python -m app.worker                          # terminal 2

cd ../web
npm install
npm run dev                                          # terminal 3 → http://localhost:5173
```

`--timeout-graceful-shutdown` lets a reload close open live-update (SSE) streams.
Migrations run on startup; the S3 bucket is created on startup. Tests: `uv run pytest` in `backend/`.

## What happens where

| Piece | Role |
|---|---|
| `backend/app/hub.py` | Hub search (LeRobot tag), import of `meta/info.json` + `meta/episodes/*.parquet` into Postgres, per-episode signals from the data parquet (vectors, and the x/y/z of 4×4 poses). A dataset id can point into a repo folder (`griffinlabs/EgoDex-LeRobot-v3.0/test/add_remove_lid`); importing a repo with no `meta/info.json` lists the datasets inside it |
| `backend/app/media.py` | Camera streams of an episode. AV1/H.264/VP9 RGB is proxied from the Hub with Range support (multi-episode mp4, played over the episode's time span). Everything else (12-bit HEVC depth, PNG frames, other codecs) becomes an H.264 preview, depth through a turbo colormap, stored in S3 |
| `backend/app/policies.py` | Policy catalog and the planner: checks compatibility and writes the exact job script |
| `backend/app/worker.py` | Claims queued runs and previews (`FOR UPDATE SKIP LOCKED`), submits to HF Jobs, follows each job: logs → metrics, stage → status, GPU usage → system metrics |
| `backend/app/jobs.py` | HF Jobs backend, and `FakeJobs` (synthetic `lerobot-train` logs, ~2 min, no cost) |
| `web/` | Datasets (viewer + curation), Training (new run, runs, run detail), Skills |

### Training a run

- **Camera choice** (checked in the pinned LeRobot code and the pretrained configs on the Hub):

  | Policy | Cameras | Depth | Naming |
  |---|---|---|---|
  | ACT | any number, each through the same ResNet18 | no (3-channel RGB) | free; must match the robot's camera names at inference. Set with `--policy.input_features` |
  | SmolVLA | ≤ 3: `smolvla_base` has `camera1..3` | no | each camera renamed onto a slot with `--rename_map` (same map at inference) |
  | π0.5 | ≤ 3: `pi05_base` was pretrained on `base_0_rgb`, `left_wrist_0_rgb`, `right_wrist_0_rgb` | no | each camera goes to its view with `--rename_map`; features are set in that order and missing views are masked with `--policy.empty_cameras` |

  The UI guesses the view from the name (`left…` → left wrist, `right…` → right wrist, else
  head) and lets you change it. Only single-GPU flavors are offered: `lerobot-train` runs as
  one process.
- **Episode curation**: episodes unchecked in the viewer are left out with `--dataset.episodes`
  (the episodes to keep; the released trainer image, lerobot 0.6.1, has no `exclude_episodes`).
- **Checkpoints**: one every quarter of the steps, pushed to `<model repo>/checkpoints/<step>/`
  (tagged with the step) by `--save_checkpoint_to_hub`, so a crashed or timed-out run still
  leaves a usable model. For π0.5 each checkpoint includes the optimizer state (tens of GB).
- **Co-training (teleop + egocentric)**: `lerobot-train` takes one dataset and merging needs
  identical features, so the job first drops non-shared features with
  `lerobot-edit-dataset remove_feature`, merges with `lerobot-edit-dataset merge`, then trains on
  the merged copy. "Max ego episodes" caps the human share (Ego-Pi used ~50% per batch).
- The model is pushed to a private repo `<namespace>/<run-name>-<timestamp>`; when the run
  succeeds a trigger registers it as a skill.

Checked locally against the pinned LeRobot (see the repo's `pyproject.toml`): the generated
`lerobot-train` arguments parse and validate for all three policies, ACT builds with exactly the
selected cameras, and the remove-feature + merge prep produces a dataset that loads by
`--dataset.root` with exclusions. A real GPU run on HF Jobs has not been exercised yet.

### For the egocentric dataset to be mixable

The pre-flight check enforces what `lerobot-edit-dataset merge` requires. The RealSense +
MediaPipe + retargeting dataset must have:

- the same `robot_type` as the teleop dataset (e.g. `bi_openarm_follower`) and the same `fps`;
- `observation.state` and `action` with the same shape and names (16 joints: retargeted to the
  OpenArm joint space, grippers included);
- the shared camera under the same key and resolution (e.g. the head RealSense as
  `observation.images.front`); cameras only one dataset has are dropped from both;
- a task string per episode (VLAs condition on it).

## Postgres does the bookkeeping

- **Queues**: `training_runs` (status `queued`) and `previews` (status `pending`) are claimed with
  `FOR UPDATE SKIP LOCKED`; a run whose worker heartbeat is older than 60 s is taken over and its
  log stream resumes after the lines already stored.
- **Live UI**: triggers `pg_notify('studio', …)` on run changes, new metrics (through the step
  counter) and finished previews; the API `LISTEN`s and forwards over SSE, the UI invalidates
  TanStack Query caches.
- **Derived data**: generated columns over `meta/info.json` (`jsonb`), a `dataset_cameras` view
  (`jsonb_each`), a `run_overview` view (latest metrics and best loss via `LATERAL`, duration,
  cost), metric smoothing and downsampling with window functions (`avg() OVER`, `ntile`), loss sparklines with `array_agg`.
- **Skills**: a trigger promotes a succeeded run to a skill; skills are searched with a weighted
  `tsvector` (title, prompt, description, tags) and `websearch_to_tsquery`.
