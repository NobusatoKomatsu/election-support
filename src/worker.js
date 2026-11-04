// みんなの声 — API（Cloudflare Workers + D1）
//
// 票のルール
//   - 投票テーマが始まるたびに、全アカウントに 1 票が配られる
//   - 投票しなければその票は次へ持ち越される（上限 MAX_BALANCE 票）
//   - 投票するときは、手持ちの票から何票使うかを選ぶ
//       +n … 選択肢に賛成 n 票
//       -n … 選択肢に反対 n 票（マイナス票）
//   - 1 テーマにつき 1 回だけ投票でき、あとから変えられない
//
// 1 人 1 アカウント
//   - 新規登録は LINE ログインで行う（日本の LINE アカウントは電話番号ごとに 1 つなので、SMS 認証とほぼ同じ強さ）
//   - LINE から受け取るのは利用者 ID（sub）だけ。それも秘密の鍵で HMAC した値だけを保存する
//   - 以前 SMS で登録した人は、ID とパスワードでログインでき、マイページから LINE と連携できる
//   - 退会しても HMAC は残し、同じ LINE（番号）で登録し直すと持ち票と投票履歴を引き継ぐ（二重投票の防止）
//   - 登録とパスワードでのログインには Cloudflare Turnstile（ロボット対策）をかける

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // Workers の上限

export const GENDER = { male: '男性', female: '女性', other: 'その他・回答しない' };
export const INCOME = {
  none: '収入なし',
  u200: '200万円未満',
  u400: '200〜400万円',
  u600: '400〜600万円',
  u800: '600〜800万円',
  u1000: '800〜1,000万円',
  o1000: '1,000万円以上',
};
export const PENSION = { 1: '受給している', 0: '受給していない' };

// ---------- 共通 ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
const fail = (message, status = 400) => json({ error: message }, status);
// 利用者に見せてよいエラー（入力ミスなど）
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
function randomB64(n) {
  return b64(crypto.getRandomValues(new Uint8Array(n))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(text) {
  return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
async function hashPassword(password, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
  return b64(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- SMS 認証 ----------

// 日本の携帯番号（070 / 080 / 090）だけを受け付ける。固定電話や海外番号への送信で費用がかさむのを防ぐ
export function normalizePhone(input) {
  let d = String(input || '').replace(/[\s\-()（）ー－]/g, '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (d.startsWith('+81')) d = '0' + d.slice(3);
  if (!/^0[789]0\d{8}$/.test(d)) throw bad('携帯電話番号（070・080・090 から始まる 11 桁）を入力してください');
  return '+81' + d.slice(1);
}

async function phoneHash(env, e164) {
  if (!env.PHONE_PEPPER) throw new Error('PHONE_PEPPER が設定されていません');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PHONE_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(e164)));
}

const devSms = (env) => env.SMS_DEV_MODE === '1';

// ---------- LINE ログイン ----------

const LINE_AUTHORIZE = 'https://access.line.me/oauth2/v2.1/authorize';
const LINE_TOKEN = 'https://api.line.me/oauth2/v2.1/token';
const LINE_VERIFY = 'https://api.line.me/oauth2/v2.1/verify';
const lineEnabled = (env) => Boolean(env.LINE_CHANNEL_ID && env.LINE_CHANNEL_SECRET) || env.LINE_DEV_MODE === '1';

async function lineHash(env, sub) {
  // 電話番号と同じ鍵を使うが、先頭に "line:" を付けて別物として扱う
  return phoneHash(env, `line:${sub}`);
}

function tempCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/api/line; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// LINE の認可画面へ送る。mode=link はログイン中の人が LINE を連携するとき
async function lineStart(request, env) {
  if (!lineEnabled(env)) return Response.redirect(new URL('/?line_error=disabled#/login', request.url).toString(), 302);
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') === 'link' ? 'link' : 'login';
  const state = randomB64(24);
  const nonce = randomB64(24);
  const redirectUri = new URL('/api/line/callback', request.url).toString();
  let target;
  if (env.LINE_DEV_MODE === '1') {
    // 開発用: LINE に行かず、架空の利用者 ID（?dev_sub=）で戻ってくる
    target = `${redirectUri}?code=dev&state=${state}&dev_sub=${encodeURIComponent(url.searchParams.get('dev_sub') || 'U-dev-user')}`;
  } else {
    const q = new URLSearchParams({
      response_type: 'code', client_id: env.LINE_CHANNEL_ID, redirect_uri: redirectUri,
      state, scope: 'openid', nonce,
    });
    target = `${LINE_AUTHORIZE}?${q}`;
  }
  const headers = new Headers({ location: target, 'cache-control': 'no-store' });
  headers.append('set-cookie', tempCookie('line_oauth', `${state}.${nonce}.${mode}`, 600));
  return new Response(null, { status: 302, headers });
}

async function lineSubFromCode(env, request, code, nonce) {
  if (env.LINE_DEV_MODE === '1') return { sub: new URL(request.url).searchParams.get('dev_sub') || 'U-dev-user' };
  const redirectUri = new URL('/api/line/callback', request.url).toString();
  const tokenRes = await fetch(LINE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: env.LINE_CHANNEL_ID, client_secret: env.LINE_CHANNEL_SECRET,
    }),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.id_token) {
    console.error('LINE token failed', tokenRes.status, token.error, token.error_description);
    return { error: `token_${token.error || tokenRes.status}` };
  }
  // ID トークンの署名・有効期限・nonce は LINE の検証 API に確かめてもらう
  const verifyRes = await fetch(LINE_VERIFY, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: token.id_token, client_id: env.LINE_CHANNEL_ID, nonce }),
  });
  const claims = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok || !claims.sub) {
    console.error('LINE verify failed', verifyRes.status, claims.error, claims.error_description);
    return { error: `idtoken_${claims.error || verifyRes.status}` };
  }
  return { sub: claims.sub };
}

