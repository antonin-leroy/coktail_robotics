"""Hermetic test setup: a throwaway database, seeded from the catalog files.

SKILLSTORE_DB is read when app.db is imported, so it is set here, before any
test module imports the app. Nothing touches data/skillstore.db, and no test
calls a language model.
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
_tmp = tempfile.mkdtemp(prefix="skillstore-test-")
os.environ["SKILLSTORE_DB"] = str(Path(_tmp) / "test.db")
os.environ.setdefault("ROBOT_SHARED_SECRET", "test-secret")
os.environ["SKILLSTORE_DEMO"] = "0"

import pytest  # noqa: E402

from app import catalog as cat  # noqa: E402
from app import db  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def seeded():
    db.init_db()
    db.seed_skills()


@pytest.fixture
def catalog(seeded):
    return cat.load_catalog()


@pytest.fixture
def fresh_requests(seeded):
    """Empty demand tables for one test."""
    db.execute("DELETE FROM requests")
    db.execute("DELETE FROM plans")
    yield
    db.execute("DELETE FROM requests")
    db.execute("DELETE FROM plans")
