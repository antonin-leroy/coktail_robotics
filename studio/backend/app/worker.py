"""Background worker: `uv run python -m app.worker`.

Postgres is the queue. Each tick the worker claims queued runs and pending previews with
FOR UPDATE SKIP LOCKED (several workers can run side by side), submits runs to HF Jobs and
follows each running job in a thread: log lines -> training_logs + training_metrics, job
stage -> run status, GPU usage -> system_metrics. A run whose heartbeat is older than a minute
is taken over, and its log stream resumes after the lines already stored.
"""

import logging
import os
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from psycopg.types.json import Jsonb

from .db import fetch_one, migrate, pool
from .jobs import TERMINAL, backend
from .logparse import PUSH_MARKER, MetricParser
from .media import build_preview
from .storage import ensure_bucket

log = logging.getLogger("worker")
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"
STALE = "interval '60 seconds'"


def claim_run() -> dict | None:
    return fetch_one(
        """UPDATE training_runs SET status = 'submitting', claimed_by = %s, heartbeat_at = now()
           WHERE id = (SELECT id FROM training_runs WHERE status = 'queued'
                       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING *""",
        (WORKER_ID,),
    )


def submit(run: dict) -> None:
    try:
        job_id, url = backend.submit(run)
    except Exception as e:
        log.exception("submit failed for %s", run["id"])
        with pool.connection() as conn:
            conn.execute("UPDATE training_runs SET status = 'failed', error = %s, finished_at = now() WHERE id = %s",
                         (f"Submission failed: {e}", run["id"]))
        return
    with pool.connection() as conn:
        conn.execute(
            """UPDATE training_runs SET status = 'running', hf_job_id = %s, hf_job_url = %s, started_at = now(),
               heartbeat_at = now() WHERE id = %s""",
            (job_id, url, run["id"]),
        )


def runs_to_follow(following: set) -> list[dict]:
    """Running runs this worker owns but isn't following yet, or whose owner went quiet."""
    with pool.connection() as conn:
        rows = conn.execute(
            f"""UPDATE training_runs SET claimed_by = %s, heartbeat_at = now()
                WHERE status = 'running' AND (claimed_by = %s OR heartbeat_at < now() - {STALE})
                  AND NOT (id = ANY(%s))
                RETURNING *""",
            (WORKER_ID, WORKER_ID, list(following)),
        ).fetchall()
    return rows


