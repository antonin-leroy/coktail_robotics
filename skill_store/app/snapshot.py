"""Demo snapshot: the database contents a fresh clone needs to demo offline.

data/skillstore.db is not in git, so a new machine starts with the catalog and
nothing else: every prompt needs an API key, the animation has no designed
props, and the benchmark, demand and admin pages are empty. The snapshot is a
JSON copy of the rows behind those pages, written by tools/demo_snapshot.py and
loaded at startup:

  - compile_cache and props are merged into any database (INSERT OR IGNORE), so
    the demo prompts compile instantly and without a key, even on a machine
    that already has a database of its own;
  - plans, requests and runs (benchmark and demand), reviews and composed
    skills are only loaded into tables that are still empty, so they never mix
    with a machine's own history.

Set SKILLSTORE_DEMO=0 to start without it.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import db

PATH = db.ROOT / "data" / "demo_snapshot.json"

# table -> columns, in insert order. Ids are kept so runs and requests still
# point at their plans.
TABLES: dict[str, list[str]] = {
    "compile_cache": ["cache_key", "plan_json", "created_at"],
    "props": ["name", "spec_json", "created_at"],
    "plans": ["id", "prompt", "robot_model", "plan_json", "valid", "status",
              "created_at", "claimed_at"],
    "requests": ["id", "prompt", "robot_model", "plan_id", "missing_json", "created_at"],
    "runs": ["id", "plan_id", "step_index", "skill_id", "robot_model", "success",
             "duration_s", "notes", "created_at"],
    "reviews": ["id", "skill_id", "robot_model", "stars", "author", "comment",
                "sample", "created_at"],
    "skills": ["id", "name", "vendor", "category", "price_eur", "status",
               "description", "manifest"],
}
MERGE = {"compile_cache", "props"}          # always merged, never overwritten
HISTORY = ("plans", "requests", "runs")     # loaded together, or not at all


def export(cache_keys: set[str], path: Path = PATH) -> dict[str, int]:
    """Write the snapshot. Only the compile_cache rows in `cache_keys` are
    kept: the others were built by an older compiler and can never hit."""
    out: dict[str, Any] = {}
    for table, cols in TABLES.items():
        sql = f"SELECT {', '.join(cols)} FROM {table}"
        if table == "skills":
            sql += " WHERE category = 'composite'"
        rows = [list(r) for r in db.query(sql + f" ORDER BY {cols[0]}")]
        if table == "compile_cache":
            rows = [r for r in rows if r[0] in cache_keys]
        if table == "plans":
            # A plan still queued here must not reach the demo machine's robot.
            rows = [r[:5] + ["compiled", r[6], None] if r[5] in ("queued", "running") else r
                    for r in rows]
        out[table] = {"columns": cols, "rows": rows}
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")
    return {t: len(v["rows"]) for t, v in out.items()}


def _empty(conn, table: str) -> bool:
    sql = f"SELECT 1 FROM {table}"
    if table == "skills":
        sql += " WHERE category = 'composite'"
    return conn.execute(sql + " LIMIT 1").fetchone() is None


def load(path: Path = PATH) -> dict[str, int]:
    """Load the snapshot into the current database; returns rows added per table."""
    if not path.exists():
        return {}
    snap = json.loads(path.read_text())
    added: dict[str, int] = {}
    with db.connect() as conn:
        # A table this checkout's schema does not have yet (reviews, before the
        # ratings change is merged) is skipped, and loads on a later start.
        have = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        fresh_history = all(_empty(conn, t) for t in HISTORY)
        for table, cols in TABLES.items():
            data = snap.get(table)
            if not data or not data["rows"] or table not in have:
                continue
            if table in HISTORY and not fresh_history:
                continue
            if table not in MERGE and table not in HISTORY and not _empty(conn, table):
                continue
            if data["columns"] != cols:
                raise ValueError(f"demo snapshot: {table} columns changed; re-export it")
            before = conn.total_changes
            conn.executemany(
                f"INSERT OR IGNORE INTO {table} ({', '.join(cols)}) "
                f"VALUES ({', '.join('?' * len(cols))})", data["rows"])
            added[table] = conn.total_changes - before
        conn.commit()
    return {t: n for t, n in added.items() if n}
