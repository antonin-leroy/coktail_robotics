-- Skill Studio schema. Postgres does the bookkeeping: job queues (SKIP LOCKED), live updates
-- (LISTEN/NOTIFY), derived columns (generated + views) and the run -> skill promotion (trigger).

CREATE TYPE dataset_kind AS ENUM ('teleop', 'egocentric', 'sim', 'other');
CREATE TYPE run_status AS ENUM ('queued', 'submitting', 'running', 'succeeded', 'failed', 'canceled');
CREATE TYPE preview_status AS ENUM ('pending', 'processing', 'ready', 'failed');

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- Datasets imported from the Hub. `info` is meta/info.json verbatim; columns are derived from it.
CREATE TABLE datasets (
    repo_id        text PRIMARY KEY,
    kind           dataset_kind NOT NULL DEFAULT 'teleop',
    info           jsonb NOT NULL,
    tasks          text[] NOT NULL DEFAULT '{}',
    private        boolean NOT NULL DEFAULT false,
    revision       text,
    has_quantiles  boolean NOT NULL DEFAULT false,  -- stats.json has q01/q99 (π0.5 default norm)
    total_episodes integer GENERATED ALWAYS AS ((info ->> 'total_episodes')::integer) STORED,
    total_frames   integer GENERATED ALWAYS AS ((info ->> 'total_frames')::integer) STORED,
    fps            real GENERATED ALWAYS AS ((info ->> 'fps')::real) STORED,
    robot_type     text GENERATED ALWAYS AS (info ->> 'robot_type') STORED,
    codebase       text GENERATED ALWAYS AS (info ->> 'codebase_version') STORED,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER datasets_updated_at BEFORE UPDATE ON datasets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per episode. `video` holds the per-camera file location and time span
-- (videos/<key>/chunk_index, file_index, from_timestamp, to_timestamp), stats are left out.
CREATE TABLE episodes (
    repo_id       text NOT NULL REFERENCES datasets ON DELETE CASCADE,
    episode_index integer NOT NULL,
    length        integer NOT NULL,
    tasks         text[] NOT NULL DEFAULT '{}',
    data_chunk    integer,
    data_file     integer,
    video         jsonb NOT NULL DEFAULT '{}',
    excluded      boolean NOT NULL DEFAULT false,  -- curated out of training
    PRIMARY KEY (repo_id, episode_index)
);

-- Every camera of every dataset, read out of the features JSON.
CREATE VIEW dataset_cameras AS
SELECT d.repo_id,
       f.key,
       f.value ->> 'dtype' AS dtype,
       f.value -> 'shape' AS shape,
       COALESCE((f.value -> 'info' ->> 'is_depth_map')::boolean,
                (f.value -> 'info' ->> 'video.is_depth_map')::boolean,
                f.value ->> 'dtype' = 'depth') AS is_depth,
       f.value -> 'info' ->> 'video.codec' AS codec,
       f.value -> 'info' ->> 'video.pix_fmt' AS pix_fmt,
       (f.value -> 'info' ->> 'video.fps')::real AS fps
FROM datasets d, jsonb_each(d.info -> 'features') AS f
WHERE f.value ->> 'dtype' IN ('video', 'image', 'depth');

-- Browser-playable previews of streams the browser cannot decode (12-bit depth, PNG frames).
-- A queue: the worker claims rows with FOR UPDATE SKIP LOCKED and uploads the mp4 to S3.
CREATE TABLE previews (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    repo_id       text NOT NULL REFERENCES datasets ON DELETE CASCADE,
    episode_index integer NOT NULL,
    camera        text NOT NULL,
    status        preview_status NOT NULL DEFAULT 'pending',
    s3_key        text,
    error         text,
    attempts      integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (repo_id, episode_index, camera)
);
CREATE INDEX previews_pending ON previews (created_at) WHERE status = 'pending';
CREATE TRIGGER previews_updated_at BEFORE UPDATE ON previews
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A training run is a task: the API inserts it 'queued', the worker claims it, submits it to
-- HF Jobs and follows it to the end.
CREATE TABLE training_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL,
    status          run_status NOT NULL DEFAULT 'queued',
    policy          text NOT NULL,
    dataset_repo_id text NOT NULL REFERENCES datasets,
    ego_repo_id     text REFERENCES datasets,
    spec            jsonb NOT NULL,           -- what the user chose in the form
    command         text[] NOT NULL,          -- what runs in the job
    flavor          text NOT NULL,
    cost_per_min    numeric(10, 6),           -- USD, from the HF hardware list at submit time
    total_steps     integer NOT NULL,
    last_step       integer NOT NULL DEFAULT 0,
    model_repo_id   text NOT NULL,
    hf_job_id       text,
    hf_job_url      text,
    error           text,
    log_lines       integer NOT NULL DEFAULT 0,  -- lines already ingested (resume after restart)
    claimed_by      text,
    heartbeat_at    timestamptz,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_runs_queued ON training_runs (created_at) WHERE status = 'queued';
CREATE INDEX training_runs_created ON training_runs (created_at DESC);
CREATE TRIGGER training_runs_updated_at BEFORE UPDATE ON training_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per logged step; values hold whatever lerobot-train printed (loss, grad_norm, lr, ...).
CREATE TABLE training_metrics (
    run_id      uuid NOT NULL REFERENCES training_runs ON DELETE CASCADE,
    step        integer NOT NULL,
    values      jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, step)
);