class Follower(threading.Thread):
    def __init__(self, run: dict, done: callable):
        super().__init__(daemon=True, name=f"run-{run['id']}")
        self.run_row = run
        self.stop = threading.Event()
        self.done = done

    def current_status(self) -> str:
        return fetch_one("SELECT status FROM training_runs WHERE id = %s", (self.run_row["id"],))["status"]

    def ingest_logs(self) -> None:
        run = self.run_row
        parser = MetricParser(run["spec"].get("log_freq", 100), run["last_step"])
        seen = run["log_lines"]
        while not self.stop.is_set():
            try:
                for i, line in enumerate(backend.logs(run)):
                    if self.stop.is_set():
                        return
                    if i < seen:
                        continue  # each reconnect replays the whole log
                    seen = i + 1
                    metric = parser.feed(line)
                    with pool.connection() as conn, conn.transaction():
                        conn.execute("INSERT INTO training_logs (run_id, seq, line) VALUES (%s, %s, %s) "
                                     "ON CONFLICT DO NOTHING", (run["id"], i, line[:4000]))
                        if metric:
                            conn.execute("INSERT INTO training_metrics (run_id, step, values) VALUES (%s, %s, %s) "
                                         "ON CONFLICT (run_id, step) DO UPDATE SET values = EXCLUDED.values",
                                         (run["id"], metric[0], Jsonb(metric[1])))
                        conn.execute("UPDATE training_runs SET log_lines = %s WHERE id = %s", (seen, run["id"]))
                    if PUSH_MARKER in line:
                        log.info("run %s pushed its model", run["id"])
            except Exception:
                log.warning("log stream of %s dropped, reconnecting", run["id"], exc_info=True)
            self.stop.wait(3)

    def ingest_system_metrics(self) -> None:
        last = 0.0
        while not self.stop.is_set():
            try:
                for sample in backend.system_metrics(self.run_row):
                    if self.stop.is_set():
                        return
                    if time.time() - last >= 10:  # the stream is 1 Hz; 0.1 Hz is plenty for a chart
                        last = time.time()
                        with pool.connection() as conn:
                            conn.execute("INSERT INTO system_metrics (run_id, values) VALUES (%s, %s)",
                                         (self.run_row["id"], Jsonb(sample)))
            except Exception:
                log.debug("metrics stream of %s dropped", self.run_row["id"], exc_info=True)
            self.stop.wait(10)

    def run(self) -> None:
        run = self.run_row
        threads = [threading.Thread(target=self.ingest_logs, daemon=True),
                   threading.Thread(target=self.ingest_system_metrics, daemon=True)]
        for t in threads:
            t.start()
        try:
            while True:
                if self.current_status() != "running":  # canceled from the UI
                    break
                try:
                    stage, message = backend.stage(run)
                except Exception:
                    log.warning("inspect failed for %s", run["id"], exc_info=True)
                    stage, message = "UNKNOWN", None
                if stage in TERMINAL:
                    threads[0].join(timeout=15)  # let the tail of the log land first
                    status = {"COMPLETED": "succeeded", "CANCELED": "canceled"}.get(stage, "failed")
                    with pool.connection() as conn:
                        conn.execute(
                            """UPDATE training_runs SET status = %s, error = %s, finished_at = now()
                               WHERE id = %s AND status = 'running'""",
                            (status, message if status == "failed" else None, run["id"]),
                        )
                    break
                with pool.connection() as conn:
                    conn.execute("UPDATE training_runs SET heartbeat_at = now() WHERE id = %s", (run["id"],))
                time.sleep(5)
        finally:
            self.stop.set()
            self.done(run["id"])


def claim_preview() -> dict | None:
    return fetch_one(
        """UPDATE previews SET status = 'processing', attempts = attempts + 1
           WHERE id = (SELECT id FROM previews
                       WHERE status = 'pending' OR (status = 'processing' AND updated_at < now() - interval '15 minutes')
                       ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
           RETURNING *""",
    )


def process_preview(preview: dict) -> None:
    try:
        key = build_preview(preview["id"])
        status, error = "ready", None
    except Exception as e:
        log.exception("preview %s failed", preview["id"])
        key, status, error = None, "failed", str(e)[:500]
    with pool.connection() as conn:
        conn.execute("UPDATE previews SET status = %s, s3_key = %s, error = %s WHERE id = %s",
                     (status, key, error, preview["id"]))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    pool.open()
    migrate()
    ensure_bucket()
    log.info("worker %s up (%s)", WORKER_ID, type(backend).__name__)

    following: dict = {}
    lock = threading.Lock()

    def done(run_id) -> None:
        with lock:
            following.pop(run_id, None)

    previews = ThreadPoolExecutor(max_workers=2, thread_name_prefix="preview")
    preview_slots = threading.Semaphore(2)

    while True:
        while (run := claim_run()) is not None:
            log.info("submitting run %s (%s on %s)", run["id"], run["policy"], run["flavor"])
            submit(run)
        with lock:
            ids = set(following)
        for run in runs_to_follow(ids):
            log.info("following run %s (job %s)", run["id"], run["hf_job_id"])
            f = Follower(run, done)
            with lock:
                following[run["id"]] = f
            f.start()
        while preview_slots.acquire(blocking=False):
            preview = claim_preview()
            if preview is None:
                preview_slots.release()
                break
            log.info("building preview %s (%s ep %s %s)", preview["id"], preview["repo_id"],
                     preview["episode_index"], preview["camera"])
            future = previews.submit(process_preview, preview)
            future.add_done_callback(lambda _: preview_slots.release())
        time.sleep(1)


if __name__ == "__main__":
    main()
