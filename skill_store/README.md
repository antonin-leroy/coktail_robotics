# Robot Skill Store

Type what you want your robot to do. A compiler decomposes it into purchasable
skills, a validator proves the sequence is physically coherent, and the robot
executes it — writing back the success rates the storefront displays.

Local-first: one `uvicorn`, one runner process, no cloud, no build step.

```
browser / CLI  ──▶  FastAPI + SQLite  ◀── poll ──  runner.py  ──▶  Moz1
                    (laptop:8000)                  (same laptop)     (CAT6)
```

The runner only makes **outbound** requests, so nothing has to reach into the
laptop: no tunnel, no port forward, works behind a captive portal or a hotspot.
The 120 Hz control loop lives in the runner, never across the network.

## Quickstart (no hardware needed)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env            # set OPENAI_API_KEY or ANTHROPIC_API_KEY
set -a && . ./.env && set +a
.venv/bin/uvicorn app.api:app --reload --port 8000
```

**Demo without a key.** On first start the server loads `data/demo_snapshot.json`:
cached plans for 15 demo prompts (the four example chips, tea, painting, piña
colada, plant pot, toy car, stacking cups, towel, apples, mojito, vase, glass of
water — on Spirit AI Moz1), their designed 3D props, and the benchmark, demand,
admin, ratings and composed skills. Those prompts compile instantly with no API
key; any other prompt needs one. Re-export with `python tools/demo_snapshot.py`
after compiling new demo prompts; `SKILLSTORE_DEMO=0` starts without it.

**Model provider.** `app/llm.py` takes either OpenAI or Anthropic; whichever key is
present wins, or force it with `LLM_PROVIDER`. Default model is `gpt-4.1-mini`;
`COMPILER_ACT_MODEL` can give stage 1 (below) a stronger one.

**How a request becomes a plan.** `app/compiler.py` runs two model calls:

1. **Act it out** — with no catalog in view, the request is written the way a
   person's hands would do it: the objects involved (each classified into a kind
   from `data/object_kinds.json`), phases named by their outcome, each broken
   into physical movements with the hand that does them, and the goal. A model that plans *from* the catalog
   bends the task to fit it; this one cannot.
2. **Bind** — with the catalog in view, movements become catalog skills or gaps.
   A gap is one movement ("dip a held item into a container"), placed exactly
   where it happens, with the open dataset whose footage covers it.

The validator then replays the plan — gaps included, with the effects they
declare — and its complaints go back to the binder in a **repair loop**: a model
is far better at fixing a named error than at avoiding it. What a skill can act
on is declared in the catalog (`acts_on`), so a bottle grasp on a bucket is
rejected by data, not by a word list.

Measure the compiler on requests it was not written for:

```bash
.venv/bin/python tools/compile_eval.py --runs 2      # writes reports/compile_eval_*.md
```

Add a prompt to `NOVEL` in that file whenever a customer request goes wrong, so the
fix is measured rather than assumed.

Second terminal — the robot runner, in mock mode:

```bash
set -a && . ./.env && set +a
.venv/bin/python runner/runner.py --mock --speed 4
```

Then open http://127.0.0.1:8000 or drive it from the terminal:

```bash
.venv/bin/python cli.py run "mix me a smoothie"
```

## CLI

| Command | What it does |
|---|---|
| `cli.py skills --status trained` | Catalog with measured success rates |
| `cli.py compile "<prompt>"` | Compile and print the plan, no execution |
| `cli.py install <id> --follow` | Queue a plan and stream its steps |
| `cli.py run "<prompt>"` | Compile + install + follow |
| `cli.py gaps` | Unmet demand, ranked |

## The four design decisions

**1. The plan is a program, not a shopping list.** One JSON artifact renders as the
cart (price, vendor, rating) and as the DAG the robot executes. That is what makes
the install button real rather than a mockup.

**2. Ratings are measured, not stars.** `app/catalog.py` computes success rates from
the `runs` table, which the robot writes. A skill nobody has run shows *no data* —
there is no way to type a number in. During a demo you can watch a rating move.

**3. The model proposes, the validator decides.** Drag any card in the chain and
the new order is re-checked instantly by `/api/validate` — no model call. Put
`pour_into` before `grasp_bottle` and install is blocked with the reason. That is
what makes the drag meaningful rather than decorative.

**3b. Same mechanism, stated again:** `app/compiler.py` constrains
`skill_id` to an enum built from the live catalog; `app/validator.py` then replays
the plan through a STRIPS-lite world model and rejects anything whose preconditions
are unmet. `/api/install` refuses an invalid plan with a 409.

**4. Gaps are the product.** Anything the catalog cannot do goes in `missing[]`,
never invented into `steps[]`, and every request is logged. `/api/gaps` ranks unmet
demand — the data-collection roadmap, generated from customers instead of guesses.
Each gap names the open dataset (from `data/datasets.json`, matched on its `covers`
field) that could train it, so a gap shows "no skill yet, data exists" rather than
a dead end.

## Going to hardware

1. **Probe first** — the SDK docs don't publish observation keys:
   ```bash
   python runner/probe_robot.py --structure dualarm --no-camera
   ```
2. Map the printed keys into `_to_policy_obs` / `_to_action` in `runner/moz1.py`.
   Both raise a clear `NotConfigured` until you do.
3. Start one `serve_policy.py` per **checkpoint** (not per skill) and list them in
   `POLICY_ENDPOINTS`. A skill is a `(checkpoint, prompt)` pair, so skills sharing a
   checkpoint differ only by the language prompt.
4. Run `runner.py --robot --structure dualarm`.

`mozrobot` must be installed **outside** the openpi `uv` environment — Spirit's docs
warn that mixing them breaks dependencies. That is why `runner/` is stdlib-only: it
adds nothing to whichever interpreter holds `mozrobot`.

## Hands, parallelism and auto-balance

`hand_empty` and `*_grasped` are scoped per hand (`bottle_grasped@left`), so two
sub-chains on different hands share no predicate and no hand, and the scheduler
puts them in the same time slot. Shared world facts still serialize: two pours
into one glass get a `resource` edge, because there is one glass.

Steps are grouped into **hand episodes** — from taking hold of something to letting
it go. Switching one step's hand switches its whole episode, because a hand has to
finish what it started; the UI says which steps moved with it.

**AUTO-BALANCE HANDS** searches one choice per episode (the first is pinned left;
mirroring is the same schedule) and keeps the shortest. Exact up to 13 episodes,
hill-climbing past that, and it never accepts an assignment that adds a validation
error. Measured on chains of repeated pick-and-pour:

| steps | episodes | method | evaluated | time slots | ms |
|---|---|---|---|---|---|
| 12 | 3 | exhaustive | 4 | 10 → 7 | 8 |
| 40 | 10 | exhaustive | 512 | 31 → 17 | 119 |
| 80 | 20 | hill-climb | 77 | 61 → 35 | 38 |

Note the parallelism comes from the scheduler, not the model. The planner only
picks skills; which hand does what, and what can overlap, is derived from the same
preconditions the validator enforces — so it is correct by construction rather than
by asking an LLM nicely.

## Measuring skills

The brief asks for success rates, so they are measured under a written protocol
rather than asserted.

```bash
python tools/run_eval.py --all-trained --trials 20
python tools/run_eval.py --skills wipe_surface --trials 20 --robot
```

Each skill is run N times independently, homed before every trial, with trial *t*
seeded `base + t` so any single trial reproduces. Every attempt is recorded,
failures included, with no retry and no discarding. Output is
`data/eval_<stamp>.json` and `reports/eval_<stamp>.md` — the table for the deck —
and every attempt also lands in the `runs` table, so the storefront's ratings move
while the eval runs.

Rates are reported as **95% Wilson intervals**, not bare percentages: 18/20 is not
"90%", it is 90% [70%, 97%], and Wilson stays sensible at the extremes where 20/20
would otherwise read as 100% [100%, 100%]. The Benchmark section draws each
interval to scale, so a wide bar is visibly a weak claim.

Sample-size reality check, which the page also states: ±10pp around 90% needs 35
trials, ±5pp needs 139. Plan robot time accordingly, and judge a skill by the lower
bound of its interval, not its midpoint.

## Executing a balanced plan

`/api/jobs/next` hands the runner **waves**, not a flat list: everything in a wave
is free to run at once, and each step carries its hand. The runner asks its
executor whether it can actually do that.

```bash
python runner/runner.py --mock --speed 6            # per-hand threads
python runner/runner.py --mock --speed 6 --serial   # same plan, one at a time
```

Measured on the pina colada, 14 steps balanced to 8 waves:

| mode | wall clock |
|---|---|
| parallel | 15.3 s |
| `--serial` | 25.4 s |

39% faster, matching the predicted drop from 12 time slots to 8.

`MockExecutor.supports_parallel` is `True`. `Moz1Executor`'s is **`False`**, and
that is deliberate: one `send_action` carries the whole body and each pi0.5
checkpoint drives both arms, so running two skills at once needs a merge layer
that takes the left-arm block from one policy and the right-arm block from the
other at 120 Hz. Until that exists the runner executes waves in order and prints
why, and the schedule in the UI is a plan rather than a measured robot result.
Say it that way in the demo.

## Images and data

Thumbnails are frames from real demonstration data, not stock art, so the picture
on a card shows the kind of thing the skill learned from. A skill with no data has
no picture, and the card says so — the gap is the point.

```bash
python tools/fetch_media.py --only trained     # fast, the ones that matter
python tools/fetch_media.py --datasets         # everything + dataset covers
```

It tries the Hub dataset-viewer image columns first (a direct JPEG, no auth, no
ffmpeg), then ffmpeg seeking over HTTPS, then gives up and lets the placeholder
show. Where a skill's own dataset serves no media (EgoDex is off-Hub; LeRobot v3
videos are AV1 and need an ffmpeg built with libdav1d), it borrows a representative
frame and records that in `data/thumb_sources.json`, which the UI prints under the
card. Set `HF_TOKEN` to reach the gated Build AI sets.

`data/datasets.json` is the registry behind the **Data** section: 138 sources,
with licence, access and size for each. The first 12 are the broad ones
(~112,000 hours). Verified reachable:
`Voxel51/Egocentric_10K_subset` (open, H.264, the one to start with),
`builddotai/Egocentric-10K` / `-100K` (Apache-2.0, gated-auto),
`lerobot/*` teleop sets. EgoDex is GitHub-only. `spirit-ai/pickplace` is private —
ask the organizers on day one.

The other 126 are single-task robot datasets from the Hugging Face hub, all in
LeRobot format, open, and Apache-2.0 or MIT: the Unitree G1, RoboCOIN, ALOHA and
AgileX collections (3 of them simulation), including a cocktail-making series. `data/skill_datasets.json` links them to skills, 2–4 per skill, each with
the dataset's own task text as the reason. Every skill now has robot data. These
are extra sources: a skill's primary `dataset` (what it was trained on) is
unchanged, and the extras are merged in as `datasets` when the catalog is seeded.
The skill popup lists them, and missing skills can point at them as candidate data.

## Editing the catalog

`tools/make_catalog.py` holds the whole catalog as one table. Edit, then:

```bash
python tools/make_catalog.py && rm -f data/skillstore.db   # reseeds on next start
```

Set `status` honestly before you demo: `trained` means a checkpoint exists and runs.
The storefront is self-correcting here — an untrained skill marked `trained` still
shows *no data*, because no runs exist.

## Before the demo

- **Pre-warm the compile cache.** Identical `(prompt, robot_model)` is served from
  `compile_cache` — instant, free, and immune to the API being slow on stage. Run
  your expected prompts once beforehand. `COMPILER_VERSION` in `app/compiler.py`
  is part of the cache key, so bumping it (as the two-stage compiler did) makes
  every old entry miss: re-warm after any compiler change.
- **Pre-warm the policy server.** openpi runs `torch.compile` on first inference and
  can time out. `Moz1Executor.load()` fires a warm-up inference for this reason.
- **Check both networks.** The laptop needs the robot on wired `172.16.0.x` *and*
  the internet for the compiler. Verify at hour 2, not hour 28.
- **Rehearse with `--mock --speed 8`**, including a forced failure, so the retry path
  is on film. Run it once with `--serial` too, so you have both numbers.
- **If an edit does not show up, hard-reload.** Asset URLs are stamped with their
  mtime and the HTML is sent `no-store`, but some browsers still hold the document.
  `?r=1` on the URL forces it.

## Security

`/api/jobs/next` and `/api/runs` queue and report **physical arm motions** and require
`Authorization: Bearer $ROBOT_SHARED_SECRET`. Never commit `.env`; `.gitignore`
covers it. The Anthropic key is only ever read server-side in `app/compiler.py` and
never reaches the browser.
