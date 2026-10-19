"""Customer ratings: what is stored, what the catalog shows, and that sample
reviews stay separable from real ones."""
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from app import api, db
from app import catalog as cat

ROOT = Path(__file__).resolve().parent.parent


def client():
    db.execute("DELETE FROM reviews")
    return TestClient(api.app)


def test_a_review_updates_the_summary(seeded):
    c = client()
    r = c.post("/api/skills/grasp_bottle/reviews", json={"stars": 4, "comment": "fine"})
    assert r.status_code == 200
    c.post("/api/skills/grasp_bottle/reviews", json={"stars": 2})
    s = c.get("/api/skills/grasp_bottle").json()["rating"]
    assert s["count"] == 2 and s["avg"] == 3.0
    assert s["histogram"] == [0, 1, 0, 1, 0]
    assert s["reviews"][0]["author"] == "Anonymous"


def test_the_catalog_carries_average_and_count(seeded):
    c = client()
    c.post("/api/skills/stir/reviews", json={"stars": 5})
    skills = {s["id"]: s for s in c.get("/api/skills").json()["skills"]}
    assert skills["stir"]["rating"] == {"avg": 5.0, "count": 1}
    assert skills["pour_into"]["rating"] == {"avg": None, "count": 0}


def test_bad_reviews_are_refused(seeded):
    c = client()
    assert c.post("/api/skills/stir/reviews", json={"stars": 6}).status_code == 422
    assert c.post("/api/skills/stir/reviews", json={"stars": 0}).status_code == 422
    assert c.post("/api/skills/nope/reviews", json={"stars": 3}).status_code == 404
    assert c.post("/api/skills/stir/reviews",
                  json={"stars": 3, "comment": "x" * 501}).status_code == 422


def test_seeding_covers_every_skill_and_removes_cleanly(seeded):
    client()
    cat.add_review("stir", "Spirit AI Moz1", 5, "real customer", "")
    run = lambda *a: subprocess.run([sys.executable, "tools/seed_reviews.py", *a],  # noqa: E731
                                    cwd=ROOT, check=True, capture_output=True)
    run()
    covered = {r["skill_id"] for r in db.query("SELECT DISTINCT skill_id FROM reviews")}
    assert covered >= set(cat.load_catalog())
    first = db.query("SELECT COUNT(*) AS n FROM reviews")[0]["n"]
    run()                                            # same seed: same reviews, no duplicates
    assert db.query("SELECT COUNT(*) AS n FROM reviews")[0]["n"] == first
    run("--remove")
    left = db.query("SELECT author FROM reviews")
    assert [r["author"] for r in left] == ["real customer"]
