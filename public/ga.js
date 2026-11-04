// Google アナリティクス（Google タグ GTM-NR5QLNCN）。TAG_ID を空にすると何もしない。
// 最初に開いたページは Google タグが自動で数える。
// このサイトは #/poll/1 のような「#」で画面を切り替えるので、切り替えのたびに trackPage() で
// /poll/1 のようなパスの page_view を送る（そのままだと、どの画面もトップとして数えられるため）。
(function () {
  'use strict';
  const TAG_ID = 'GTM-NR5QLNCN';
  window.trackPage = function () {};
  if (!TAG_ID) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  const sc = document.createElement('script');
  sc.async = true;
  sc.src = `https://www.googletagmanager.com/gtm.js?id=${TAG_ID}`;
  document.head.appendChild(sc);

  let first = true;
  window.trackPage = function (path, title) {
    if (first) { first = false; return; } // 最初の表示は Google タグが数える
    window.gtag('event', 'page_view', {
      page_location: location.origin + path,
      page_path: path,
      page_title: title || document.title,
    });
  };
})();
