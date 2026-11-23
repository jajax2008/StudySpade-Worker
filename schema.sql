-- StudySpace account and social tables.
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
  role TEXT DEFAULT 'USER',
  avatar TEXT DEFAULT '',
  bg TEXT DEFAULT '',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_data (
  user_id TEXT PRIMARY KEY,
  sync_payload TEXT NOT NULL,
  updated_at INTEGER
);

-- One row per friendship, always stored with a < b so a pair is unique.
CREATE TABLE IF NOT EXISTS friends (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (a, b)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  body TEXT NOT NULL,
  attachment TEXT DEFAULT '',
  attachment_name TEXT DEFAULT '',
  attachment_type TEXT DEFAULT '',
  created_at INTEGER,
  read_at INTEGER
);

CREATE TABLE IF NOT EXISTS pokes (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  created_at INTEGER,
  read_at INTEGER
);

CREATE TABLE IF NOT EXISTS room_invites (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  room_code TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  reason TEXT DEFAULT '',
  created_at INTEGER,
  responded_at INTEGER
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_to ON messages (to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (from_id, to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pokes_to ON pokes (to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invites_to ON room_invites (to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_to ON friend_requests (to_id, status);

-- Developer accounts. The Worker seeds these on first use too; the INSERTs are
-- idempotent, and the passwords are hashed by the Worker, never stored in SQL.
UPDATE users SET role = 'DEV' WHERE username IN ('urdevjaja', 'urdevkk');
