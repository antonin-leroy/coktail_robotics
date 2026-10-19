-- Skill catalog. The manifest JSON is the source of truth; columns are for querying.
CREATE TABLE IF NOT EXISTS skills (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    vendor        TEXT NOT NULL,
    category      TEXT NOT NULL,
    price_eur     REAL NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('trained','beta','catalog')),
    description   TEXT NOT NULL,
    manifest      TEXT NOT NULL
);

-- One row per compiled plan. plan_json holds steps + missing skills.
CREATE TABLE IF NOT EXISTS plans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt        TEXT NOT NULL,
    robot_model   TEXT NOT NULL,
    plan_json     TEXT NOT NULL,
    valid         INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'compiled'
                  CHECK (status IN ('compiled','queued','running','done','failed')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at    TEXT
);

-- One row per executed step. This table IS the ratings data.
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id       INTEGER REFERENCES plans(id),
    step_index    INTEGER NOT NULL,
    skill_id      TEXT NOT NULL,
    robot_model   TEXT NOT NULL,
    success       INTEGER NOT NULL,
    duration_s    REAL,
    notes         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS runs_skill_robot ON runs (skill_id, robot_model);

-- Every compile request, so unmet demand is queryable. This is the gap dashboard.
CREATE TABLE IF NOT EXISTS requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt        TEXT NOT NULL,
    robot_model   TEXT NOT NULL,
    plan_id       INTEGER REFERENCES plans(id),
    missing_json  TEXT NOT NULL DEFAULT '[]',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Compile cache: identical (prompt, robot_model) returns instantly and costs nothing.
CREATE TABLE IF NOT EXISTS compile_cache (
    cache_key     TEXT PRIMARY KEY,
    plan_json     TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Model-designed stand-in 3D props for objects the animation has no builder for.
CREATE TABLE IF NOT EXISTS props (
    name          TEXT PRIMARY KEY,
    spec_json     TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Customer ratings: 1-5 stars and a short review per skill. This is what buyers
-- say, next to -- never instead of -- the measured success rate from `runs`.
-- `sample` marks seeded demo reviews (tools/seed_reviews.py) so they can be told
-- apart from real ones and removed in one go.
CREATE TABLE IF NOT EXISTS reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id      TEXT NOT NULL,
    robot_model   TEXT NOT NULL,
    stars         INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    author        TEXT NOT NULL,
    comment       TEXT NOT NULL DEFAULT '',
    sample        INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS reviews_skill ON reviews (skill_id);
