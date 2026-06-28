-- ============================================================================
-- SQLite schema for persistent artifact store
-- Designed for: DVA (Data Visualization Agent) project
-- ============================================================================

-- ---------------------------------------------------------------------------
-- user — authenticated identity for multi-tenant catalog scoping
-- Purpose: isolate artifacts by user. The TUI agent is unscoped (sees all).
-- Browser sessions are scoped via x-authenticated-user header from the proxy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user (
    id           TEXT PRIMARY KEY,                         -- username from Basic Auth
    display_name TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- category — top-level domain grouping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category (
    id          TEXT PRIMARY KEY,                          -- UUID
    name        TEXT NOT NULL UNIQUE,                      -- e.g. "Economics"
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- subject — research topic or report theme within a category
-- Purpose: group multiple sessions under a common subject matter.
-- Examples (under Economics): "M3 Shipments Analysis", "Texas Labor Market"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subject (
    id          TEXT PRIMARY KEY,                          -- UUID
    category_id TEXT REFERENCES category(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,                             -- e.g. "Manufacturing Shipments"
    description TEXT,
    tags        TEXT NOT NULL DEFAULT '[]',                -- JSON array, e.g. '["m3","manufacturing"]'
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(category_id, name)                             -- one name per category, not globally unique
);

-- ---------------------------------------------------------------------------
-- model — LLM used to produce artifacts
-- Purpose: provenance tracking — which model generated what.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model (
    id           TEXT PRIMARY KEY,                         -- e.g. "deepseek/deepseek-v4-pro"
    provider     TEXT NOT NULL,                            -- e.g. "openrouter"
    display_name TEXT NOT NULL,                            -- e.g. "DeepSeek V4 Pro"
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- session — one agent conversation run
-- Purpose: group all artifacts produced in a single conversation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session (
    id           TEXT PRIMARY KEY,                         -- UUID
    subject_id   TEXT REFERENCES subject(id) ON DELETE SET NULL,
    model_id     TEXT REFERENCES model(id) ON DELETE SET NULL,
    user_id      TEXT REFERENCES user(id) ON DELETE SET NULL,
    title        TEXT,                                     -- optional user-provided session name
    started_at   TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at     TEXT,
    prompt_count INTEGER NOT NULL DEFAULT 0,               -- how many user prompts in this session
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- artifact — the core table: every durable artifact produced by the agent
-- Purpose: persist charts (HTML), CSVs, Markdown reports, JSON configs, etc.
--          across session restarts.
--
-- Column notes:
--   - content is always TEXT. HTML artifacts embed their own SVG via D3.
--     Standalone SVGs are NOT persisted (image/svg+xml is legacy).
--     PNG screenshots are transient and never stored here.
--   - replaces_id forms a linked list of versions (v1 → v2 → v3).
--     The head of the chain (no artifact with replaces_id pointing to it)
--     is the latest. Use the artifact_latest view for queries.
--   - provenance is JSON: {sources, lookups, tools, skills, data_files, stat_methods}.
--   - model_id is denormalized from session for fast cross-model queries.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact (
    id           TEXT PRIMARY KEY,                         -- UUID (matches current artifact store ID)
    session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    filename     TEXT NOT NULL,
    mime_type    TEXT NOT NULL,                            -- text/html, text/csv, text/markdown, application/json
    role         TEXT NOT NULL,                            -- chart, dataset-csv, dataset-meta, section, page, document-manifest, memory
    description  TEXT,
    content      TEXT NOT NULL,                            -- artifact body
    size_bytes   INTEGER NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    model_id     TEXT REFERENCES model(id) ON DELETE SET NULL,
    replaces_id  TEXT REFERENCES artifact(id) ON DELETE SET NULL,  -- previous version; NULL = original
    provenance   TEXT NOT NULL DEFAULT '{}',               -- JSON
    tags         TEXT NOT NULL DEFAULT '[]'                -- JSON array
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_artifact_session   ON artifact(session_id);
CREATE INDEX IF NOT EXISTS idx_artifact_role      ON artifact(role);
CREATE INDEX IF NOT EXISTS idx_artifact_created   ON artifact(created_at);
CREATE INDEX IF NOT EXISTS idx_artifact_title     ON artifact(title);
CREATE INDEX IF NOT EXISTS idx_artifact_model     ON artifact(model_id);
CREATE INDEX IF NOT EXISTS idx_artifact_replaces  ON artifact(replaces_id);
CREATE INDEX IF NOT EXISTS idx_session_subject    ON session(subject_id);
CREATE INDEX IF NOT EXISTS idx_session_model      ON session(model_id);
CREATE INDEX IF NOT EXISTS idx_session_user       ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_subject_category   ON subject(category_id);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Latest version of each artifact (top of version chain)
CREATE VIEW IF NOT EXISTS artifact_latest AS
SELECT a.*
FROM artifact a
LEFT JOIN artifact b ON b.replaces_id = a.id
WHERE b.id IS NULL;

-- ---------------------------------------------------------------------------
-- v_artifact_head — head-of-chain artifacts, with infrastructure roles hidden
--
-- This is the canonical user-facing artifact view. Both the catalog builder
-- and the agent's user-facing NL→SQL surface should pivot off this view so
-- they cannot disagree about what the corpus contains.
--
-- Differences from artifact_latest:
--   1. memory artifacts are excluded (they're agent-internal scratchpads).
--   2. catalog artifacts are excluded (the catalog is derived state — it
--      should never show up inside itself).
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_artifact_head AS
SELECT a.*
FROM artifact a
LEFT JOIN artifact b ON b.replaces_id = a.id
WHERE b.id IS NULL
  AND a.role NOT IN ('memory', 'catalog');

-- Full hierarchy: category → subject → session → artifact
CREATE VIEW IF NOT EXISTS catalog AS
SELECT
    c.name        AS category,
    s.name        AS subject,
    s.description AS subject_description,
    a.title       AS artifact_title,
    a.role,
    a.mime_type,
    a.description AS artifact_description,
    a.id         AS artifact_id,
    a.created_at AS artifact_created,
    a.tags       AS artifact_tags,
    sess.id      AS session_id,
    sess.started_at AS session_started,
    sess.prompt_count,
    m.display_name AS model
FROM artifact a
JOIN session sess ON a.session_id = sess.id
LEFT JOIN subject s ON sess.subject_id = s.id
LEFT JOIN category c ON s.category_id = c.id
LEFT JOIN model m ON a.model_id = m.id;

-- ============================================================================
-- Example data flow
-- ============================================================================
-- Category: Economics
--   Subject: M3 Shipments Analysis
--     Session: "Initial data pull" (DeepSeek V4 Pro, 3 prompts)
--       Artifact: Total Mfg Shipments — NSA (chart, HTML)
--       Artifact: Total Mfg Shipments — NSA (dataset-csv, CSV)
--     Session: "Seasonal adjustment" (DeepSeek V4 Pro, 1 prompt)
--       Artifact: SA vs NSA comparison (chart, HTML, replaces previous chart)
--
-- Category: Healthcare
--   Subject: Hospital Readmission Rates
--     Session: "Medicare data exploration" (Claude, 5 prompts)
--       Artifact: Readmission by state (chart, HTML)
--       Artifact: CMS readmissions extract (dataset-csv, CSV)
-- ============================================================================
