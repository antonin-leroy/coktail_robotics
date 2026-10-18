"""Where training runs: HF Jobs, or a local simulation for UI work without a GPU bill.

Both backends expose the same calls on a run row: submit, stage, logs (a line iterator that
follows the job), system_metrics (an iterator of utilisation samples) and cancel. The fake one
prints lerobot-train-shaped lines, so the whole pipeline (parser, Postgres, live charts) runs.
"""

from __future__ import annotations

import math
import random
import time
from collections.abc import Iterator
from datetime import UTC, datetime

from huggingface_hub import cancel_job, fetch_job_logs, fetch_job_metrics, inspect_job, run_job

from .settings import settings

TERMINAL = {"COMPLETED", "CANCELED", "ERROR", "DELETED"}


def compact_system_metrics(sample: dict) -> dict:
    gpus = list((sample.get("gpus") or {}).values())
    return {
        "cpu_pct": sample.get("cpu_usage_pct"),
        "ram_gb": round((sample.get("memory_used_bytes") or 0) / 1e9, 2),
        "gpu_util": round(sum(g.get("utilization", 0) for g in gpus) / len(gpus), 1) if gpus else None,
        "gpu_mem_gb": round(sum(g.get("memory_used_bytes", 0) for g in gpus) / 1e9, 2) if gpus else None,
    }


class HfJobs:
    def submit(self, run: dict) -> tuple[str, str | None]:
        job = run_job(
            image=settings.studio_job_image,
            command=["bash", "-c", run["spec"]["script"]],
            flavor=run["flavor"],
            secrets={"HF_TOKEN": settings.hf_token},
            timeout=run["spec"].get("timeout", "6h"),
            labels={"skill-studio": "true", "run": str(run["id"])},
            namespace=settings.hf_namespace,
            token=settings.hf_token,
        )
        return job.id, getattr(job, "url", None)

    def stage(self, run: dict) -> tuple[str, str | None]:
        info = inspect_job(job_id=run["hf_job_id"], namespace=settings.hf_namespace, token=settings.hf_token)
        return getattr(info.status.stage, "value", info.status.stage), getattr(info.status, "message", None)

    def logs(self, run: dict) -> Iterator[str]:
        yield from fetch_job_logs(job_id=run["hf_job_id"], namespace=settings.hf_namespace, follow=True,
                                  token=settings.hf_token)

    def system_metrics(self, run: dict) -> Iterator[dict]:
        for sample in fetch_job_metrics(job_id=run["hf_job_id"], namespace=settings.hf_namespace, follow=True,
                                        token=settings.hf_token):
            yield compact_system_metrics(sample)

    def cancel(self, run: dict) -> None:
        cancel_job(job_id=run["hf_job_id"], namespace=settings.hf_namespace, token=settings.hf_token)


class FakeJobs:
    """A run of `total_steps` that takes ~2 minutes; state is derived from the clock, so it
    survives worker restarts. Cancelling is the worker noticing the run's status in Postgres."""

    SECONDS = 120.0

    def submit(self, run: dict) -> tuple[str, str | None]:
        return f"fake-{run['id']}-{int(time.time())}", None

    def _elapsed(self, run: dict) -> float:
        started = int(run["hf_job_id"].rsplit("-", 1)[1])
        return time.time() - started

    def stage(self, run: dict) -> tuple[str, str | None]:
        if self._elapsed(run) > self.SECONDS + 5:
            return "COMPLETED", None
        return "RUNNING", None

    def _lines(self, run: dict) -> Iterator[tuple[float, str]]:
        """(seconds after start, line) for the whole simulated run."""
        spec, total = run["spec"], run["total_steps"]
        log_freq = spec.get("log_freq", 100)
        rng = random.Random(str(run["id"]))
        stamp = lambda: datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")  # noqa: E731
        yield 0.5, f"INFO {stamp()} [fake job] {spec['script'].splitlines()[-1].strip()}"
        yield 1.0, f"INFO {stamp()} lerobot_train.py:512 Creating dataset {run['dataset_repo_id']}"
        yield 2.0, f"INFO {stamp()} lerobot_train.py:590 Creating policy {run['policy']}"
        yield 3.0, f"INFO {stamp()} lerobot_train.py:742 Start offline training on a fixed dataset"
        n = total // log_freq
        floor = {"act": 0.08, "smolvla": 0.03, "pi05": 0.02}.get(run["policy"], 0.05)
        for k in range(1, n + 1):
            step = k * log_freq
            loss = floor + (1.2 - floor) * math.exp(-5 * step / total) + rng.gauss(0, 0.012) * (1 - step / total)
            lr = 1e-4 * 0.5 * (1 + math.cos(math.pi * step / total)) if step > total * 0.02 else 1e-4 * step / (total * 0.02)
            shown = str(step) if step < 1000 else f"{round(step / 1000)}K"
            yield 4 + (self.SECONDS - 8) * k / n, (
                f"INFO {stamp()} lerobot_train.py:420 step:{shown} smpl:{step * 8} ep:{step // 40} "
                f"epch:{step * 8 / 40000:.2f} loss:{max(loss, 0.001):.3f} grdn:{8 * math.exp(-step / total) + rng.random():.3f} "
                f"lr:{lr:0.1e} updt_s:{0.08 + rng.random() * 0.01:.3f} data_s:{0.004 + rng.random() * 0.003:.3f} "
                f"smp/s:{95 + rng.random() * 10:.0f} mem_gb:{6.5 + rng.random() * 0.2:.2f}")
        yield self.SECONDS - 2, f"INFO {stamp()} train_utils.py:690 Model pushed to https://huggingface.co/{run['model_repo_id']}"

    def logs(self, run: dict) -> Iterator[str]:
        for at, line in self._lines(run):
            while self._elapsed(run) < at:
                time.sleep(0.2)
            yield line

    def system_metrics(self, run: dict) -> Iterator[dict]:
        rng = random.Random()
        while self.stage(run)[0] == "RUNNING":
            yield {"cpu_pct": 60 + rng.random() * 20, "ram_gb": 11.2, "gpu_util": 88 + rng.random() * 10,
                   "gpu_mem_gb": 7.1}
            time.sleep(5)

    def cancel(self, run: dict) -> None:
        pass


backend = FakeJobs() if settings.studio_fake_jobs else HfJobs()
