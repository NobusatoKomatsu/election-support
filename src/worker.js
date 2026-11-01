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
//   - 登録時に携帯電話番号を SMS で確認する（1 番号 1 アカウント）
//   - 電話番号そのものは保存せず、秘密の鍵で HMAC した値だけを持つ
//   - 退会しても番号の HMAC は残し、同じ番号で登録し直すと持ち票と投票履歴を引き継ぐ（二重投票の防止）

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
    user: publicUser(user),
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
  // ログインID・パスワード・プロフィールは消す。電話番号の HMAC と投票済みの票は残す
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

async function results(request, env, id) {
  const poll = await getPoll(env, id);
  if (!poll) return fail('投票テーマが見つかりません', 404);
  const rows = (await env.DB.prepare(
    'SELECT option_id, weight, age_group, gender, income, pension FROM ballots WHERE poll_id = ?'
  ).bind(id).all()).results;

  const blank = () => Object.fromEntries(poll.options.map((o) => [o.id, { plus: 0, minus: 0, voters: 0 }]));
  const add = (bucket, r) => {
    const t = bucket[r.option_id];
    if (!t) return;
    if (r.weight > 0) t.plus += r.weight;
    else t.minus += -r.weight;
    t.voters += 1;
  };

  const totals = blank();
  const dims = { age_group: {}, gender: {}, income: {}, pension: {} };
  for (const r of rows) {
    add(totals, r);
    for (const d of Object.keys(dims)) {
      const key = String(r[d]);
      dims[d][key] ??= { voters: 0, options: blank() };
      dims[d][key].voters += 1;
      add(dims[d][key].options, r);
    }
  }
  return json({
    poll,
    voters: rows.length,
    totals,
    breakdown: dims,
    labels: { gender: GENDER, income: INCOME, pension: PENSION },
    updated_at: Date.now(),
  });
}

// ---------- 管理者 ----------

function isAdmin(request, env) {
  const auth = request.headers.get('authorization') || '';
  return Boolean(env.ADMIN_TOKEN) && safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`);
}

async function createPoll(request, env) {
  const body = await readBody(request);
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const options = (Array.isArray(body.options) ? body.options : []).map((s) => String(s).trim()).filter(Boolean);
  const opensAt = Number(body.opens_at);
  const closesAt = Number(body.closes_at);
  if (!title || title.length > 200) throw bad('タイトルを 200 文字以内で入力してください');
  if (options.length < 2 || options.length > 20) throw bad('選択肢は 2〜20 個にしてください');
  if (!(opensAt > 0 && closesAt > opensAt)) throw bad('受付期間を正しく入力してください');
  const res = await env.DB.prepare(
    'INSERT INTO polls (title, description, opens_at, closes_at, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(title, description, opensAt, closesAt, Date.now()).run();
  const pollId = res.meta.last_row_id;
  await env.DB.batch(options.map((label, i) =>
    env.DB.prepare('INSERT INTO options (poll_id, label, sort) VALUES (?, ?, ?)').bind(pollId, label, i)));
  return json({ ok: true, id: pollId }, 201);
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
