#!/usr/bin/env python3
"""Seed sample customer reviews for every skill, so the rating UI has something
to show before real customers have rated anything.

Every row this writes is marked `sample = 1`: the storefront labels them, and
they can be removed in one go without touching real reviews.

    python tools/seed_reviews.py            # replace all sample reviews
    python tools/seed_reviews.py --remove   # delete sample reviews only

Deterministic (fixed seed per skill), so re-running gives the same reviews.
Better-proven skills get more and kinder reviews: a trained skill has been
bought and run more often than one that is only listed.
"""
from __future__ import annotations

import argparse
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import catalog as cat  # noqa: E402
from app import db  # noqa: E402

# (mean stars, how many reviews) by catalog status.
PROFILE = {"trained": (4.4, (18, 34)), "beta": (3.9, (8, 16)), "catalog": (3.4, (3, 9))}
COMPOSITE = (4.2, (4, 10))

ROBOTS = ["Spirit AI Moz1", "Spirit AI Moz1", "Spirit AI Moz1", "Universal Robots UR10e",
          "ABB YuMi", "SO-ARM101", "AgiBot A2", "Unitree G1", "OpenArm"]
AUTHORS = ["Bar owner, Lyon", "Lab engineer, Zurich", "Hotel kitchen, Geneva",
           "Robotics student", "Systems integrator, Munich", "Cafe, Basel",
           "Home user", "Hackathon team", "Research lab, Lausanne", "Event caterer",
           "Retail pilot, Milan", "Makerspace, Bern"]
COMMENTS = {
    5: ["{name} worked first time on our {robot}.",
        "Reliable. We run it every day without retuning.",
        "Set up in minutes and does exactly what the listing says.",
        "Smooth and fast; no failed attempts in our first week."],
    4: ["Works well, needed one retry on shiny objects.",
        "Solid. A little slow on the first attempt after a restart.",
        "Good value; we would like a faster variant.",
        "Does the job on our {robot} once the table is lit evenly."],
    3: ["Fine for demos, misses about one attempt in ten.",
        "OK once we moved the camera, unreliable before that.",
        "Works, but plan for retries when objects are close together."],
    2: ["Struggled with our {robot}'s camera angle.",
        "Needed many retries; usable only with supervision."],
    1: ["Did not work on our setup.",
        "Failed most attempts on our {robot}."],
}


def reviews_for(skill: dict, now: datetime) -> list[tuple]:
    rng = random.Random(f"reviews:{skill['id']}")
    mean, (lo, hi) = COMPOSITE if skill.get("category") == "composite" \
        else PROFILE.get(skill.get("status"), PROFILE["catalog"])
    out = []
    for _ in range(rng.randint(lo, hi)):
        stars = max(1, min(5, round(rng.gauss(mean, 0.8))))
        robot = rng.choice(ROBOTS)
        comment = rng.choice(COMMENTS[stars]).format(name=skill["name"], robot=robot)
        when = now - timedelta(days=rng.uniform(1, 150))
        out.append((skill["id"], robot, stars, rng.choice(AUTHORS), comment, 1,
                    when.strftime("%Y-%m-%d %H:%M:%S")))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--remove", action="store_true", help="delete sample reviews only")
    args = ap.parse_args()

    db.init_db()
    db.execute("DELETE FROM reviews WHERE sample = 1")
    if args.remove:
        print("sample reviews removed")
        return
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = [r for s in cat.load_catalog().values() for r in reviews_for(s, now)]
    with db.connect() as conn:
        conn.executemany("INSERT INTO reviews (skill_id, robot_model, stars, author, comment, "
                         "sample, created_at) VALUES (?,?,?,?,?,?,?)", rows)
    skills = len({r[0] for r in rows})
    print(f"{len(rows)} sample reviews for {skills} skills "
          f"(average {sum(r[2] for r in rows) / len(rows):.2f} stars)")


if __name__ == "__main__":
    main()
