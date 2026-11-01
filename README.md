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

## 1 人 1 アカウント（SMS 認証）

- 登録時に携帯電話番号（070・080・090 のみ）へ SMS で認証コードを送り、1 番号 1 アカウントに限る
- 電話番号そのものは保存せず、秘密の鍵（`PHONE_PEPPER`）で HMAC した値だけを保存する
- 退会しても HMAC 値は残す。同じ番号で登録し直すと持ち票と投票履歴を引き継ぐので、退会→再登録で二重投票はできない
- パスワードやログインIDを忘れたら、SMS で本人確認して再設定できる（`/#/reset`）
- SMS の乱用で費用がかさまないよう、送信回数を IP ごと（1 時間 5 回）とサイト全体（1 日 500 回）で制限
- SMS の送信と照合は [Twilio Verify](https://www.twilio.com/docs/verify) を使う投票時の属性は票と一緒に記録するので、あとでプロフィールを変えても過去の集計は変わりません。

## 画面

| URL | 内容 |
|---|---|
| `/#/` | テーマ一覧 |
| `/#/register` `/#/login` | アカウント作成（SMS 認証）・ログイン |
| `/#/reset` | パスワードの再設定（SMS 認証） |
| `/#/poll/<番号>` | 投票と結果（5 秒ごとに自動更新） |
| `/#/me` | 持ち票・投票履歴・プロフィール・退会 |
| `/#/admin` | テーマ作成、CSV 書き出し（管理者トークンが必要） |

## 公開手順（GitHub Actions で自動）

`.github/workflows/deploy.yml` が、D1 の作成・テーブル作成・公開・秘密の値の登録まで行います。
Twilio の Verify サービス（名前「みんなの声」）も無ければ自動で作ります。

1. **Cloudflare の API トークンを作る**：ダッシュボード → My Profile → API Tokens → Create Token →
   テンプレート「Edit Cloudflare Workers」を選び、権限に **Account / D1 / Edit** を追加して作成
2. **Twilio 側の準備**：トライアルなら有料に切り替える。Verify → Settings → Geo permissions で **Japan** を有効にする
3. **GitHub の Secrets に登録**（リポジトリ → Settings → Secrets and variables → Actions → New repository secret）

   | 名前 | 中身 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | 1 で作ったトークン |
   | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボードの Workers 画面右側に出る Account ID |
   | `TWILIO_ACCOUNT_SID` | Twilio コンソールの Account SID（AC...） |
   | `TWILIO_AUTH_TOKEN` | Twilio コンソールの Auth Token |
   | `VOTE_ADMIN_TOKEN` | 管理画面のパスワード（長いランダム文字列） |
   | `VOTE_PHONE_PEPPER` | 電話番号を HMAC する鍵（長いランダム文字列。**一度決めたら変えない・別に控えておく**） |
   | `TWILIO_VERIFY_SID`（任意） | 既存の Verify サービスを使う場合だけ |

4. main に取り込む（または Actions 画面から「みんなの声 を Cloudflare に公開」を手動実行）。
   公開先は `https://election.support`（`wrangler.jsonc` の `routes`）。ドメインを先に同じ Cloudflare アカウントへ追加し、ネームサーバーを切り替えておくこと

## 手で公開する場合

```sh

npx wrangler login
npx wrangler d1 create minnano-koe          # 表示された database_id を wrangler.jsonc に書く
npx wrangler d1 execute minnano-koe --remote --file=schema.sql
npx wrangler secret put ADMIN_TOKEN          # 管理画面用の長いランダム文字列
npx wrangler secret put PHONE_PEPPER         # 電話番号を HMAC する長いランダム文字列（一度決めたら変えない）
npx wrangler secret put TWILIO_ACCOUNT_SID   # Twilio コンソールの Account SID
npx wrangler secret put TWILIO_AUTH_TOKEN    # Twilio コンソールの Auth Token
npx wrangler secret put TWILIO_VERIFY_SID    # Verify → Services で作ったサービスの SID（VA...）
npx wrangler deploy
```

## 手元で動かす

```sh

# SMS_DEV_MODE=1 だと SMS を送らず、認証コード 000000 で通る（本番では設定しない）
printf 'ADMIN_TOKEN=test-admin\nPHONE_PEPPER=dev-pepper\nSMS_DEV_MODE=1\n' > .dev.vars
npx wrangler d1 execute minnano-koe --local --file=schema.sql
npx wrangler dev
```

## Google に保存したい場合

管理画面から投票データを CSV（個人を特定する情報なし）で書き出し、Google スプレッドシートに読み込めます。
自動で送りたい場合は、Worker の投票処理から Google Sheets API / BigQuery に追記する処理を足します。

## 注意（本番前に検討すること）

- **SMS 認証でも完全な 1 人 1 票ではない**：複数の携帯番号（SMS 付きデータ SIM など）を持つ人は複数アカウントを作れる。
  さらに厳密にするならマイナンバーカードの公的個人認証（JPKI）が必要。
- SMS は 1 通ごとに費用がかかる（Twilio Verify の認証料 + 日本向け SMS 料金）。最新の料金は Twilio の料金ページで確認。
- `PHONE_PEPPER` をなくしたり変えたりすると、既存の番号と照合できなくなる。安全な場所に控えておく。
- ログイン試行の回数制限がない（Cloudflare の Rate Limiting ルールで追加できる）。
- 結果の自動更新は 5 秒ごとの再読み込み。利用者が増えたら結果を数秒キャッシュするとよい。