// LINE から戻ってきたところ。登録済みならログイン、未登録ならプロフィール入力へ
async function lineCallback(request, env, user) {
  const url = new URL(request.url);
  // 結果は ?line_error=… / ?line_ok=… で画面に伝える
  const back = (hash, param) => {
    const to = new URL(`/${param ? `?${param}` : ''}#/${hash}`, request.url).toString();
    const headers = new Headers({ location: to, 'cache-control': 'no-store' });
    headers.append('set-cookie', tempCookie('line_oauth', '', 0));
    return { headers, res: () => new Response(null, { status: 302, headers }) };
  };
  const [state, nonce, mode] = (getCookie(request, 'line_oauth') || '').split('.');
  if (url.searchParams.get('error')) return back('login', 'line_error=cancel').res();
  if (!state || !safeEqual(state, url.searchParams.get('state') || '')) return back('login', 'line_error=state').res();
  const got = await lineSubFromCode(env, request, url.searchParams.get('code') || '', nonce);
  // 失敗の理由（invalid_client など）も画面に渡して、原因を調べやすくする
  if (!got.sub) return back('login', `line_error=verify&detail=${encodeURIComponent(String(got.error).slice(0, 60))}`).res();
  const sub = got.sub;
  const hash = await lineHash(env, sub);
  const owner = await env.DB.prepare('SELECT id, deleted_at FROM users WHERE line_hash = ?').bind(hash).first();

  if (mode === 'link') {
    if (!user) return back('login', 'line_error=login').res();
    if (owner && owner.id !== user.id) return back('me', 'line_error=linked_other').res();
    await env.DB.prepare('UPDATE users SET line_hash = ? WHERE id = ?').bind(hash, user.id).run();
    return back('me', 'line_ok=linked').res();
  }

  if (owner && !owner.deleted_at) {
    const r = back('');
    r.headers.append('set-cookie', await createSession(env, owner.id));
    return r.res();
  }
  // 新規（または退会後の再登録）: プロフィール入力を待つ
  const token = randomB64(32);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM line_pending WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO line_pending (token_hash, line_hash, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256(token), hash, Date.now() + 30 * 60000),
  ]);
  const r = back('line-register');
  r.headers.append('set-cookie', `line_pending=${token}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`);
  return r.res();
}

