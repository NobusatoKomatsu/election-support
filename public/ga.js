// Google アナリティクス（GA4）。GA_ID を空にすると何もしない。
// このサイトは #/poll/1 のような「#」でページを切り替えるので、切り替えのたびに trackPage() で 1 ページとして数える。
(function () {
  'use strict';
  const GA_ID = '';
  window.trackPage = function () {};
  if (!GA_ID) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  // 最初の表示も trackPage() で数えるので、自動の page_view は止める
  window.gtag('config', GA_ID, { send_page_view: false });
  const sc = document.createElement('script');
  sc.async = true;
  sc.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(sc);
  // path は「/poll/1」のような形で渡す（# を外して、レポートで別のページとして見えるようにする）
  window.trackPage = function (path, title) {
    window.gtag('event', 'page_view', {
      page_location: location.origin + path,
      page_path: path,
      page_title: title || document.title,
    });
  };
})();
