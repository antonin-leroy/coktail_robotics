#!/usr/bin/env python3
"""Write data/demo_snapshot.json from the local database, so a fresh clone can
demo without an API key (see app/snapshot.py for what it holds and how the
server loads it).

    python tools/demo_snapshot.py           # export from data/skillstore.db
    python tools/demo_snapshot.py --load    # load it into the database now

Compile each demo prompt once on this machine first (the store's own UI is
enough): only cached plans the current compiler would still look up are kept,
so re-export after editing the compiler prompts, the catalog or the datasets.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import catalog as cat  # noqa: E402
from app import db, snapshot  # noqa: E402
from app.compiler import cache_key  # noqa: E402

STRUCTURES = ("dualarm",)     # the only structure the store's UI sends


def live_keys() -> dict[str, str]:
    """cache_key -> prompt, for every prompt this database has seen."""
    catalog = cat.load_catalog()
    seen = db.query("SELECT DISTINCT prompt, robot_model FROM requests "
                    "UNION SELECT DISTINCT prompt, robot_model FROM plans")
    return {cache_key(r["prompt"], r["robot_model"], catalog, s):
            f"{r['prompt']}  [{r['robot_model']}]"
            for r in seen for s in STRUCTURES}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--load", action="store_true", help="load the snapshot instead")
    args = ap.parse_args()
    db.init_db()
    if args.load:
        print(snapshot.load() or "nothing to add")
        return
    keys = live_keys()
    counts = snapshot.export(set(keys))
    cached = {k for k in keys
              if db.query("SELECT 1 FROM compile_cache WHERE cache_key = ?", (k,))}
    print(f"wrote {snapshot.PATH.relative_to(ROOT)} "
          f"({snapshot.PATH.stat().st_size / 1e6:.1f} MB): {counts}")
    print("prompts that compile offline:")
    for k in sorted(cached, key=keys.get):
        print("  ", keys[k])


if __name__ == "__main__":
    main()
