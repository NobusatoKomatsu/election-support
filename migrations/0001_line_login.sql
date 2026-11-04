-- LINE ログインに対応する
--   users に line_hash（LINE の利用者 ID の HMAC）を足す。
--   表を作り直すと外部キー（ballots / sessions → users）に引っかかるため、列を足すだけにする。
--   phone_hash は「必須」のまま残し、LINE だけで登録した人には "none:" + line_hash を入れる
--   （本物の電話番号の HMAC は base64 で ":" を含まないので、重なることはない）。
ALTER TABLE users ADD COLUMN line_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_line_hash ON users(line_hash);

-- LINE で本人を確かめたあと、プロフィール入力が終わるまでの一時データ（30 分で無効）
CREATE TABLE IF NOT EXISTS line_pending (
  token_hash  TEXT PRIMARY KEY,
  line_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
