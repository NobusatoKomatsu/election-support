-- 票に「どこから来たか」（X・Facebook・Instagram・LINE など）を記録する。
-- これより前の票は 'unknown'（記録開始前）になる。
ALTER TABLE ballots ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown';