-- GPU / CPU utilisation sampled from the HF Jobs metrics stream.
CREATE TABLE system_metrics (
    run_id      uuid NOT NULL REFERENCES training_runs ON DELETE CASCADE,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    values      jsonb NOT NULL
);
CREATE INDEX system_metrics_run ON system_metrics (run_id, recorded_at);

CREATE TABLE training_logs (
    run_id uuid NOT NULL REFERENCES training_runs ON DELETE CASCADE,
    seq    integer NOT NULL,
    line   text NOT NULL,
    PRIMARY KEY (run_id, seq)
);

-- array_to_string is only STABLE (generic over element types); for text[] it is immutable.
CREATE FUNCTION tags_text(tags text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN array_to_string(tags, ' ');

-- A trained model is a skill. Created by trigger when a run succeeds, then edited in the UI.
CREATE TABLE skills (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          text NOT NULL UNIQUE,
    run_id        uuid UNIQUE REFERENCES training_runs ON DELETE SET NULL,
    title         text NOT NULL,
    description   text NOT NULL DEFAULT '',
    task_prompt   text NOT NULL DEFAULT '',
    policy        text NOT NULL,
    model_repo_id text NOT NULL,
    cameras       text[] NOT NULL DEFAULT '{}',
    tags          text[] NOT NULL DEFAULT '{}',
    search        tsvector GENERATED ALWAYS AS (
                      setweight(to_tsvector('simple', title), 'A') ||
                      setweight(to_tsvector('english', task_prompt), 'B') ||
                      setweight(to_tsvector('english', description), 'C') ||
                      setweight(to_tsvector('simple', tags_text(tags)), 'B')
                  ) STORED,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX skills_search ON skills USING gin (search);
CREATE TRIGGER skills_updated_at BEFORE UPDATE ON skills
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Live updates: the API LISTENs on 'studio' and forwards to the browser over SSE.
CREATE FUNCTION notify_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('studio', json_build_object(
        'type', 'run', 'id', NEW.id, 'status', NEW.status, 'last_step', NEW.last_step)::text);
    RETURN NEW;
END $$;
CREATE TRIGGER training_runs_notify AFTER INSERT OR UPDATE OF status, last_step, error, hf_job_id
    ON training_runs FOR EACH ROW EXECUTE FUNCTION notify_run();

-- A new metric advances the run's step counter (which in turn notifies through notify_run).
CREATE FUNCTION advance_run_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE training_runs SET last_step = NEW.step WHERE id = NEW.run_id AND last_step < NEW.step;
    RETURN NEW;
END $$;
CREATE TRIGGER training_metrics_advance AFTER INSERT ON training_metrics
    FOR EACH ROW EXECUTE FUNCTION advance_run_step();

CREATE FUNCTION notify_preview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('studio', json_build_object(
        'type', 'preview', 'repo_id', NEW.repo_id, 'episode_index', NEW.episode_index,
        'camera', NEW.camera, 'status', NEW.status)::text);
    RETURN NEW;
END $$;
CREATE TRIGGER previews_notify AFTER UPDATE OF status ON previews
    FOR EACH ROW EXECUTE FUNCTION notify_preview();

-- Run succeeded -> skill (once). Title and prompt come from the run; the user edits them later.
CREATE FUNCTION promote_run_to_skill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM 'succeeded' THEN
        INSERT INTO skills (slug, run_id, title, task_prompt, policy, model_repo_id, cameras, tags)
        VALUES (
            regexp_replace(lower(NEW.name), '[^a-z0-9]+', '-', 'g') || '-' || left(NEW.id::text, 6),
            NEW.id,
            NEW.name,
            COALESCE(NEW.spec ->> 'task', ''),
            NEW.policy,
            NEW.model_repo_id,
            ARRAY(SELECT jsonb_array_elements_text(NEW.spec -> 'cameras')),
            ARRAY[NEW.policy] || CASE WHEN NEW.ego_repo_id IS NULL THEN '{}'::text[] ELSE ARRAY['co-trained'] END
        )
        ON CONFLICT (run_id) DO NOTHING;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER training_runs_promote AFTER UPDATE OF status ON training_runs
    FOR EACH ROW EXECUTE FUNCTION promote_run_to_skill();

-- Run list with its latest metrics, best loss, duration and cost.
CREATE VIEW run_overview AS
SELECT r.*,
       last.values AS last_values,
       best.min_loss,
       EXTRACT(EPOCH FROM (COALESCE(r.finished_at, now()) - r.started_at)) AS duration_s,
       ROUND(r.cost_per_min * EXTRACT(EPOCH FROM (COALESCE(r.finished_at, now()) - r.started_at)) / 60, 2)
           AS cost_usd,
       s.id AS skill_id
FROM training_runs r
LEFT JOIN LATERAL (
    SELECT m.values FROM training_metrics m WHERE m.run_id = r.id ORDER BY m.step DESC LIMIT 1
) last ON true
LEFT JOIN LATERAL (
    SELECT min((m.values ->> 'loss')::double precision) AS min_loss
    FROM training_metrics m WHERE m.run_id = r.id
) best ON true
LEFT JOIN skills s ON s.run_id = r.id;
