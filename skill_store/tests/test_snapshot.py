"""The demo snapshot loads into a fresh database once, and never into history."""
import pytest

from app import db, snapshot


@pytest.fixture
def blank_db(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "blank.db")
    db.init_db()
    db.seed_skills()


def count(table):
    return db.query(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"]


def test_snapshot_fills_a_fresh_database_once(blank_db):
    added = snapshot.load()
    assert added["compile_cache"] and added["props"] and added["runs"]
    assert not db.query("SELECT 1 FROM plans WHERE status IN ('queued','running')")
    assert snapshot.load() == {}                         # a restart adds nothing


def test_snapshot_never_mixes_into_existing_history(blank_db):
    pid = db.execute("INSERT INTO plans (prompt, robot_model, plan_json, valid) "
                     "VALUES ('mine', 'OpenArm', '{}', 1)")
    added = snapshot.load()
    assert "plans" not in added and "runs" not in added and "requests" not in added
    assert added["compile_cache"]                        # cached plans still merge in
    assert [r["id"] for r in db.query("SELECT id FROM plans")] == [pid]
