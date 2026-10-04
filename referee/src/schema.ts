// SQLite schema for one project's referee. Facts and claims are shared mutable
// state; the Durable Object is the only writer, so two agents cannot both win.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id           TEXT PRIMARY KEY,
  sentence     TEXT NOT NULL,
  check_json   TEXT NOT NULL,
  status       TEXT NOT NULL,          -- canon | proposed | retired
  proposed_by  TEXT,                   -- claim id
  made_true_by TEXT,                   -- world id
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER
);

CREATE TABLE IF NOT EXISTS worlds (
  id          TEXT PRIMARY KEY,        -- Artifacts repo name == Preview name
  claim_id    TEXT,                    -- NULL for genesis
  remote      TEXT NOT NULL,
  base_world  TEXT,
  head_sha    TEXT,
  preview_url TEXT,
  frozen      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id         TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  fact_id    TEXT NOT NULL REFERENCES facts(id),
  why        TEXT NOT NULL,
  world_id   TEXT NOT NULL REFERENCES worlds(id),
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- The fact chain: every time a fact was checked against a world.
CREATE TABLE IF NOT EXISTS results (
  world_id TEXT NOT NULL,
  sha      TEXT NOT NULL,
  fact_id  TEXT NOT NULL,
  held     INTEGER NOT NULL,
  detail   TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (world_id, sha, fact_id)
);

CREATE TABLE IF NOT EXISTS verdicts (
  world_id TEXT NOT NULL,
  sha      TEXT NOT NULL,
  json     TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (world_id, sha)
);

-- Canon pointer history. The highest seq is current. Promotion appends a row.
CREATE TABLE IF NOT EXISTS canon (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id      TEXT NOT NULL,
  sha           TEXT NOT NULL,
  accepted_fact TEXT,
  deployed      INTEGER NOT NULL DEFAULT 0,
  at            INTEGER NOT NULL
);
`;