// LINE で確かめた人のプロフィールを受け取り、アカウントを作る
async function lineRegister(request, env) {
  const body = await readBody(request);
  await checkTurnstile(request, env, body.turnstile);
  const profile = validateProfile(body);
  const token = getCookie(request, 'line_pending');
  const pending = token && await env.DB.prepare('SELECT line_hash FROM line_pending WHERE token_hash = ? AND expires_at > ?')
    .bind(await sha256(token), Date.now()).first();
  if (!pending) throw bad('時間が経ちすぎました。もう一度「LINE で登録」から始めてください', 410);
  const owner = await env.DB.prepare('SELECT id, deleted_at FROM users WHERE line_hash = ?').bind(pending.line_hash).first();
  if (owner && !owner.deleted_at) throw bad('この LINE アカウントは登録済みです。ログインしてください', 409);
  let userId;
  if (owner) {
    await env.DB.prepare(
      `UPDATE users SET login_id = ?, birth_year = ?, gender = ?, income = ?, pension = ?, deleted_at = NULL WHERE id = ?`
    ).bind(`line-${owner.id}`, profile.birth_year, profile.gender, profile.income, profile.pension, owner.id).run();
    userId = owner.id;
  } else {
    // ログイン ID とパスワードは使わない（LINE でログインする）。表示用の ID だけ付ける
    const res = await env.DB.prepare(
      `INSERT INTO users (login_id, pw_hash, pw_salt, phone_hash, line_hash, birth_year, gender, income, pension, created_at)
       VALUES (?, '', '', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(`line-${randomB64(9)}`, `none:${pending.line_hash}`, pending.line_hash, profile.birth_year, profile.gender, profile.income, profile.pension, Date.now()).run();
    userId = res.meta.last_row_id;
    await env.DB.prepare('UPDATE users SET login_id = ? WHERE id = ?').bind(`line-${userId}`, userId).run();
  }
  await env.DB.prepare('DELETE FROM line_pending WHERE token_hash = ?').bind(await sha256(token)).run();
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  headers.append('set-cookie', await createSession(env, userId));
  headers.append('set-cookie', 'line_pending=; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return new Response(JSON.stringify({ ok: true, restored: Boolean(owner) }), { status: 201, headers });
}

// ---------- Cloudflare Turnstile（ロボット対策） ----------

async function checkTurnstile(request, env, token) {
  if (!env.TURNSTILE_SECRET_KEY) return; // 未設定（開発環境など）なら確認しない
  if (!token) throw bad('ロボットでないことの確認が終わっていません。少し待ってからもう一度押してください');
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: String(token),
      remoteip: request.headers.get('cf-connecting-ip') || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.success) throw bad('ロボットでないことを確認できませんでした。ページを読み込み直してからお試しください');
}

// 画面側で使う公開設定
function siteConfig(env) {
  return json({
    line: lineEnabled(env),
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null,
    sms_reset: Boolean(env.TWILIO_ACCOUNT_SID) || devSms(env),
  });
}

async function twilio(env, path, params) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_VERIFY_SID) {
    throw new Error('Twilio の設定（TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SID）がありません');
  }
  const res = await fetch(`https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SID}/${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function sendSmsCode(env, e164) {
  if (devSms(env)) {
    console.log(`[SMS 開発モード] ${e164} に認証コード 000000 を送ったことにします`);
    return;
  }
  const r = await twilio(env, 'Verifications', { To: e164, Channel: 'sms', Locale: 'ja' });
  if (r.status === 429 || r.data.code === 60203) throw bad('この番号への送信回数が多すぎます。しばらくしてからお試しください', 429);
  if (!r.ok) {
    console.error('Twilio send failed', r.status, r.data);
    throw bad('SMS を送れませんでした。番号を確かめてください');
  }
}

async function checkSmsCode(env, e164, code) {
  code = String(code || '').trim();
  if (!/^\d{4,10}$/.test(code)) throw bad('SMS で届いた認証コードを入力してください');
  if (devSms(env)) {
    if (code !== '000000') throw bad('認証コードが違います');
    return;
  }
  const r = await twilio(env, 'VerificationCheck', { To: e164, Code: code });
  if (!r.ok || r.data.status !== 'approved') throw bad('認証コードが違うか、有効期限が切れています');
}

// SMS 送信の乱用（大量送信で費用を発生させる攻撃）を防ぐため、IP ごと・全体で回数を制限する
async function limitSms(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const now = Date.now();
  const perIp = Number(env.SMS_LIMIT_PER_IP_HOUR || 5);
  const perDay = Number(env.SMS_LIMIT_PER_DAY || 500);
  const [ipCount, dayCount] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM sms_log WHERE ip = ? AND created_at > ?').bind(ip, now - 3600000),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sms_log WHERE created_at > ?').bind(now - 86400000),
  ]);
  if (ipCount.results[0].n >= perIp) throw bad('送信回数が多すぎます。1 時間ほどしてからお試しください', 429);
  if (dayCount.results[0].n >= perDay) throw bad('本日の SMS 送信数が上限に達しました。明日お試しください', 429);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sms_log (ip, created_at) VALUES (?, ?)').bind(ip, now),
    env.DB.prepare('DELETE FROM sms_log WHERE created_at < ?').bind(now - 86400000),
  ]);
}

