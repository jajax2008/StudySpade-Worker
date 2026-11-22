-- StudySpace account tables.
-- Safe to run on every deploy: nothing is dropped or overwritten.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT,
  age INTEGER,
  grade_level TEXT,
  onboarding_completed INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_data (
  user_id TEXT PRIMARY KEY,
  sync_payload TEXT NOT NULL,
  updated_at INTEGER
);
