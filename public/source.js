// どこから来たか（X・Facebook・Instagram・LINE など）を判定する。サーバー（worker.js）と画面（app.js）の両方で使う。
// 優先順: リンクに付けた ?s= / ?utm_source= → アプリ内ブラウザの印（User-Agent） → 直前のページ（Referer）
const SOURCE_LABELS = {
  x: 'X', facebook: 'Facebook', instagram: 'Instagram', line: 'LINE', threads: 'Threads', tiktok: 'TikTok',
  search: '検索', other: 'その他のサイト', direct: '直接・不明', unknown: '不明（記録開始前）',
};
const SOURCE_PARAM = {
  x: 'x', twitter: 'x', fb: 'facebook', facebook: 'facebook', ig: 'instagram', instagram: 'instagram',
  line: 'line', threads: 'threads', tiktok: 'tiktok',
};

function detectSource({ param, userAgent, referrer, ownHost }) {
  const p = SOURCE_PARAM[String(param || '').toLowerCase()];
  if (p) return p;
  const ua = String(userAgent || '');
  if (/Instagram/.test(ua)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB|FBIOS/.test(ua)) return 'facebook';
  if (/Barcelona/.test(ua)) return 'threads';
  if (/\bLine\//i.test(ua)) return 'line';
  if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) return 'tiktok';
  if (/Twitter/i.test(ua)) return 'x';
  let host = '';
  try { host = new URL(referrer).hostname.toLowerCase(); } catch { return null; }
  if (!host || host === ownHost) return null; // 自分のサイト内の移動は「経路」ではない
  const is = (d) => host === d || host.endsWith(`.${d}`);
  if (is('t.co') || is('x.com') || is('twitter.com')) return 'x';
  if (is('facebook.com') || is('fb.me') || is('fb.com')) return 'facebook';
  if (is('instagram.com')) return 'instagram';
  if (is('threads.net') || is('threads.com')) return 'threads';
  if (is('line.me') || is('line-apps.com') || is('naver.jp')) return 'line';
  if (is('tiktok.com')) return 'tiktok';
  if (/(^|\.)google\.[a-z.]+$/.test(host) || is('bing.com') || is('yahoo.co.jp') || is('search.yahoo.com') || is('duckduckgo.com')) return 'search';
  return 'other';
}

// 判定できたときだけ覚えておく cookie（30 日）。直接来たときは前の経路を残す
const SOURCE_COOKIE_MAX_AGE = 30 * 86400;
function sourceCookie(src) {
  return `src=${src}; Path=/; Max-Age=${SOURCE_COOKIE_MAX_AGE}; SameSite=Lax; Secure`;
}

// ブラウザでは <script> で、Worker では import で読み込むので、どちらでも使えるよう globalThis に置く
globalThis.SourceDetect = { SOURCE_LABELS, detectSource, sourceCookie };
