// みんなの声 — 画面（ハッシュでページを切り替える 1 枚の HTML）
'use strict';

const GENDER = { male: '男性', female: '女性', other: 'その他・回答しない' };
const INCOME = {
  none: '収入なし', u200: '200万円未満', u400: '200〜400万円', u600: '400〜600万円',
  u800: '600〜800万円', u1000: '800〜1,000万円', o1000: '1,000万円以上',
};
const PENSION = { 1: '受給している', 0: '受給していない' };
const AGE_ORDER = ['〜19歳', '20代', '30代', '40代', '50代', '60代', '70歳以上'];
const REFRESH_MS = 5000;

// Google AdSense の手動広告枠。AdSense で「広告ユニット」を作ったら、その data-ad-slot の数字をここに入れる。
// 空のままなら手動枠は出さず、AdSense の自動広告（index.html の読み込みだけ）に任せる。
// 投票フォームの近くには置かない（誤クリックを誘う配置は AdSense の規約違反）
const AD_CLIENT = 'ca-pub-3726905377775362';
const AD_SLOTS = { home: '', result: '' };

function adUnit(key) {
  const slot = AD_SLOTS[key];
  if (!slot) return '';
  return `<div class="ad"><ins class="adsbygoogle" style="display:block" data-ad-client="${AD_CLIENT}"
    data-ad-slot="${slot}" data-ad-format="auto" data-full-width-responsive="true"></ins></div>`;
}
function fillAds() {
  document.querySelectorAll('ins.adsbygoogle:not([data-adsbygoogle-status])').forEach(() => {
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* 広告ブロッカーなど */ }
  });
}

const app = document.getElementById('app');
const nav = document.getElementById('nav');
let me = null; // { user, balance, max_balance, history }
let timer = null;
let config = { line: false, turnstile_site_key: null };
let flash = null; // 次の画面の上に出すお知らせ { text, kind }

// ---------- Cloudflare Turnstile（ロボット対策） ----------

let turnstileLoading = null;
function loadTurnstile() {
  if (!config.turnstile_site_key) return Promise.resolve(null);
  turnstileLoading ??= new Promise((resolve) => {
    window.onTurnstileLoad = () => resolve(window.turnstile);
    const sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad';
    sc.async = true;
    sc.onerror = () => resolve(null);
    document.head.appendChild(sc);
  });
  return turnstileLoading;
}
// フォームの中の <div class="ts"> に確認欄を出す。token() で送信用の値を取り出す
function turnstileBox(el) {
  let id = null;
  let ts = null;
  if (el) loadTurnstile().then((t) => {
    if (!t || !el.isConnected) return;
    ts = t;
    id = t.render(el, { sitekey: config.turnstile_site_key, language: 'ja', theme: 'auto' });
  });
  return {
    token: () => (ts && id !== null ? ts.getResponse(id) || '' : ''),
    reset: () => { if (ts && id !== null) ts.reset(id); },
  };
}

const LINE_MESSAGES = {
  cancel: 'LINE でのログインがキャンセルされました。',
  state: '時間が経ちすぎたか、別のタブで操作されたため確認できませんでした。もう一度お試しください。',
  verify: 'LINE で本人を確かめられませんでした。もう一度お試しください。',
  login: 'ログインしてから LINE と連携してください。',
  linked_other: 'この LINE アカウントは、別のアカウントで使われています。',
  disabled: 'LINE ログインは準備中です。',
};
function lineButton(text, href = '/api/line/start') {
  return config.line
    ? `<a class="btn btn-line" href="${href}">${esc(text)}</a>`
    : '<div class="msg err">LINE ログインは準備中です。しばらくお待ちください。</div>';
}

// ---------- 小道具 ----------

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const fmtDate = (ms) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

function message(el, text, kind = 'err') {
  el.innerHTML = text ? `<div class="msg ${kind}">${esc(text)}</div>` : '';
}

