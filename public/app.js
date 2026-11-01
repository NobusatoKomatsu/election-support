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

const app = document.getElementById('app');
const nav = document.getElementById('nav');
let me = null; // { user, balance, max_balance, history }
let timer = null;

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
      <a href="#/me">${esc(me.user.login_id)}</a>
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
    ${rest.length ? `<h2>これまでのテーマ・これからのテーマ</h2>${rest.map(card).join('')}` : ''}`;
}

function pageLogin() {
  app.innerHTML = `
    <h1>ログイン</h1>
    <div class="card">
      <form id="f">
        <label>ログインID <input name="login_id" autocomplete="username" required></label>
        <label>パスワード <input name="password" type="password" autocomplete="current-password" required></label>
        <div id="m"></div>
        <button>ログイン</button>
      </form>
    </div>
    <p class="small"><a href="#/reset">パスワード・ログインIDを忘れた</a>　/　アカウントがない方は <a href="#/register">アカウント作成</a></p>`;
  const f = document.getElementById('f');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: formData(f) });
      await loadMe();
      location.hash = '#/';
    } catch (err) { message(document.getElementById('m'), err.message); }
  };
}

// 携帯番号を入れて「認証コードを送る」→ 届いたコードを入れる、の部品
function smsFields() {
  return `
    <fieldset>
      <legend>携帯電話番号の確認</legend>
      <div style="display:grid;gap:10px">
        <label>携帯電話番号 <span class="hint">1 つの番号につき 1 アカウントです。番号そのものは保存しません</span>
          <input name="phone" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="090-1234-5678" required>
        </label>
        <button type="button" class="ghost" id="send">認証コードを SMS で送る</button>
        <div id="sm"></div>
        <label>認証コード <span class="hint">SMS で届いた数字</span>
          <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required>
        </label>
      </div>
    </fieldset>`;
}

function wireSms(form, purpose) {
  const btn = form.querySelector('#send');
  const box = form.querySelector('#sm');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('/sms/start', { method: 'POST', body: { phone: form.phone.value, purpose } });
      message(box, 'SMS を送りました。届いたコードを入力してください', 'ok');
      form.code.focus();
      let wait = 60;
      const tick = setInterval(() => {
        btn.textContent = wait > 0 ? `再送できるまで ${wait--} 秒` : '認証コードを再送する';
        if (wait < 0) { clearInterval(tick); btn.disabled = false; }
      }, 1000);
    } catch (err) {
      message(box, err.message);
      btn.disabled = false;
    }
  };
}

function pageRegister() {
  app.innerHTML = `
    <h1>アカウント作成</h1>
    <p class="muted">集計に使うのは <strong>年代・性別・年収・年金の受給状況</strong> だけです。氏名・メールアドレス・住所は聞きません。
      携帯電話番号は「1 人 1 アカウント」の確認だけに使い、番号そのものは保存しません。</p>
    <div class="card">
      <form id="f">
        ${smsFields()}
        <label>ログインID <span class="hint">半角英数字と _ . - で 3〜32 文字</span>
          <input name="login_id" autocomplete="username" required pattern="[A-Za-z0-9_.\\-]{3,32}">
        </label>
        <label>パスワード <span class="hint">8 文字以上</span>
          <input name="password" type="password" autocomplete="new-password" minlength="8" required>
        </label>
        ${profileFields()}
        <div id="m"></div>
        <button>作成して始める</button>
      </form>
    </div>
    <p class="small">すでにアカウントがある方は <a href="#/login">ログイン</a></p>`;
  const f = document.getElementById('f');
  wireSms(f, 'register');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/register', { method: 'POST', body: formData(f) });
      await loadMe();
      if (r.restored) alert('以前のアカウントの持ち票と投票履歴を引き継ぎました。');
      location.hash = '#/';
    } catch (err) { message(document.getElementById('m'), err.message); }
  };
}

function pageReset() {
  app.innerHTML = `
    <h1>パスワードの再設定</h1>
    <p class="muted">登録した携帯電話番号に SMS を送って本人確認します。ログインIDも表示します。</p>
    <div class="card">
      <form id="f">
        ${smsFields()}
        <label>新しいパスワード <span class="hint">8 文字以上</span>
          <input name="password" type="password" autocomplete="new-password" minlength="8" required>
        </label>
        <div id="m"></div>
        <button>再設定してログイン</button>
      </form>
    </div>`;
  const f = document.getElementById('f');
  wireSms(f, 'reset');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/reset-password', { method: 'POST', body: formData(f) });
      await loadMe();
      alert(`パスワードを再設定しました。ログインIDは「${r.login_id}」です。`);
      location.hash = '#/';
    } catch (err) { message(document.getElementById('m'), err.message); }
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
    <h2>退会</h2>
    <div class="card">
      <p class="small" style="margin-top:0">ログインID・パスワード・プロフィールを削除します。投票済みの票は集計に残ります。
        二重投票を防ぐため、同じ番号で登録し直すと持ち票と投票履歴を引き継ぎます。</p>
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
    <h2>結果 <span class="live">リアルタイム</span></h2>
    <div id="results" class="card"><p class="muted">読み込み中…</p></div>`;
  renderVote(poll, mine, balance);
  let dim = 'age_group';
  const refresh = async () => {
    try {
      const r = await api(`/polls/${id}/results`);
      renderResults(r, dim, (d) => { dim = d; refresh(); });
    } catch { /* 次の更新で再試行 */ }
  };
  await refresh();
  timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
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

