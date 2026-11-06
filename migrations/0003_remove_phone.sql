-- SMS 認証を廃止し、保存していた電話番号の HMAC を消す。
--   phone_hash は列が「必須・重複なし」なので、空にはせず、番号と関係のない値に置き換える。
--   LINE と連携済みの人 … "none:" + line_hash（LINE だけで登録した人と同じ形）
--   LINE と未連携の人 … "removed:" + id（ID とパスワードでのログインはそのまま。パスワードの再設定はできなくなる）
UPDATE users SET phone_hash = 'none:' || line_hash
  WHERE line_hash IS NOT NULL AND phone_hash NOT LIKE 'none:%';
UPDATE users SET phone_hash = 'removed:' || id
  WHERE line_hash IS NULL AND phone_hash NOT LIKE 'none:%' AND phone_hash NOT LIKE 'removed:%';
-- SMS の送信回数の記録（IP アドレス）も消す
DELETE FROM sms_log;
