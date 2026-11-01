-- みんなの声 データベース定義（Cloudflare D1 / SQLite）
-- 時刻はすべて UNIX ミリ秒

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id    TEXT NOT NULL UNIQUE,
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  phone_hash  TEXT NOT NULL UNIQUE, -- 携帯番号の HMAC（番号そのものは保存しない）
  birth_year  INTEGER NOT NULL,
  gender      TEXT NOT NULL,      -- male / female / other
  income      TEXT NOT NULL,      -- 年収帯のキー（worker.js の INCOME を参照）
  pension     INTEGER NOT NULL,   -- 1 = 年金を受給している
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER              -- 退会日時（退会後も phone_hash は残す）
);

-- SMS 送信の回数制限用（24 時間で消える）
CREATE TABLE IF NOT EXISTS sms_log (
  ip          TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_log ON sms_log(ip, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS polls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  opens_at    INTEGER NOT NULL,
  closes_at   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS options (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0
);

-- 1 人 1 テーマにつき 1 回。属性は投票時点のものを控えて集計に使う
CREATE TABLE IF NOT EXISTS ballots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id     INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  option_id   INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  weight      INTEGER NOT NULL,   -- +n = 賛成 n 票、-n = 反対 n 票
  created_at  INTEGER NOT NULL,
  age_group   TEXT NOT NULL,
  gender      TEXT NOT NULL,
  income      TEXT NOT NULL,
  pension     INTEGER NOT NULL,
  UNIQUE (poll_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ballots_user ON ballots(user_id);
CREATE INDEX IF NOT EXISTS idx_options_poll ON options(poll_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
