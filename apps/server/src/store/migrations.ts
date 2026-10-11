// Versioned SQL migrations, applied on boot (no CLI step). Each entry runs once inside a
// transaction and records its version in schema_version. Append new versions; never edit
// an applied one. tests/unit/core/store.test.ts checks these match store/schema.ts.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema (spec 12)",
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  address_e164 TEXT NOT NULL UNIQUE,
  display_name TEXT,
  tz TEXT,
  onboarding_step TEXT NOT NULL DEFAULT 'new',
  exit_phrase_hash TEXT,
  exit_phrase_norm TEXT,
  alert_phrase_hash TEXT,
  alert_phrase_norm TEXT,
  decoy_caller TEXT NOT NULL DEFAULT 'roommate' CHECK (decoy_caller IN ('mom','roommate','boss')),
  home_lat REAL,
  home_lng REAL,
  reply_with_voice INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE guardians (
  id TEXT PRIMARY KEY,
  address_e164 TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  stopped_at INTEGER
);

CREATE TABLE user_guardians (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guardian_id TEXT NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined','expired','revoked')),
  requested_at INTEGER NOT NULL,
  responded_at INTEGER,
  PRIMARY KEY (user_id, guardian_id)
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guardian_id TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  state TEXT NOT NULL,
  type TEXT,
  start_at INTEGER,
  end_at INTEGER,
  grace_min INTEGER NOT NULL,
  venue_text TEXT,
  venue_lat REAL,
  venue_lng REAL,
  venue_place_type TEXT,
  counterpart_name TEXT,
  counterpart_source TEXT,
  transport TEXT,
  first_time_in_person INTEGER,
  buy_or_sell TEXT,
  private_address INTEGER,
  user_nervous INTEGER NOT NULL DEFAULT 0,
  high_vigilance INTEGER NOT NULL DEFAULT 0,
  notify_guardian_start_end INTEGER NOT NULL DEFAULT 0,
  location_mode TEXT NOT NULL DEFAULT 'findmy' CHECK (location_mode IN ('findmy','pin','none')),
  ladder_step TEXT,
  ladder_class TEXT,
  ladder_trigger TEXT,
  ladder_started_at INTEGER,
  ladder_step_at INTEGER,
  escalated_at INTEGER,
  escalation_reason_json TEXT,
  guardian_ack_at INTEGER,
  arrived_at INTEGER,
  arrival_line_sent INTEGER NOT NULL DEFAULT 0,
  total_extension_min INTEGER NOT NULL DEFAULT 0,
  suppressed_until_json TEXT NOT NULL DEFAULT '{}',
  exit_word_at INTEGER,
  last_checkin_message_id TEXT,
  last_checkin_at INTEGER,
  guardian_repeat_count INTEGER NOT NULL DEFAULT 0,
  last_guardian_update_at INTEGER,
  last_guardian_update_lat REAL,
  last_guardian_update_lng REAL,
  loc_requested_at INTEGER,
  share_confirmed_at INTEGER,
  share_expires_at INTEGER,
  last_resolved_at INTEGER,
  engine_state_json TEXT NOT NULL DEFAULT '{}',
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX plans_user_state ON plans(user_id, state);

CREATE TABLE plan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX plan_events_plan ON plan_events(plan_id, at);

CREATE TABLE location_fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL NOT NULL,
  location_type TEXT NOT NULL,
  source TEXT NOT NULL,
  expires_at INTEGER,
  received_at INTEGER NOT NULL
);
CREATE INDEX location_fixes_plan ON location_fixes(plan_id, at);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  plan_id TEXT,
  payload_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX jobs_due ON jobs(status, run_at);
CREATE INDEX jobs_plan ON jobs(plan_id, status);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_message_id TEXT UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  address_e164 TEXT NOT NULL,
  plan_id TEXT,
  kind TEXT NOT NULL,
  body_redacted TEXT,
  sent_at INTEGER NOT NULL
);

CREATE TABLE processed_inbound (
  message_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

CREATE TABLE counters (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);

CREATE TABLE locks (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);
`,
  },
  {
    version: 2,
    name: "durable outbox for outbound effects (M2, I16)",
    sql: `
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  effect_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','done')),
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX outbox_pending ON outbox(status, created_at);
`,
  },
];
