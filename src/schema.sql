-- Inventory Register: database schema (SQLite)
-- Timestamps are Unix milliseconds. Dates without time are ISO 'YYYY-MM-DD' text.

CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY,
  college_id            TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- enrolment no. / employee no.
  name                  TEXT    NOT NULL,
  email                 TEXT,
  role                  TEXT    NOT NULL CHECK (role IN ('admin','staff','faculty','student')),
  department            TEXT,
  password_hash         TEXT    NOT NULL,
  must_change_password  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  failed_logins         INTEGER NOT NULL DEFAULT 0,
  locked_until          INTEGER,
  last_login_at         INTEGER,
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS locations (
  id          INTEGER PRIMARY KEY,
  code        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('lab','classroom','office','library','hall','store','other')),
  building    TEXT,
  floor       TEXT,
  incharge_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes       TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id        INTEGER PRIMARY KEY,
  name      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  prefix    TEXT    NOT NULL UNIQUE COLLATE NOCASE CHECK (length(prefix) BETWEEN 2 AND 5),
  next_seq  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS equipment (
  id             INTEGER PRIMARY KEY,
  asset_tag      TEXT    NOT NULL UNIQUE COLLATE NOCASE,          -- e.g. PC-00042, printed on the QR label
  name           TEXT    NOT NULL,
  category_id    INTEGER NOT NULL REFERENCES categories(id),
  location_id    INTEGER NOT NULL REFERENCES locations(id),
  brand          TEXT,
  model          TEXT,
  serial_no      TEXT,
  specs          TEXT,
  purchase_date  TEXT,
  purchase_cost  INTEGER CHECK (purchase_cost IS NULL OR purchase_cost >= 0),  -- whole rupees
  vendor         TEXT,
  warranty_until TEXT,
  status         TEXT    NOT NULL DEFAULT 'working'
                 CHECK (status IN ('working','issue_reported','under_repair','retired')),
  notes          TEXT,
  retired_reason TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipment_location ON equipment(location_id);
CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment(category_id);
CREATE INDEX IF NOT EXISTS idx_equipment_status   ON equipment(status);

CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  reporter_id  INTEGER REFERENCES users(id),        -- NULL when sent from the QR label without signing in
  guest_name   TEXT,                                 -- the name that person typed (not verified)
  guest_ref    TEXT,                                 -- roll no. / employee no. as typed (not verified)
  issue_type   TEXT    NOT NULL
               CHECK (issue_type IN ('not_working','damaged','missing_part','software','network','other')),
  description  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','in_progress','resolved','rejected')),
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  CHECK (reporter_id IS NOT NULL OR guest_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_reports_equipment ON reports(equipment_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter  ON reports(reporter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_status    ON reports(status);

CREATE TABLE IF NOT EXISTS report_updates (
  id          INTEGER PRIMARY KEY,
  report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_updates_report ON report_updates(report_id);

-- Append-only record of who did what. Never updated or deleted by the application.
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor       TEXT,              -- college ID at the time of the action
  action      TEXT NOT NULL,     -- e.g. equipment.create
  entity_type TEXT,
  entity_id   INTEGER,
  summary     TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER,
  data       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