function options(map, selected) {
  return Object.entries(map).map(([k, v]) =>
    `<option value="${esc(k)}"${String(selected) === k ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function profileFields(u = {}) {
  const thisYear = new Date().getFullYear();
  return `
    <label>生まれた年 <span class="hint">年代ごとの集計に使います（例: 1980）</span>
      <input name="birth_year" type="number" inputmode="numeric" min="1900" max="${thisYear}" required value="${esc(u.birth_year ?? '')}">
    </label>
    <label>性別
      <select name="gender" required><option value="">選んでください</option>${options(GENDER, u.gender)}</select>
    </label>
    <label>年収 <span class="hint">税込のおおよその金額</span>
      <select name="income" required><option value="">選んでください</option>${options(INCOME, u.income)}</select>
    </label>
    <label>年金
      <select name="pension" required><option value="">選んでください</option>${options(PENSION, u.pension)}</select>
    </label>`;
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---------- ナビ ----------

async function loadMe() {
  me = await api('/me').catch(() => ({ user: null }));
  renderNav();
}

function renderNav() {
  if (me?.user) {
    nav.innerHTML = `
      <span class="chip" title="使える票の数（上限 ${me.max_balance} 票）">持ち票 ${me.balance} 票</span>
      <a href="#/me">マイページ</a>
      <button class="linkish" id="logout">ログアウト</button>`;
    document.getElementById('logout').onclick = async () => {
      await api('/logout', { method: 'POST', body: {} });
      await loadMe();
      location.hash = '#/';
    };
  } else {
    nav.innerHTML = `<a href="#/login">ログイン</a><a href="#/register" class="btn" style="padding:6px 12px">アカウント作成</a>`;
  }
}

// ---------- ページ ----------

const STATUS = { open: '受付中', upcoming: '開始前', closed: '終了' };

async function pageHome() {
  const { polls } = await api('/polls');
  const card = (p) => `
    <a class="card poll-link" href="#/poll/${p.id}">
      <div class="row">
        <strong>${esc(p.title)}</strong>
        <span class="badge ${p.status}">${STATUS[p.status]}${p.voted ? '・投票済み' : ''}</span>
      </div>
      <div class="muted small">${fmtDate(p.opens_at)} 〜 ${fmtDate(p.closes_at)}　/　投票 ${p.voters} 人</div>
    </a>`;
  const open = polls.filter((p) => p.status === 'open');
  const rest = polls.filter((p) => p.status !== 'open');
  app.innerHTML = `
    <h1>いま受付中のテーマ</h1>
    <p class="muted">投票しなかった票は次に持ち越せます。反対したいときはマイナス票も入れられます。</p>
    ${open.length ? open.map(card).join('') : '<div class="card muted">受付中のテーマはありません。</div>'}
    ${adUnit('home')}
    ${rest.length ? `<h2>これまでのテーマ・これからのテーマ</h2>${rest.map(card).join('')}` : ''}`;
  fillAds();
}

function pageLogin() {
  app.innerHTML = `
    <h1>ログイン</h1>
    <div class="card" style="display:grid;gap:10px">
      ${lineButton('LINE でログイン')}
      <p class="muted small" style="margin:0">LINE で登録した方はこちら。初めての方も、このボタンから登録できます。</p>
    </div>
    <details class="card">
      <summary>以前に ID とパスワードで登録した方</summary>
      <form id="f" style="margin-top:12px">
        <label>ログインID <input name="login_id" autocomplete="username" required></label>
        <label>パスワード <input name="password" type="password" autocomplete="current-password" required></label>
        <div class="ts"></div>
        <div id="m"></div>
        <button>ログイン</button>
        <p class="muted small" style="margin:0">パスワードを忘れた場合は再設定できません。「LINE で登録」から新しく登録してください。</p>
      </form>
    </details>`;
  const f = document.getElementById('f');
  const ts = turnstileBox(f.querySelector('.ts'));
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { ...formData(f), turnstile: ts.token() } });
      await loadMe();
      location.hash = '#/';
    } catch (err) { message(document.getElementById('m'), err.message); ts.reset(); }
  };
}

function pageRegister() {
  app.innerHTML = `
    <h1>アカウント作成</h1>
    <p>LINE で本人を確かめてから、年代などのプロフィールを入力します。</p>
    <div class="card" style="display:grid;gap:12px">
      ${lineButton('LINE で登録')}
      <ul class="muted small" style="margin:0;padding-left:1.2em">
        <li>LINE から受け取るのは、アカウントを見分けるための ID だけです。名前・プロフィール画像・メールアドレス・電話番号・トーク・友だちは受け取りません。</li>
        <li>1 つの LINE アカウントにつき 1 アカウントです。</li>
        <li>集計に使うのは <strong>年代・性別・年収・年金の受給状況</strong> だけです。</li>
        <li>友だち追加やメッセージの送信はしません。</li>
      </ul>
    </div>
    <p class="small">すでにアカウントがある方は <a href="#/login">ログイン</a></p>`;
}

// LINE で確かめたあとのプロフィール入力
function pageLineRegister() {
  app.innerHTML = `
    <h1>プロフィールの入力</h1>
    <p class="muted">LINE での確認ができました。最後に、集計に使う 4 つの項目を入力してください。</p>
    <div class="card">
      <form id="f">
        ${profileFields()}
        <div class="ts"></div>
        <p class="muted small" style="margin:0">登録すると、<a href="/privacy" target="_blank" rel="noopener">プライバシーポリシー</a>に同意したものとみなします。</p>
        <div id="m"></div>
        <button>登録して始める</button>
      </form>
    </div>`;
  const f = document.getElementById('f');
  const ts = turnstileBox(f.querySelector('.ts'));
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/line/register', { method: 'POST', body: { ...formData(f), turnstile: ts.token() } });
      await loadMe();
      if (r.restored) flash = { text: '以前のアカウントの持ち票と投票履歴を引き継ぎました。', kind: 'ok' };
      location.hash = '#/';
    } catch (err) {
      const box = document.getElementById('m');
      message(box, err.message);
      if (/もう一度「LINE で登録」/.test(err.message)) box.insertAdjacentHTML('beforeend', '<p class="small"><a href="#/register">登録をやり直す</a></p>');
      ts.reset();
    }
  };
}

async function pageMe() {
  await loadMe();
  if (!me.user) { location.hash = '#/login'; return; }
  const u = me.user;
  app.innerHTML = `
    <h1>マイページ</h1>
    <div class="card">
      <div class="row"><span>持ち票</span><strong style="font-size:1.4rem">${me.balance} 票</strong></div>
      <p class="muted small" style="margin:6px 0 0">テーマが始まるたびに 1 票増えます。持ち越せるのは ${me.max_balance} 票まで。</p>
    </div>
    <h2>投票の履歴</h2>
    ${me.history.length ? `<div class="card table-wrap"><table>
      <tr><th>テーマ</th><th>選択肢</th><th>票</th><th>日時</th></tr>
      ${me.history.map((h) => `<tr><td><a href="#/poll/${h.poll_id}">${esc(h.title)}</a></td><td>${esc(h.label)}</td>
        <td class="${h.weight > 0 ? 'p' : 'm'}">${signed(h.weight)}</td><td>${fmtDate(h.created_at)}</td></tr>`).join('')}
    </table></div>` : '<div class="card muted">まだ投票していません。</div>'}
    <h2>プロフィール</h2>
    <div class="card">
      <form id="f">
        ${profileFields(u)}
        <p class="muted small" style="margin:0">変更はこれからの投票に反映されます。投票済みの票の集計は変わりません。</p>
        <div id="m"></div>
        <button>保存</button>
      </form>
    </div>
    <h2>LINE 連携</h2>
    <div class="card">
      ${u.line_linked
        ? '<p style="margin:0">LINE と連携しています。LINE でログインできます。</p>'
        : `<p class="small" style="margin-top:0">LINE と連携すると、次から LINE でログインできます（パスワードは不要になります）。</p>${lineButton('LINE と連携する', '/api/line/start?mode=link')}`}
    </div>
    <h2>退会</h2>
    <div class="card">
      <p class="small" style="margin-top:0">プロフィールとログインの情報を削除します。投票済みの票は集計に残ります。
        二重投票を防ぐため、同じ LINE アカウントで登録し直すと、持ち票と投票履歴を引き継ぎます。</p>
      <button class="danger" id="del">アカウントを削除</button>
    </div>`;
  const f = document.getElementById('f');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/me', { method: 'PUT', body: formData(f) });
      message(document.getElementById('m'), '保存しました', 'ok');
    } catch (err) { message(document.getElementById('m'), err.message); }
  };
  document.getElementById('del').onclick = async () => {
    if (!confirm('アカウントを削除します。元に戻せません。よろしいですか？')) return;
    await api('/me', { method: 'DELETE' });
    await loadMe();
    location.hash = '#/';
  };
}

async function pagePoll(id) {
  const { poll, my_ballot: mine, balance } = await api(`/polls/${id}`);
  app.innerHTML = `
    <p class="small"><a href="#/">← テーマ一覧</a></p>
    <div class="row"><h1>${esc(poll.title)}</h1><span class="badge ${poll.status}">${STATUS[poll.status]}</span></div>
    <p class="muted small">受付 ${fmtDate(poll.opens_at)} 〜 ${fmtDate(poll.closes_at)}</p>
    ${poll.description ? `<p style="white-space:pre-wrap">${esc(poll.description)}</p>` : ''}
    <div id="vote"></div>
    <div id="share"></div>
    <h2>結果 <span class="live">リアルタイム</span></h2>
    <div id="results" class="card"><p class="muted">読み込み中…</p></div>
    ${adUnit('result')}`;
  renderVote(poll, mine, balance);
  renderShare(poll);
  fillAds();
  // 表示の切り替え（票数／割合、属性、かけ合わせ）は 5 秒ごとの更新でも保つ
  let view = { dim: 'age_group', mode: 'votes', rowDim: 'age_group', colDim: 'income', optId: null };
  let last = null;
  const draw = () => { if (last) renderResults(last, view, (v) => { view = v; draw(); }); };
  const refresh = async () => {
    try {
      last = await api(`/polls/${id}/results`);
      draw();
    } catch { /* 次の更新で再試行 */ }
  };
  await refresh();
  timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
}

// ---------- この問いをシェア（自分がどれに投票したかは入れない） ----------
// リンクは /p/<番号>?s=<SNS>。SNS ではテーマ名入りのカードになり、「経由」の集計にも使われる

function shareText(poll) {
  const lead = poll.status === 'closed' ? 'この問いの結果、みんなはどう考えた？' : 'この問い、あなたはどう思う？';
  return `${lead}\n「${poll.title}」\n年代・年収などの属性ごとの民意を、リアルタイムで公開中。`;
}

function renderShare(poll) {
  const box = document.getElementById('share');
  if (!box) return;
  const url = (s) => `${location.origin}/p/${poll.id}?s=${s}`;
  const text = shareText(poll);
  const enc = encodeURIComponent;
  const links = [
    ['x', 'X', `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url('x'))}&hashtags=${enc('みんなの声')}`],
    ['line', 'LINE', `https://social-plugins.line.me/lineit/share?url=${enc(url('line'))}&text=${enc(text)}`],
    ['facebook', 'Facebook', `https://www.facebook.com/sharer/sharer.php?u=${enc(url('fb'))}`],
    ['threads', 'Threads', `https://www.threads.net/intent/post?text=${enc(`${text}\n${url('threads')}`)}`],
  ];
  box.innerHTML = `
    <div class="share">
      <div class="share-title">この問いをシェア <span class="muted small">あなたの投票先は表示されません</span></div>
      <div class="share-buttons">
        ${links.map(([k, label, href]) => `<a class="share-btn ${k}" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`).join('')}
        ${navigator.share ? '<button type="button" class="share-btn more" id="share-more">その他（Instagram など）</button>' : ''}
        <button type="button" class="share-btn copy" id="share-copy">リンクをコピー</button>
      </div>
      <div id="share-msg"></div>
    </div>`;
  box.querySelector('#share-more')?.addEventListener('click', async () => {
    try { await navigator.share({ title: poll.title, text, url: url('other') }); } catch { /* キャンセル */ }
  });
  box.querySelector('#share-copy').addEventListener('click', async () => {
    const u = `${location.origin}/p/${poll.id}`;
    try {
      await navigator.clipboard.writeText(u);
      message(box.querySelector('#share-msg'), `リンクをコピーしました：${u}`, 'ok');
    } catch {
      message(box.querySelector('#share-msg'), `このリンクをコピーしてください：${u}`, 'ok');
    }
  });
}

