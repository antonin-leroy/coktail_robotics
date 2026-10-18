"""Postgres access: a shared connection pool and plain-SQL migrations applied in file order."""

from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .settings import settings

MIGRATIONS = Path(__file__).parent / "migrations"

pool = ConnectionPool(settings.database_url, kwargs={"row_factory": dict_row}, open=False)


def migrate() -> None:
    with pool.connection() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)")
        done = {r["name"] for r in conn.execute("SELECT name FROM schema_migrations")}
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name in done:
                continue
            with conn.transaction():
                conn.execute(path.read_text())
                conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))


def fetch_all(sql: str, params=None) -> list[dict]:
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchall()


def fetch_one(sql: str, params=None) -> dict | None:
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchone()


def execute(sql: str, params=None) -> None:
    with pool.connection() as conn:
        conn.execute(sql, params)