export function ageGroup(birthYear, now = Date.now()) {
  const age = new Date(now).getFullYear() - birthYear;
  if (age < 20) return '〜19歳';
  if (age >= 70) return '70歳以上';
  return `${Math.floor(age / 10) * 10}代`;
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
function sessionCookie(token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function readBody(request) {
  // JSON 以外の POST を受け付けないことで、他サイトのフォームからの送信（CSRF）を防ぐ
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw bad('JSON で送信してください');
  try {
    return await request.json();
  } catch {
    throw bad('JSON の形式が正しくありません');
  }
}

async function currentUser(request, env) {
  const token = getCookie(request, 'sid');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL`
  ).bind(await sha256(token), Date.now()).first();
  return row || null;
}

async function createSession(env, userId) {
  const token = randomB64(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, Date.now() + SESSION_DAYS * 86400000).run();
  return sessionCookie(token, SESSION_DAYS * 86400);
}

function validateProfile(body) {
  const year = new Date().getFullYear();
  const birthYear = Number(body.birth_year);
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > year) throw bad('生まれた年を正しく入力してください');
  if (!Object.hasOwn(GENDER, String(body.gender))) throw bad('性別を選んでください');
  if (!Object.hasOwn(INCOME, String(body.income))) throw bad('年収を選んでください');
  if (!Object.hasOwn(PENSION, String(body.pension))) throw bad('年金の受給状況を選んでください');
  return { birth_year: birthYear, gender: body.gender, income: body.income, pension: Number(body.pension) };
}

function publicUser(u) {
  return {
    login_id: u.login_id,
    birth_year: u.birth_year,
    gender: u.gender,
    income: u.income,
    pension: u.pension,
    age_group: ageGroup(u.birth_year),
  };
}

// ---------- 持ち票の計算 ----------

// 「配布」と「使用」を時刻順に並べて残高を出す。配布時に上限を超えた分は切り捨て。
export function computeBalance({ userCreatedAt, polls, ballots, max, now = Date.now() }) {
  const events = [];
  for (const p of polls) {
    if (p.opens_at > now || p.closes_at <= userCreatedAt) continue; // まだ始まっていない／登録前に終わった
    events.push({ t: Math.max(p.opens_at, userCreatedAt), kind: 0 });
  }
  for (const b of ballots) events.push({ t: b.created_at, kind: 1, cost: Math.abs(b.weight) });
  events.sort((a, b) => a.t - b.t || a.kind - b.kind);
  let balance = 0;
  for (const e of events) {
    if (e.kind === 0) balance = Math.min(max, balance + 1);
    else balance -= e.cost;
  }
  return Math.max(0, balance);
}

async function balanceOf(env, user, now = Date.now()) {
  const [polls, ballots] = await env.DB.batch([
    env.DB.prepare('SELECT opens_at, closes_at FROM polls'),
    env.DB.prepare('SELECT weight, created_at FROM ballots WHERE user_id = ?').bind(user.id),
  ]);
  return computeBalance({
    userCreatedAt: user.created_at,
    polls: polls.results,
    ballots: ballots.results,
    max: Number(env.MAX_BALANCE || 3),
    now,
  });
}

// ---------- ハンドラ ----------

// 手順 1: 認証コードを送る（purpose = register / reset）
async function smsStart(request, env) {
  const body = await readBody(request);
  if (body.purpose !== 'reset' && env.SMS_REGISTER !== '1') throw bad('新規登録は「LINE で登録」からお願いします', 410);
  await checkTurnstile(request, env, body.turnstile);
  const e164 = normalizePhone(body.phone);
  const hash = await phoneHash(env, e164);
  const owner = await env.DB.prepare('SELECT deleted_at FROM users WHERE phone_hash = ?').bind(hash).first();
  if (body.purpose === 'reset') {
    if (!owner || owner.deleted_at) return fail('この電話番号のアカウントはありません', 404);
  } else if (owner && !owner.deleted_at) {
    return fail('この電話番号は登録済みです。パスワードを忘れた場合は「パスワードの再設定」から', 409);
  }
  await limitSms(request, env);
  await sendSmsCode(env, e164);
  return json({ ok: true });
}

function validateCredentials(body) {
  const loginId = String(body.login_id || '').trim();
  const password = String(body.password || '');
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(loginId)) throw bad('ログインIDは半角英数字と _ . - で 3〜32 文字にしてください');
  if (password.length < 8) throw bad('パスワードは 8 文字以上にしてください');
  return { loginId, password };
}

async function newPassword(password) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await hashPassword(password, salt) };
}

// 手順 2: 認証コードと一緒にアカウントを作る
async function register(request, env) {
  const body = await readBody(request);
  if (env.SMS_REGISTER !== '1') throw bad('新規登録は「LINE で登録」からお願いします', 410);
  const { loginId, password } = validateCredentials(body);
  const profile = validateProfile(body);
  const e164 = normalizePhone(body.phone);
  const hash = await phoneHash(env, e164);
  const owner = await env.DB.prepare('SELECT id, deleted_at FROM users WHERE phone_hash = ?').bind(hash).first();
  if (owner && !owner.deleted_at) return fail('この電話番号は登録済みです', 409);
  const taken = await env.DB.prepare('SELECT id FROM users WHERE login_id = ?').bind(loginId).first();
  if (taken && taken.id !== owner?.id) return fail('このログインIDは使われています', 409);
  // 入力をすべて確かめてからコードを照合する（照合するとコードは使い切りになるため）
  await checkSmsCode(env, e164, body.code);
  const pw = await newPassword(password);
  let userId;
  if (owner) {
    // 退会した番号での再登録: 持ち票と投票履歴を引き継ぐ
    await env.DB.prepare(
      `UPDATE users SET login_id = ?, pw_hash = ?, pw_salt = ?, birth_year = ?, gender = ?, income = ?, pension = ?, deleted_at = NULL
        WHERE id = ?`
    ).bind(loginId, pw.hash, pw.salt, profile.birth_year, profile.gender, profile.income, profile.pension, owner.id).run();
    userId = owner.id;
  } else {
    const res = await env.DB.prepare(
      `INSERT INTO users (login_id, pw_hash, pw_salt, phone_hash, birth_year, gender, income, pension, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(loginId, pw.hash, pw.salt, hash, profile.birth_year, profile.gender, profile.income, profile.pension, Date.now()).run();
    userId = res.meta.last_row_id;
  }
  const cookie = await createSession(env, userId);
  return json({ ok: true, restored: Boolean(owner) }, 201, { 'set-cookie': cookie });
}

// パスワードを忘れたとき: SMS で本人確認してパスワードを付け直す（ログインIDも表示する）
async function resetPassword(request, env) {
  const body = await readBody(request);
  const password = String(body.password || '');
  if (password.length < 8) throw bad('パスワードは 8 文字以上にしてください');
  const e164 = normalizePhone(body.phone);
  const user = await env.DB.prepare('SELECT id, login_id FROM users WHERE phone_hash = ? AND deleted_at IS NULL')
    .bind(await phoneHash(env, e164)).first();
  if (!user) return fail('この電話番号のアカウントはありません', 404);
  await checkSmsCode(env, e164, body.code);
  const pw = await newPassword(password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').bind(pw.hash, pw.salt, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  return json({ ok: true, login_id: user.login_id }, 200, { 'set-cookie': await createSession(env, user.id) });
}

async function login(request, env) {
  const body = await readBody(request);
  await checkTurnstile(request, env, body.turnstile);
  const user = await env.DB.prepare('SELECT * FROM users WHERE login_id = ? AND deleted_at IS NULL').bind(String(body.login_id || '').trim()).first();
  // ID が無い場合も同じだけ計算して、応答時間で ID の有無が分からないようにする
  const hash = await hashPassword(String(body.password || ''), user ? user.pw_salt : 'AAAAAAAAAAAAAAAAAAAAAA==');
  if (!user || !safeEqual(hash, user.pw_hash)) return fail('ログインIDかパスワードが違います', 401);
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
  return json({ ok: true }, 200, { 'set-cookie': await createSession(env, user.id) });
}

async function logout(request, env) {
  const token = getCookie(request, 'sid');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

async function me(request, env, user) {
  if (!user) return json({ user: null, max_balance: Number(env.MAX_BALANCE || 3) });
  const history = await env.DB.prepare(
    `SELECT b.poll_id, b.weight, b.created_at, p.title, o.label
       FROM ballots b JOIN polls p ON p.id = b.poll_id JOIN options o ON o.id = b.option_id
      WHERE b.user_id = ? ORDER BY b.created_at DESC`
  ).bind(user.id).all();
  return json({
    user: { ...publicUser(user), line_linked: Boolean(user.line_hash), has_password: Boolean(user.pw_hash) },
    balance: await balanceOf(env, user),
    max_balance: Number(env.MAX_BALANCE || 3),
    history: history.results,
  });
}

async function updateProfile(request, env, user) {
  const profile = validateProfile(await readBody(request));
  await env.DB.prepare('UPDATE users SET birth_year = ?, gender = ?, income = ?, pension = ? WHERE id = ?')
    .bind(profile.birth_year, profile.gender, profile.income, profile.pension, user.id).run();
  return json({ ok: true });
}

async function deleteAccount(request, env, user) {
  // ログインID・パスワード・プロフィールは消す。電話番号・LINE の HMAC と投票済みの票は残す
  // （票を消すと結果が後から変わり、番号を消すと再登録で同じテーマに二重投票できてしまうため）
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    env.DB.prepare(
      `UPDATE users SET login_id = ?, pw_hash = '', pw_salt = '', birth_year = 0, gender = '', income = '', pension = 0, deleted_at = ?
        WHERE id = ?`
    ).bind(`deleted-${user.id}`, Date.now(), user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

function pollStatus(p, now = Date.now()) {
  if (now < p.opens_at) return 'upcoming';
  if (now >= p.closes_at) return 'closed';
  return 'open';
}

async function listPolls(request, env, user) {
  const polls = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM ballots b WHERE b.poll_id = p.id) AS voters
       FROM polls p ORDER BY p.opens_at DESC LIMIT 100`
  ).all();
  let voted = new Set();
  if (user) {
    const rows = await env.DB.prepare('SELECT poll_id FROM ballots WHERE user_id = ?').bind(user.id).all();
    voted = new Set(rows.results.map((r) => r.poll_id));
  }
  return json({
    polls: polls.results.map((p) => ({ ...p, status: pollStatus(p), voted: voted.has(p.id) })),
  });
}

async function getPoll(env, id) {
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  if (!poll) return null;
  const options = await env.DB.prepare('SELECT id, label FROM options WHERE poll_id = ? ORDER BY sort, id').bind(id).all();
  return { ...poll, status: pollStatus(poll), options: options.results };
}

async function showPoll(request, env, user, id) {
  const poll = await getPoll(env, id);
  if (!poll) return fail('投票テーマが見つかりません', 404);
  let myBallot = null;
  let balance = null;
  if (user) {
    myBallot = await env.DB.prepare('SELECT option_id, weight, created_at FROM ballots WHERE poll_id = ? AND user_id = ?')
      .bind(id, user.id).first();
    balance = await balanceOf(env, user);
  }
  return json({ poll, my_ballot: myBallot, balance });
}

async function vote(request, env, user, id) {
  const body = await readBody(request);
  const poll = await getPoll(env, id);
  if (!poll) return fail('投票テーマが見つかりません', 404);
  if (poll.status !== 'open') return fail('この投票は受付期間外です', 409);
  const option = poll.options.find((o) => o.id === Number(body.option_id));
  if (!option) throw bad('選択肢を選んでください');
  const weight = Number(body.weight);
  if (!Number.isInteger(weight) || weight === 0) throw bad('票数を選んでください');
  const already = await env.DB.prepare('SELECT 1 FROM ballots WHERE poll_id = ? AND user_id = ?').bind(id, user.id).first();
  if (already) return fail('このテーマにはもう投票しています', 409);
  const now = Date.now();
  const balance = await balanceOf(env, user, now);
  if (Math.abs(weight) > balance) return fail(`持ち票は ${balance} 票です`, 409);
  try {
    await env.DB.prepare(
      `INSERT INTO ballots (poll_id, user_id, option_id, weight, created_at, age_group, gender, income, pension)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, user.id, option.id, weight, now, ageGroup(user.birth_year, now), user.gender, user.income, user.pension).run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) return fail('このテーマにはもう投票しています', 409);
    throw e;
  }
  return json({ ok: true, balance: balance - Math.abs(weight) });
}

// 集計結果。属性別とかけ合わせは、人数が少ない区分（MIN_GROUP_SIZE 人未満、初期値 5）を出さない
// （「70歳以上・年収1,000万円以上・年金なし＝1人」のような区分から、誰がどう投票したか分かってしまうため）
const DIM_KEYS = ['age_group', 'gender', 'income', 'pension'];

async function results(request, env, id) {
  const poll = await getPoll(env, id);
  if (!poll) return fail('投票テーマが見つかりません', 404);
  const rows = (await env.DB.prepare(
    'SELECT option_id, weight, age_group, gender, income, pension FROM ballots WHERE poll_id = ?'
  ).bind(id).all()).results;
  const minGroup = Math.max(1, Number(env.MIN_GROUP_SIZE || 5));

  // plus / minus … 票数、plus_voters / minus_voters … 賛成・反対した人数、voters … その選択肢に投票した人数
  const blank = () => Object.fromEntries(poll.options.map((o) => [o.id, { plus: 0, minus: 0, voters: 0, plus_voters: 0, minus_voters: 0 }]));
  const add = (bucket, r) => {
    const t = bucket[r.option_id];
    if (!t) return;
    if (r.weight > 0) { t.plus += r.weight; t.plus_voters += 1; } else { t.minus += -r.weight; t.minus_voters += 1; }
    t.voters += 1;
  };
  const group = (map, key, r) => {
    map[key] ??= { voters: 0, options: blank() };
    map[key].voters += 1;
    add(map[key].options, r);
  };
  const hideSmall = (map) => {
    for (const [k, g] of Object.entries(map)) if (g.voters < minGroup) map[k] = { hidden: true };
    return map;
  };

  const totals = blank();
  const breakdown = Object.fromEntries(DIM_KEYS.map((d) => [d, {}]));
  const cross = {};
  for (let i = 0; i < DIM_KEYS.length; i++) for (let j = i + 1; j < DIM_KEYS.length; j++) cross[`${DIM_KEYS[i]}|${DIM_KEYS[j]}`] = {};
  for (const r of rows) {
    add(totals, r);
    for (const d of DIM_KEYS) group(breakdown[d], String(r[d]), r);
    for (const pair of Object.keys(cross)) {
      const [a, b] = pair.split('|');
      group(cross[pair], `${r[a]}|${r[b]}`, r);
    }
  }
  for (const d of DIM_KEYS) hideSmall(breakdown[d]);
  for (const pair of Object.keys(cross)) hideSmall(cross[pair]);
  return json({
    poll,
    voters: rows.length,
    totals,
    breakdown,
    cross,
    min_group: minGroup,
    labels: { gender: GENDER, income: INCOME, pension: PENSION },
    updated_at: Date.now(),
  });
}

// ---------- 管理者 ----------

function isAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  return Boolean(env.ADMIN_TOKEN) && safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`);
}

function validatePollFields(body) {
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const opensAt = Number(body.opens_at);
  const closesAt = Number(body.closes_at);
  if (!title || title.length > 200) throw bad('タイトルを 200 文字以内で入力してください');
  if (description.length > 5000) throw bad('説明は 5,000 文字以内にしてください');
  if (!(opensAt > 0 && closesAt > opensAt)) throw bad('受付期間を正しく入力してください（終了は開始より後）');
  return { title, description, opensAt, closesAt };
}

async function createPoll(request, env) {
  const body = await readBody(request);
  const { title, description, opensAt, closesAt } = validatePollFields(body);
  const options = (Array.isArray(body.options) ? body.options : [])
    .map((o) => String(typeof o === 'object' && o !== null ? o.label : o).trim()).filter(Boolean);
  if (options.length < 2 || options.length > 20) throw bad('選択肢は 2〜20 個にしてください');
  const res = await env.DB.prepare(
    'INSERT INTO polls (title, description, opens_at, closes_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(title, description, opensAt, closesAt, Date.now()).run();
  const pollId = res.meta.last_row_id;
  await env.DB.batch(options.map((label, i) =>
    env.DB.prepare('INSERT INTO options (poll_id, label, sort) VALUES (?, ?, ?)').bind(pollId, label, i)));
  return json({ ok: true, id: pollId }, 201);
}

// 管理用の一覧（選択肢ごとの投票人数つき）
async function adminListPolls(env) {
  const [polls, options, counts] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM polls ORDER BY opens_at DESC'),
    env.DB.prepare('SELECT id, poll_id, label FROM options ORDER BY sort, id'),
    env.DB.prepare('SELECT option_id, COUNT(*) AS n FROM ballots GROUP BY option_id'),
  ]);
  const votesByOption = new Map(counts.results.map((r) => [r.option_id, r.n]));
  return json({
    polls: polls.results.map((p) => {
      const opts = options.results.filter((o) => o.poll_id === p.id)
        .map((o) => ({ id: o.id, label: o.label, voters: votesByOption.get(o.id) || 0 }));
      return { ...p, status: pollStatus(p), voters: opts.reduce((a, o) => a + o.voters, 0), options: opts };
    }),
  });
}

// テーマの編集。投票が入っている選択肢は消せない。投票が始まったテーマは開始日時を変えられない
//（開始日時は票の配布に使っているため、動かすと持ち票の計算が変わってしまう）
async function updatePoll(request, env, id) {
  const body = await readBody(request);
  const poll = await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(id).first();
  if (!poll) return fail('投票テーマが見つかりません', 404);
  const { title, description, opensAt, closesAt } = validatePollFields(body);
  const current = (await env.DB.prepare(
    `SELECT o.id, o.label, (SELECT COUNT(*) FROM ballots b WHERE b.option_id = o.id) AS voters
       FROM options o WHERE o.poll_id = ?`
  ).bind(id).all()).results;
  const totalVotes = current.reduce((a, o) => a + o.voters, 0);
  if (totalVotes > 0 && opensAt !== poll.opens_at) {
    throw bad('投票が入っているテーマは、受付開始日時を変えられません（終了日時は変えられます）', 409);
  }
  const incoming = (Array.isArray(body.options) ? body.options : [])
    .map((o) => (typeof o === 'object' && o !== null ? { id: Number(o.id) || null, label: String(o.label || '').trim() } : { id: null, label: String(o).trim() }))
    .filter((o) => o.label);
  if (incoming.length < 2 || incoming.length > 20) throw bad('選択肢は 2〜20 個にしてください');
  const currentIds = new Set(current.map((o) => o.id));
  for (const o of incoming) if (o.id && !currentIds.has(o.id)) throw bad('選択肢の指定が正しくありません');
  const keep = new Set(incoming.filter((o) => o.id).map((o) => o.id));
  const removed = current.filter((o) => !keep.has(o.id));
  const blocked = removed.find((o) => o.voters > 0);
  if (blocked) throw bad(`「${blocked.label}」には ${blocked.voters} 人が投票しているため削除できません`, 409);

  const stmts = [
    env.DB.prepare('UPDATE polls SET title = ?, description = ?, opens_at = ?, closes_at = ? WHERE id = ?')
      .bind(title, description, opensAt, closesAt, id),
    ...removed.map((o) => env.DB.prepare('DELETE FROM options WHERE id = ?').bind(o.id)),
    ...incoming.map((o, i) => (o.id
      ? env.DB.prepare('UPDATE options SET label = ?, sort = ? WHERE id = ?').bind(o.label, i, o.id)
      : env.DB.prepare('INSERT INTO options (poll_id, label, sort) VALUES (?, ?, ?)').bind(id, o.label, i))),
  ];
  await env.DB.batch(stmts);
  return json({ ok: true, id });
}

// テーマの削除。投票も一緒に消え、そのテーマで配った票・使った票もなかったことになる
async function deletePoll(request, env, id) {
  const poll = await env.DB.prepare('SELECT id FROM polls WHERE id = ?').bind(id).first();
  if (!poll) return fail('投票テーマが見つかりません', 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ballots WHERE poll_id = ?').bind(id),
    env.DB.prepare('DELETE FROM options WHERE poll_id = ?').bind(id),
    env.DB.prepare('DELETE FROM polls WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

// Google スプレッドシート等に読み込めるよう、投票データを CSV で書き出す（個人を特定する情報は含めない）
async function exportCsv(request, env, id) {
  const rows = (await env.DB.prepare(
    `SELECT b.created_at, o.label, b.weight, b.age_group, b.gender, b.income, b.pension
       FROM ballots b JOIN options o ON o.id = b.option_id WHERE b.poll_id = ? ORDER BY b.created_at`
  ).bind(id).all()).results;
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['投票日時', '選択肢', '票数', '年代', '性別', '年収', '年金'].map(esc).join(',')];
  for (const r of rows) {
    lines.push([
      new Date(r.created_at).toISOString(), r.label, r.weight, r.age_group,
      GENDER[r.gender] || r.gender, INCOME[r.income] || r.income, PENSION[r.pension],
    ].map(esc).join(','));
  }
  return new Response('﻿' + lines.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="poll-${id}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

// ---------- ルーティング ----------

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const user = await currentUser(request, env);
  const needUser = () => {
    if (!user) throw bad('ログインしてください', 401);
  };
  const needAdmin = () => {
    if (!isAdmin(request, env)) throw bad('管理者トークンが違います', 403);
  };
  let m;

  if (path === '/api/config' && method === 'GET') return siteConfig(env);
  if (path === '/api/line/start' && method === 'GET') return lineStart(request, env);
  if (path === '/api/line/callback' && method === 'GET') return lineCallback(request, env, user);
  if (path === '/api/line/register' && method === 'POST') return lineRegister(request, env);
  if (path === '/api/sms/start' && method === 'POST') return smsStart(request, env);
  if (path === '/api/register' && method === 'POST') return register(request, env);
  if (path === '/api/reset-password' && method === 'POST') return resetPassword(request, env);
  if (path === '/api/login' && method === 'POST') return login(request, env);
  if (path === '/api/logout' && method === 'POST') return logout(request, env);
  if (path === '/api/me' && method === 'GET') return me(request, env, user);
  if (path === '/api/me' && method === 'PUT') { needUser(); return updateProfile(request, env, user); }
  if (path === '/api/me' && method === 'DELETE') { needUser(); return deleteAccount(request, env, user); }
  if (path === '/api/polls' && method === 'GET') return listPolls(request, env, user);
  if ((m = path.match(/^\/api\/polls\/(\d+)$/)) && method === 'GET') return showPoll(request, env, user, Number(m[1]));
  if ((m = path.match(/^\/api\/polls\/(\d+)\/vote$/)) && method === 'POST') { needUser(); return vote(request, env, user, Number(m[1])); }
  if ((m = path.match(/^\/api\/polls\/(\d+)\/results$/)) && method === 'GET') return results(request, env, Number(m[1]));
  if (path === '/api/admin/polls' && method === 'POST') { needAdmin(); return createPoll(request, env); }
  if (path === '/api/admin/polls' && method === 'GET') { needAdmin(); return adminListPolls(env); }
  if ((m = path.match(/^\/api\/admin\/polls\/(\d+)$/)) && method === 'PUT') { needAdmin(); return updatePoll(request, env, Number(m[1])); }
  if ((m = path.match(/^\/api\/admin\/polls\/(\d+)$/)) && method === 'DELETE') { needAdmin(); return deletePoll(request, env, Number(m[1])); }
  if ((m = path.match(/^\/api\/admin\/polls\/(\d+)\/export$/)) && method === 'GET') { needAdmin(); return exportCsv(request, env, Number(m[1])); }
  return fail('見つかりません', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env);
    } catch (e) {
      if (e.status) return fail(e.message, e.status);
      console.error(e);
      return fail('サーバーでエラーが起きました', 500);
    }
  },
};