function renderVote(poll, mine, balance) {
  const box = document.getElementById('vote');
  if (mine) {
    const opt = poll.options.find((o) => o.id === mine.option_id);
    box.innerHTML = `<div class="msg ok">投票済み：「${esc(opt?.label)}」に${mine.weight > 0 ? '賛成' : '反対'} ${Math.abs(mine.weight)} 票（${fmtDate(mine.created_at)}）</div>`;
    return;
  }
  if (poll.status !== 'open') { box.innerHTML = ''; return; }
  if (!me?.user) {
    box.innerHTML = `<div class="card">投票するには <a href="#/login">ログイン</a> または <a href="#/register">アカウント作成</a> をしてください。</div>`;
    return;
  }
  if (!balance) {
    box.innerHTML = `<div class="card muted">持ち票がありません。次のテーマが始まると 1 票配られます。</div>`;
    return;
  }
  box.innerHTML = `
    <div class="card">
      <form id="vf">
        <fieldset>
          <legend>選択肢</legend>
          ${poll.options.map((o) => `<label class="choice"><input type="radio" name="option_id" value="${o.id}" required> ${esc(o.label)}</label>`).join('')}
        </fieldset>
        <div class="weight">
          <label for="w">使う票数 <span class="hint">持ち票 ${balance} 票。左に動かすと反対（マイナス）票になります</span></label>
          <input id="w" name="weight" type="range" min="${-balance}" max="${balance}" step="1" value="1">
          <output id="wo"></output>
        </div>
        <p class="muted small" style="margin:0">投票しなければ、この票は次のテーマに持ち越されます。投票は 1 回だけで、あとから変えられません。</p>
        <div id="vm"></div>
        <button id="vb">投票する</button>
      </form>
    </div>`;
  const f = document.getElementById('vf');
  const w = document.getElementById('w');
  const wo = document.getElementById('wo');
  const vb = document.getElementById('vb');
  const show = () => {
    const n = Number(w.value);
    wo.className = n > 0 ? 'plus' : n < 0 ? 'minus' : '';
    wo.textContent = n > 0 ? `賛成 ${n} 票` : n < 0 ? `反対 ${-n} 票` : '0 票（左右どちらかに動かしてください）';
    vb.disabled = n === 0;
    const left = balance - Math.abs(n);
    vb.textContent = n === 0 ? '投票する' : `投票する（残り ${left} 票）`;
  };
  w.oninput = show;
  show();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    try {
      await api(`/polls/${poll.id}/vote`, { method: 'POST', body: { option_id: Number(d.option_id), weight: Number(d.weight) } });
      await loadMe();
      const { poll: p, my_ballot: m2, balance: b2 } = await api(`/polls/${poll.id}`);
      renderVote(p, m2, b2);
    } catch (err) { message(document.getElementById('vm'), err.message); }
  };
}

