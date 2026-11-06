# みんなの声（民意を集める投票サイト）

年代・性別・年収・年金の受給状況ごとに、投票結果をリアルタイムで見える化するサイトです。
Cloudflare Workers（画面と API）と Cloudflare D1（データベース）だけで動きます。

## 票のルール

- 投票テーマが始まるたびに、全アカウントに **1 票** が配られる
- 投票しなかった票は **次に持ち越せる**（上限は `wrangler.jsonc` の `MAX_BALANCE`、初期値 3 票）
- 投票するときは、手持ちの票から何票使うか選ぶ
  - `+n` … 選択肢に賛成 n 票
  - `-n` … 選択肢に反対 n 票（マイナス票）
- 1 テーマにつき 1 回だけ。あとから変更はできない

## 集める情報

生まれた年（年代で集計）・性別・年収帯・年金の受給有無のみ。ログインには ID とパスワードを使い、
氏名やメールアドレスは聞きません。

## 1 人 1 アカウント（LINE ログイン）

- 新規登録は LINE ログインで行う。日本の LINE アカウントは電話番号ごとに 1 つなので、SMS 認証とほぼ同じ強さで、費用はかからない
- LINE から受け取るのは利用者 ID（`sub`）だけ（scope は `openid` のみ）。それも `PHONE_PEPPER` で HMAC した値だけを保存する
- 退会しても HMAC は残す。同じ LINE で登録し直すと持ち票と投票履歴を引き継ぐので、退会→再登録で二重投票はできない
- 以前 SMS で登録した人は ID とパスワードでログインでき、マイページから LINE と連携できる
- SMS 認証（Twilio）は廃止した。保存していた電話番号の HMAC と送信記録は migration 0003 で削除済み（パスワードの再設定はできない）
- 登録とパスワードでのログインには Cloudflare Turnstile（ロボット対策）をかける
- データベースの変更は `migrations/` に置き、公開のたびに `wrangler d1 migrations apply` でまだのものだけ当てる

## 画面

| URL | 内容 |
|---|---|
| `/#/` | テーマ一覧 |
| `/#/register` `/#/login` | アカウント作成（LINE ログイン）・ログイン |
| `/#/poll/<番号>` | 投票と結果（5 秒ごとに自動更新） |
| `/#/me` | 持ち票・投票履歴・プロフィール・退会 |
| `/#/admin` | テーマの一覧・作成・編集・削除、CSV 書き出し（管理者トークンが必要） |

## 公開手順（GitHub Actions で自動）

`.github/workflows/deploy.yml` が、D1 の作成・テーブル作成・公開・秘密の値の登録まで行います。

1. **Cloudflare の API トークンを作る**：ダッシュボード → My Profile → API Tokens → Create Token →
   テンプレート「Edit Cloudflare Workers」を選び、権限に **Account / D1 / Edit** を追加して作成
3. **GitHub の Secrets に登録**（リポジトリ → Settings → Secrets and variables → Actions → New repository secret）

   | 名前 | 中身 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 1 で作ったトークン |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボードの Workers 画面右側に出る Account ID |
   | `VOTE_ADMIN_TOKEN` | 管理画面のパスワード（長いランダム文字列） |
   | `VOTE_PHONE_PEPPER` | LINE の利用者 ID を HMAC する鍵（長いランダム文字列。**一度決めたら変えない・別に控えておく**） |
   | `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` | LINE Developers の LINE ログインチャネルの Channel ID / Channel secret（未登録なら LINE ログインは「準備中」） |
   | `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile のサイトキー / シークレットキー（未登録ならロボット対策なし） |

4. main に取り込む（または Actions 画面から「みんなの声 を Cloudflare に公開」を手動実行）。
   公開先は `https://election.support`（`wrangler.jsonc` の `routes`）。ドメインを先に同じ Cloudflare アカウントへ追加し、ネームサーバーを切り替えておくこと

## 手で公開する場合

```sh
npx wrangler login
npx wrangler d1 create minnano-koe          # 表示された database_id を wrangler.jsonc に書く
npx wrangler d1 execute minnano-koe --remote --file=schema.sql
npx wrangler secret put ADMIN_TOKEN          # 管理画面用の長いランダム文字列
npx wrangler secret put PHONE_PEPPER         # LINE の利用者 ID を HMAC する長いランダム文字列（一度決めたら変えない）
npx wrangler deploy
```

## 手元で動かす

```sh
# LINE_DEV_MODE=1 だと LINE に行かず架空の利用者で戻る（本番では設定しない）
printf 'ADMIN_TOKEN=test-admin\nPHONE_PEPPER=dev-pepper\nLINE_DEV_MODE=1\n' > .dev.vars
npx wrangler d1 migrations apply minnano-koe --local
npx wrangler d1 execute minnano-koe --local --file=schema.sql
npx wrangler dev
```

## Google に保存したい場合

管理画面から投票データを CSV（個人を特定する情報なし）で書き出し、Google スプレッドシートに読み込めます。
自動で送りたい場合は、Worker の投票処理から Google Sheets API / BigQuery に追記する処理を足します。

## 注意（本番前に検討すること）

- **LINE ログインでも完全な 1 人 1 票ではない**：複数の電話番号（＝複数の LINE アカウント）を持つ人は複数アカウントを作れる。
  さらに厳密にするならマイナンバーカードの公的個人認証（JPKI）が必要。
- `PHONE_PEPPER` をなくしたり変えたりすると、既存の番号と照合できなくなる。安全な場所に控えておく。
- ログイン試行の回数制限がない（Cloudflare の Rate Limiting ルールで追加できる）。
- 結果の自動更新は 5 秒ごとの再読み込み。利用者が増えたら結果を数秒キャッシュするとよい。

## 管理アプリ（Android）

`android/` は、テーマの一覧・作成・編集・削除ができる管理者専用のアプリ。初回起動時に管理者トークン（`VOTE_ADMIN_TOKEN`）を入力する。

- main に `android/` の変更が入ると、GitHub Actions がビルドしてリリース「admin-app」に `election-admin.apk` を置く
- 署名の鍵を固定したい場合は Secrets に `ADMIN_APP_KEYSTORE_B64`（PKCS12 を base64 にしたもの、別名 `electionadmin`）と
  `ADMIN_APP_KEYSTORE_PASSWORD` を登録する。無い場合はビルドごとに鍵が変わるので、更新するときは一度アンインストールする

## 編集・削除のルール

- 投票が入っている選択肢は削除できない（名前の変更や選択肢の追加はできる）
- 投票が入っているテーマは受付開始日時を変えられない（票の配布に使っているため）。終了日時は変えられる
- テーマを削除すると、そのテーマの投票も消え、配った票・使った票もなかったことになる