const DIMS = { age_group: '年代', gender: '性別', income: '年収', pension: '年金' };

function groupOrder(dim, keys) {
  const order = { age_group: AGE_ORDER, gender: Object.keys(GENDER), income: Object.keys(INCOME), pension: ['1', '0'] }[dim];
  return keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
function groupLabel(dim, key) {
  return ({ gender: GENDER, income: INCOME, pension: PENSION }[dim] || {})[key] ?? key;
}

function renderResults(r, dim, onDim) {
  const box = document.getElementById('results');
  if (!box) return;
  const opts = r.poll.options;
  const totals = opts.map((o) => ({ ...o, ...r.totals[o.id], net: r.totals[o.id].plus - r.totals[o.id].minus }));
  const scale = Math.max(1, ...totals.map((t) => Math.max(t.plus, t.minus)));
  const ranked = [...totals].sort((a, b) => b.net - a.net);

  const bars = ranked.map((t) => `
    <div class="bar-row">
      <div class="row"><span>${esc(t.label)}</span><span class="net">${signed(t.net)}</span></div>
      <div class="track" role="img" aria-label="${esc(t.label)}: 賛成 ${t.plus} 票、反対 ${t.minus} 票">
        <div class="neg"><span style="width:${(t.minus / scale) * 100}%"></span></div>
        <div class="pos"><span style="width:${(t.plus / scale) * 100}%"></span></div>
      </div>
      <div class="muted small">賛成 ${t.plus} 票・反対 ${t.minus} 票・${t.voters} 人</div>
    </div>`).join('');

  const groups = r.breakdown[dim] || {};
  const keys = groupOrder(dim, Object.keys(groups));
  const table = keys.length ? `
    <div class="table-wrap"><table>
      <tr><th>${DIMS[dim]}</th><th>人数</th>${opts.map((o) => `<th>${esc(o.label)}</th>`).join('')}</tr>
      ${keys.map((k) => {
        const g = groups[k];
        return `<tr><td>${esc(groupLabel(dim, k))}</td><td>${g.voters}</td>${opts.map((o) => {
          const c = g.options[o.id];
          const net = c.plus - c.minus;
          return `<td class="${net > 0 ? 'p' : net < 0 ? 'm' : ''}" title="賛成 ${c.plus} / 反対 ${c.minus}">${signed(net)}</td>`;
        }).join('')}</tr>`;
      }).join('')}
    </table></div>` : '<p class="muted">まだ投票がありません。</p>';

  box.innerHTML = `
    <div class="row"><strong>投票 ${r.voters} 人</strong><span class="muted small">更新 ${new Date(r.updated_at).toLocaleTimeString('ja-JP')}</span></div>
    <div class="legend" style="margin:8px 0 14px"><span><i style="background:var(--plus)"></i>賛成票</span><span><i style="background:var(--minus)"></i>反対票</span><span>数字は 賛成−反対</span></div>
    <div class="bars">${bars}</div>
    <h2>属性別（賛成−反対）</h2>
    <div class="tabs">${Object.entries(DIMS).map(([k, v]) => `<button data-dim="${k}" aria-pressed="${k === dim}">${v}</button>`).join('')}</div>
    ${table}`;
  box.querySelectorAll('[data-dim]').forEach((b) => { b.onclick = () => onDim(b.dataset.dim); });
}

function pageAdmin() {
  let token = '';
  try { token = sessionStorage.getItem('adminToken') || ''; } catch { /* 使えなくても続行 */ }
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  app.innerHTML = `
    <h1>管理：テーマを作る</h1>
    <div class="card">
      <form id="f">
        <label>管理者トークン <input name="token" type="password" required value="${esc(token)}"></label>
        <label>タイトル <input name="title" required maxlength="200"></label>
        <label>説明 <textarea name="description"></textarea></label>
        <label>選択肢 <span class="hint">1 行に 1 つ（2〜20 個）</span><textarea name="options" required>賛成\n反対</textarea></label>
        <label>受付開始 <input name="opens_at" type="datetime-local" required value="${local(now)}"></label>
        <label>受付終了 <input name="closes_at" type="datetime-local" required value="${local(new Date(now.getTime() + 7 * 86400000))}"></label>
        <div id="m"></div>
        <button>作成</button>
      </form>
    </div>
    <h2>投票データを CSV で書き出す</h2>
    <div class="card">
      <form id="x">
        <label>テーマ番号 <input name="id" type="number" min="1" required></label>
        <p class="muted small" style="margin:0">Google スプレッドシートの「ファイル → インポート」で読み込めます。個人を特定する情報は含みません。</p>
        <div id="xm"></div>
        <button class="ghost">ダウンロード</button>
      </form>
    </div>`;
  const remember = (t) => { try { sessionStorage.setItem('adminToken', t); } catch { /* 無視 */ } };
  const f = document.getElementById('f');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(f);
    remember(d.token);
    try {
      const res = await api('/admin/polls', {
        method: 'POST',
        headers: { authorization: `Bearer ${d.token}` },
        body: {
          title: d.title,
          description: d.description,
          options: d.options.split('\n'),
          opens_at: new Date(d.opens_at).getTime(),
          closes_at: new Date(d.closes_at).getTime(),
        },
      });
      location.hash = `#/poll/${res.id}`;
    } catch (err) { message(document.getElementById('m'), err.message); }
  };
  const x = document.getElementById('x');
  x.onsubmit = async (e) => {
    e.preventDefault();
    const t = f.token.value;
    remember(t);
    const id = x.id.value;
    const res = await fetch(`/api/admin/polls/${id}/export`, { headers: { authorization: `Bearer ${t}` } });
    if (!res.ok) { message(document.getElementById('xm'), (await res.json().catch(() => ({}))).error || 'ダウンロードできませんでした'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = `poll-${id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

// ---------- ルーター ----------

async function router() {
  clearInterval(timer);
  timer = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts[0] === 'login') pageLogin();
    else if (parts[0] === 'register') pageRegister();
    else if (parts[0] === 'reset') pageReset();
    else if (parts[0] === 'me') await pageMe();
    else if (parts[0] === 'admin') pageAdmin();
    else if (parts[0] === 'poll' && /^\d+$/.test(parts[1])) await pagePoll(Number(parts[1]));
    else await pageHome();
  } catch (err) {
    app.innerHTML = `<div class="msg err">${esc(err.message)}</div><p><a href="#/">トップへ戻る</a></p>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', router);
loadMe().then(router);