const DIMS = { age_group: '年代', gender: '性別', income: '年収', pension: '年金', source: '経由' };

function groupOrder(dim, keys) {
  const order = { age_group: AGE_ORDER, gender: Object.keys(GENDER), income: Object.keys(INCOME), pension: ['1', '0'], source: Object.keys(SOURCE_LABELS) }[dim];
  return keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
function groupLabel(dim, key) {
  return ({ gender: GENDER, income: INCOME, pension: PENSION, source: SOURCE_LABELS }[dim] || {})[key] ?? key;
}

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const heat = (color, strength) => `background:color-mix(in srgb, var(${color}) ${Math.round(Math.min(1, strength) * 55)}%, transparent)`;

// view … { dim, mode: 'votes' | 'pct', rowDim, colDim, optId }。変わったら onChange(新しい view) を呼ぶ
function renderResults(r, view, onChange) {
  const box = document.getElementById('results');
  if (!box) return;
  const isPct = view.mode === 'pct';
  const opts = r.poll.options;
  const totals = opts.map((o) => ({ ...o, ...r.totals[o.id], net: r.totals[o.id].plus - r.totals[o.id].minus }));
  const ranked = [...totals].sort((a, b) => b.net - a.net);
  const set = (patch) => onChange({ ...view, ...patch });

  // ---- 選択肢ごとの棒 ----
  const scale = isPct ? 100 : Math.max(1, ...totals.map((t) => Math.max(t.plus, t.minus)));
  const bars = ranked.map((t) => {
    const forPct = pct(t.plus_voters, r.voters);
    const againstPct = pct(t.minus_voters, r.voters);
    const pos = isPct ? forPct : t.plus;
    const neg = isPct ? againstPct : t.minus;
    return `
    <div class="bar-row">
      <div class="row"><span>${esc(t.label)}</span><span class="net">${isPct ? `${forPct}%` : signed(t.net)}</span></div>
      <div class="track" role="img" aria-label="${esc(t.label)}: 賛成 ${t.plus} 票（${forPct}%の人）、反対 ${t.minus} 票（${againstPct}%の人）">
        <div class="neg"><span style="width:${(neg / scale) * 100}%"></span></div>
        <div class="pos"><span style="width:${(pos / scale) * 100}%"></span></div>
      </div>
      <div class="muted small">${isPct
        ? `賛成した人 ${forPct}%（${t.plus_voters} 人）・反対した人 ${againstPct}%（${t.minus_voters} 人）`
        : `賛成 ${t.plus} 票・反対 ${t.minus} 票・${t.voters} 人`}</div>
    </div>`;
  }).join('');

  // ---- 1 つの属性ごとの表 ----
  const hiddenNote = `<p class="muted small">人数が ${r.min_group} 人未満の区分は、だれの票か分からないよう表示しません（—）。</p>`;
  const cell = (c, n) => {
    if (isPct) {
      const f = pct(c.plus_voters, n);
      const a = pct(c.minus_voters, n);
      return `<td style="${heat('--plus', f / 100)}" title="賛成 ${c.plus_voters} 人 / 反対 ${c.minus_voters} 人">${f}%${a ? `<span class="sub m">反対 ${a}%</span>` : ''}</td>`;
    }
    const net = c.plus - c.minus;
    return `<td class="${net > 0 ? 'p' : net < 0 ? 'm' : ''}" title="賛成 ${c.plus} 票 / 反対 ${c.minus} 票">${signed(net)}</td>`;
  };
  const groups = r.breakdown[view.dim] || {};
  const keys = groupOrder(view.dim, Object.keys(groups));
  const table = keys.length ? `
    <div class="table-wrap"><table>
      <tr><th>${DIMS[view.dim]}</th><th>人数</th>${opts.map((o) => `<th>${esc(o.label)}</th>`).join('')}</tr>
      ${keys.map((k) => {
        const g = groups[k];
        if (g.hidden) return `<tr><td>${esc(groupLabel(view.dim, k))}</td><td class="muted">—</td>${opts.map(() => '<td class="muted">—</td>').join('')}</tr>`;
        return `<tr><td>${esc(groupLabel(view.dim, k))}</td><td>${g.voters}</td>${opts.map((o) => cell(g.options[o.id], g.voters)).join('')}</tr>`;
      }).join('')}
    </table></div>` : '<p class="muted">まだ投票がありません。</p>';

  // ---- 2 つの属性のかけ合わせ ----
  const rowDim = view.rowDim;
  const colDim = view.colDim === rowDim ? Object.keys(DIMS).find((d) => d !== rowDim) : view.colDim;
  const optId = opts.some((o) => o.id === view.optId) ? view.optId : ranked[0]?.id;
  const direct = r.cross[`${rowDim}|${colDim}`];
  const crossCell = (rk, ck) => (direct ? direct[`${rk}|${ck}`] : r.cross[`${colDim}|${rowDim}`]?.[`${ck}|${rk}`]);
  const rowKeys = groupOrder(rowDim, Object.keys(r.breakdown[rowDim] || {}));
  const colKeys = groupOrder(colDim, Object.keys(r.breakdown[colDim] || {}));
  const maxAbs = Math.max(1, ...rowKeys.flatMap((rk) => colKeys.map((ck) => {
    const c = crossCell(rk, ck);
    return c && !c.hidden ? Math.abs(c.options[optId].plus - c.options[optId].minus) : 0;
  })));
  const select = (name, value, entries) => `<select data-view="${name}">${entries.map(([k, v]) =>
    `<option value="${esc(k)}"${String(k) === String(value) ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  const crossTable = rowKeys.length && colKeys.length ? `
    <div class="table-wrap"><table class="cross">
      <tr><th>${DIMS[rowDim]}＼${DIMS[colDim]}</th>${colKeys.map((ck) => `<th>${esc(groupLabel(colDim, ck))}</th>`).join('')}</tr>
      ${rowKeys.map((rk) => `<tr><td>${esc(groupLabel(rowDim, rk))}</td>${colKeys.map((ck) => {
        const c = crossCell(rk, ck);
        if (!c) return '<td class="muted"></td>';
        if (c.hidden) return '<td class="muted">—</td>';
        const o = c.options[optId];
        if (isPct) {
          const f = pct(o.plus_voters, c.voters);
          return `<td style="${heat('--plus', f / 100)}" title="${c.voters} 人中 賛成 ${o.plus_voters} 人">${f}%<span class="sub">${c.voters}人</span></td>`;
        }
        const net = o.plus - o.minus;
        return `<td class="${net > 0 ? 'p' : net < 0 ? 'm' : ''}" style="${heat(net < 0 ? '--minus' : '--plus', Math.abs(net) / maxAbs)}" title="${c.voters} 人・賛成 ${o.plus} 票・反対 ${o.minus} 票">${signed(net)}<span class="sub">${c.voters}人</span></td>`;
      }).join('')}</tr>`).join('')}
    </table></div>` : '<p class="muted">まだ投票がありません。</p>';

  const dimEntries = Object.entries(DIMS);
  box.innerHTML = `
    <div class="row"><strong>投票 ${r.voters} 人</strong><span class="muted small">更新 ${new Date(r.updated_at).toLocaleTimeString('ja-JP')}</span></div>
    <div class="tabs mode" role="group" aria-label="表示のしかた" style="margin-top:10px">
      <button data-mode="votes" aria-pressed="${!isPct}">票数</button>
      <button data-mode="pct" aria-pressed="${isPct}">割合（%）</button>
    </div>
    <div class="legend" style="margin:4px 0 14px"><span><i style="background:var(--plus)"></i>賛成</span><span><i style="background:var(--minus)"></i>反対</span>
      <span class="note">${isPct ? '数字は、投票した人のうち賛成票を入れた人の割合' : '数字は 賛成−反対 の票数'}</span></div>
    <div class="bars">${bars}</div>

    <h2>属性別（${isPct ? '賛成した人の割合' : '賛成−反対'}）</h2>
    <div class="tabs">${dimEntries.map(([k, v]) => `<button data-dim="${k}" aria-pressed="${k === view.dim}">${v}</button>`).join('')}</div>
    ${table}

    <h2>かけ合わせ</h2>
    <div class="cross-controls">
      <label>選択肢 ${select('optId', optId, opts.map((o) => [o.id, o.label]))}</label>
      <label>縦 ${select('rowDim', rowDim, dimEntries)}</label>
      <label>横 ${select('colDim', colDim, dimEntries.filter(([k]) => k !== rowDim))}</label>
    </div>
    <p class="muted small" style="margin:6px 0">「${esc(opts.find((o) => o.id === optId)?.label ?? '')}」に${isPct ? '賛成した人の割合' : '入った 賛成−反対 の票数'}を、${DIMS[rowDim]}と${DIMS[colDim]}の組み合わせごとに表示します。色が濃いほど${isPct ? '割合が高い' : '票が多い'}区分です。</p>
    ${crossTable}
    ${hiddenNote}`;

  box.querySelectorAll('[data-dim]').forEach((b) => { b.onclick = () => set({ dim: b.dataset.dim }); });
  box.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => set({ mode: b.dataset.mode }); });
  box.querySelectorAll('select[data-view]').forEach((el) => {
    el.onchange = () => {
      const k = el.dataset.view;
      const v = k === 'optId' ? Number(el.value) : el.value;
      set(k === 'rowDim' && v === colDim ? { rowDim: v, colDim: rowDim } : { [k]: v });
    };
  });
}

