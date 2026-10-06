// SQLite schema for one project's referee. Facts and claims are shared mutable
// state; the Durable Object is the only writer, so two agents cannot both win.
// Columns added after the first release, for referees created before them. Errors (column exists) are ignored.
export const UPGRADES = [
  `ALTER TABLE facts ADD COLUMN scope_json TEXT`,
  `ALTER TABLE facts ADD COLUMN replaces TEXT`,
  `ALTER TABLE facts ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'`,
  `ALTER TABLE facts ADD COLUMN retired_by TEXT`,
  `ALTER TABLE facts ADD COLUMN retired_at INTEGER`,
  `ALTER TABLE attempts ADD COLUMN base_sha TEXT`,
  `ALTER TABLE claims ADD COLUMN refreshed_from TEXT`,
  `ALTER TABLE claims ADD COLUMN refresh TEXT`,
  `ALTER TABLE claims ADD COLUMN decline_reason TEXT`,
  `ALTER TABLE facts ADD COLUMN declined_at INTEGER`,
  `ALTER TABLE facts ADD COLUMN decline_reason TEXT`,
  // A fact with no id was once accepted by declare; it can never be claimed, so drop it.
  `DELETE FROM facts WHERE id IS NULL`,
];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id           TEXT PRIMARY KEY,
  sentence     TEXT NOT NULL,
  check_json   TEXT NOT NULL,
  status       TEXT NOT NULL,          -- canon | proposed | retired | declined
  proposed_by  TEXT,                   -- claim id
  made_true_by TEXT,                   -- attempt id
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  scope_json   TEXT,                   -- globs; NULL = applies to every attempt
  replaces     TEXT,                   -- a revision: the canon fact this one retires
  origin       TEXT NOT NULL DEFAULT 'agent', -- seed | agent | backlog
  retired_by   TEXT,                   -- attempt whose acceptance retired it
  retired_at   INTEGER
);

CREATE TABLE IF NOT EXISTS attempts (
  id          TEXT PRIMARY KEY,        -- Artifacts repo name == Preview name
  claim_id    TEXT,                    -- NULL for genesis
  remote      TEXT NOT NULL,
  base_attempt  TEXT,
  base_sha    TEXT,                    -- canon commit it was forked from (for changed-file scopes)
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
  attempt_id   TEXT NOT NULL REFERENCES attempts(id),
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  refreshed_from TEXT,                 -- claim id: the behind claim the judge re-applied as this one
  refresh    TEXT                      -- the judge's refresh of this claim: started | conflict: ... | failed
);

-- The fact chain: every time a fact was checked against an attempt.
CREATE TABLE IF NOT EXISTS results (
  attempt_id TEXT NOT NULL,
  sha      TEXT NOT NULL,
  fact_id  TEXT NOT NULL,
  held     INTEGER NOT NULL,
  detail   TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, sha, fact_id)
);

CREATE TABLE IF NOT EXISTS verdicts (
  attempt_id TEXT NOT NULL,
  sha      TEXT NOT NULL,
  json     TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, sha)
);

-- Two Ready claims that can't both land: other_claim_id's attempt breaks claim_id's fact (see Referee.findClashes).
CREATE TABLE IF NOT EXISTS clashes (
  claim_id       TEXT NOT NULL,
  other_claim_id TEXT NOT NULL,
  fact_id        TEXT NOT NULL,
  detail         TEXT NOT NULL,
  at             INTEGER NOT NULL,
  PRIMARY KEY (claim_id, other_claim_id)
);

-- Canon pointer history. The highest seq is current. Promotion appends a row.
CREATE TABLE IF NOT EXISTS canon (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id      TEXT NOT NULL,
  sha           TEXT NOT NULL,
  accepted_fact TEXT,
  deployed      INTEGER NOT NULL DEFAULT 0,
  at            INTEGER NOT NULL
);
`;
