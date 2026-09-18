CREATE TABLE motion_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('interpolate', 'act')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  prompt TEXT NOT NULL,
  duration INTEGER NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution = '480P'),
  video_url TEXT,
  width INTEGER,
  height INTEGER,
  fps REAL,
  result_duration REAL,
  cost_usd REAL,
  request_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX motion_jobs_account_created ON motion_jobs(account_id, created_at);

CREATE TABLE motion_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (account_id, day)
);