// ---------- 管理画面（一覧・作成・編集・削除・CSV） ----------

function pageAdmin() {
  let token = '';
  try { token = sessionStorage.getItem('adminToken') || ''; } catch { /* 使えなくても続行 */ }
  const remember = (t) => { try { sessionStorage.setItem('adminToken', t); } catch { /* 無視 */ } };
  const auth = () => ({ authorization: `Bearer ${token}` });
  const pad = (n) => String(n).padStart(2, '0');
  const local = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  function login() {
    app.innerHTML = `
      <h1>管理画面</h1>
      <div class="card">
        <form id="t">
          <label>管理者トークン <input name="token" type="password" required autocomplete="current-password"></label>
          <div id="m"></div>
          <button>開く</button>
        </form>
      </div>`;
    const f = document.getElementById('t');
    f.onsubmit = async (e) => {
      e.preventDefault();
      token = f.token.value.trim();
      try { await api('/admin/polls', { headers: auth() }); remember(token); list(); }
      catch (err) { message(document.getElementById('m'), err.message); }
    };
  }

  async function list(note = '') {
    let polls;
    try { ({ polls } = await api('/admin/polls', { headers: auth() })); }
    catch { token = ''; remember(''); login(); return; }
    app.innerHTML = `
      <div class="row"><h1>管理：テーマ一覧</h1><button id="new">＋ 新しいテーマ</button></div>
      ${note ? `<div class="msg ok">${esc(note)}</div>` : ''}
      ${polls.length ? polls.map((p) => `
        <div class="card">
          <div class="row"><strong>${esc(p.title)}</strong><span class="badge ${p.status}">${STATUS[p.status]}</span></div>
          <div class="muted small">#${p.id}　${fmtDate(p.opens_at)} 〜 ${fmtDate(p.closes_at)}　/　投票 ${p.voters} 人</div>
          <div class="row" style="justify-content:flex-start;margin-top:10px">
            <button class="ghost" data-edit="${p.id}">編集</button>
            <button class="ghost" data-csv="${p.id}">CSV</button>
            <a class="small" href="#/poll/${p.id}">結果を見る</a>
            <button class="danger" data-del="${p.id}" style="margin-left:auto">削除</button>
          </div>
        </div>`).join('') : '<div class="card muted">まだテーマがありません。</div>'}
      <div id="m"></div>
      <p class="small"><button class="linkish" id="out">管理画面からログアウト</button></p>`;
    document.getElementById('new').onclick = () => form(null);
    document.getElementById('out').onclick = () => { token = ''; remember(''); login(); };
    app.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => form(polls.find((p) => p.id === Number(b.dataset.edit))); });
    app.querySelectorAll('[data-csv]').forEach((b) => { b.onclick = () => csv(b.dataset.csv); });
    app.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        const p = polls.find((x) => x.id === Number(b.dataset.del));
        if (!b.dataset.sure) {
          b.dataset.sure = '1';
          b.textContent = p.voters ? `${p.voters} 人の投票も消えます。もう一度押すと削除` : 'もう一度押すと削除';
          return;
        }
        try { await api(`/admin/polls/${p.id}`, { method: 'DELETE', headers: auth() }); list(`「${p.title}」を削除しました`); }
        catch (err) { message(document.getElementById('m'), err.message); }
      };
    });
  }

  function form(poll) {
    const now = Date.now();
    const opts = poll ? poll.options : [{ id: null, label: '賛成', voters: 0 }, { id: null, label: '反対', voters: 0 }];
    const locked = poll && poll.voters > 0;
    app.innerHTML = `
      <p class="small"><button class="linkish" id="back">← テーマ一覧</button></p>
      <h1>${poll ? 'テーマを編集' : '新しいテーマ'}</h1>
      <div class="card">
        <form id="f">
          <label>タイトル <input name="title" required maxlength="200" value="${esc(poll?.title ?? '')}"></label>
          <label>説明 <textarea name="description">${esc(poll?.description ?? '')}</textarea></label>
          <fieldset>
            <legend>選択肢（2〜20 個）</legend>
            <div id="opts" style="display:grid;gap:8px"></div>
            <button type="button" class="ghost" id="add" style="margin-top:8px">＋ 選択肢を追加</button>
          </fieldset>
          <label>受付開始 ${locked ? '<span class="hint">投票が入っているため変更できません</span>' : ''}
            <input name="opens_at" type="datetime-local" required value="${local(poll?.opens_at ?? now)}" ${locked ? 'disabled' : ''}>
          </label>
          <label>受付終了 <input name="closes_at" type="datetime-local" required value="${local(poll?.closes_at ?? now + 7 * 86400000)}"></label>
          <div id="m"></div>
          <button>${poll ? '保存' : '作成'}</button>
        </form>
      </div>`;
    const box = document.getElementById('opts');
    const addRow = (o) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.flexWrap = 'nowrap';
      row.dataset.id = o.id ?? '';
      row.innerHTML = `<input value="${esc(o.label)}" maxlength="100" aria-label="選択肢" style="flex:1;min-width:0">
        ${o.voters ? `<span class="muted small" style="white-space:nowrap">${o.voters} 人</span>` : '<button type="button" class="danger" aria-label="この選択肢を削除">×</button>'}`;
      row.querySelector('button')?.addEventListener('click', () => row.remove());
      box.appendChild(row);
    };
    opts.forEach(addRow);
    document.getElementById('add').onclick = () => addRow({ id: null, label: '', voters: 0 });
    document.getElementById('back').onclick = () => list();
    const f = document.getElementById('f');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const options = [...box.children].map((r) => ({ id: r.dataset.id ? Number(r.dataset.id) : null, label: r.querySelector('input').value }));
      const body = {
        title: f.title.value,
        description: f.description.value,
        options,
        opens_at: locked ? poll.opens_at : new Date(f.opens_at.value).getTime(),
        closes_at: new Date(f.closes_at.value).getTime(),
      };
      try {
        if (poll) await api(`/admin/polls/${poll.id}`, { method: 'PUT', headers: auth(), body });
        else await api('/admin/polls', { method: 'POST', headers: auth(), body });
        list(poll ? '保存しました' : 'テーマを作りました');
      } catch (err) { message(document.getElementById('m'), err.message); }
    };
  }

  async function csv(id) {
    const res = await fetch(`/api/admin/polls/${id}/export`, { headers: auth() });
    if (!res.ok) { message(document.getElementById('m'), (await res.json().catch(() => ({}))).error || 'ダウンロードできませんでした'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = `poll-${id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (token) list(); else login();
}

// ---------- ルーター ----------

async function router() {
  clearInterval(timer);
  timer = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts[0] === 'login') pageLogin();
    else if (parts[0] === 'register') pageRegister();
    else if (parts[0] === 'line-register') pageLineRegister();
    else if (parts[0] === 'me') await pageMe();
    else if (parts[0] === 'admin') pageAdmin();
    else if (parts[0] === 'poll' && /^\d+$/.test(parts[1])) await pagePoll(Number(parts[1]));
    else await pageHome();
  } catch (err) {
    app.innerHTML = `<div class="msg err">${esc(err.message)}</div><p><a href="#/">トップへ戻る</a></p>`;
  }
  if (flash) {
    app.insertAdjacentHTML('afterbegin', `<div class="msg ${flash.kind}">${esc(flash.text)}</div>`);
    flash = null;
  }
  // Google アナリティクス: 「#/poll/1」を「/poll/1」として 1 ページ数える（管理画面は数えない）
  if (parts[0] !== 'admin') {
    const title = app.querySelector('h1')?.textContent?.trim() || 'みんなの声';
    window.trackPage?.(`/${parts.filter(Boolean).join('/')}`, title);
  }
  window.scrollTo(0, 0);
}

// LINE から戻ってきたときの結果（?line_error=… / ?line_ok=…）を読み取り、アドレスからは消す
function readLineResult() {
  const q = new URLSearchParams(location.search);
  if (q.get('line_error')) {
    const detail = q.get('detail') || '';
    const hint = /invalid_client/.test(detail) ? 'サイトに設定した LINE のチャネルシークレットが、LINE Developers の値と一致していません。'
      : /invalid_grant|redirect/.test(detail) ? 'LINE Developers のコールバック URL の設定を確かめてください。' : '';
    flash = { text: `${LINE_MESSAGES[q.get('line_error')] || 'LINE でのログインに失敗しました。'}${hint ? `\n${hint}` : ''}${detail ? `（理由：${detail}）` : ''}`, kind: 'err' };
  }
  else if (q.get('line_ok') === 'linked') flash = { text: 'LINE と連携しました。次からは LINE でログインできます。', kind: 'ok' };
  // LINE の結果だけ消す（?utm_source= などは Google アナリティクスが読むので残す）
  if (q.has('line_error') || q.has('line_ok') || q.has('detail')) {
    ['line_error', 'line_ok', 'detail'].forEach((k) => q.delete(k));
    history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
  }
}

// どこから来たか（X・Facebook・Instagram・LINE など）を判定して覚えておく。投票したときに票と一緒に記録される
function rememberSource() {
  try {
    const q = new URLSearchParams(location.search);
    const src = detectSource({
      param: q.get('s') || q.get('utm_source'),
      userAgent: navigator.userAgent,
      referrer: document.referrer,
      ownHost: location.hostname,
    });
    if (src) document.cookie = sourceCookie(src);
  } catch { /* 判定できなくても投票はできる */ }
}

async function start() {
  rememberSource();
  readLineResult();
  config = await api('/config').catch(() => config);
  await loadMe();
  window.addEventListener('hashchange', router);
  router();
}
start();
