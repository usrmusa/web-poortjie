(function () {
  'use strict';

  if (!/^https?:$/.test(window.location.protocol)) return;

  // GitHub Pages serves extensionless HTML paths. Keep old bookmarks working.
  const pageUrl = new URL(window.location.href);
  pageUrl.pathname = pageUrl.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  if (pageUrl.hostname === 'www.poortjie.info') {
    pageUrl.hostname = 'poortjie.info';
    window.location.replace(pageUrl.href);
    return;
  }
  if (pageUrl.href !== window.location.href) {
    window.history.replaceState(window.history.state, '', pageUrl.href);
  }

  // Do not send development traffic, query strings, or auth redirect parameters.
  if (pageUrl.hostname !== 'poortjie.info') return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', 'G-27H9WZSCGQ', {
    send_page_view: false,
    page_location: pageUrl.origin + pageUrl.pathname
  });

  const tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtag/js?id=G-27H9WZSCGQ';
  document.head.appendChild(tag);

  document.addEventListener('DOMContentLoaded', function () {
    const referrer = document.referrer ? new URL(document.referrer) : null;
    window.gtag('event', 'page_view', {
      page_title: document.title,
      page_location: pageUrl.origin + pageUrl.pathname,
      page_referrer: referrer ? referrer.origin + referrer.pathname : ''
    });
  }, { once: true });
})();
