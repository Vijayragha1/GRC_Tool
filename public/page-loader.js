(function () {
  'use strict';

  var minimumVisibleMs = 220;
  var shownAt = performance.now();
  var hideTimer = null;

  function elements() {
    return {
      loader: document.getElementById('pageLoader'),
    };
  }

  function show() {
    var parts = elements();
    if (!parts.loader) return;
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!parts.loader.classList.contains('is-active')) shownAt = performance.now();
    parts.loader.classList.add('is-active');
    parts.loader.setAttribute('aria-hidden', 'false');
  }

  function hide(options) {
    var parts = elements();
    if (!parts.loader) return;
    var immediate = !!(options && options.immediate);
    var remaining = immediate ? 0 : Math.max(0, minimumVisibleMs - (performance.now() - shownAt));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      parts.loader.classList.remove('is-active');
      parts.loader.setAttribute('aria-hidden', 'true');
      hideTimer = null;
    }, remaining);
  }

  window.AppPageLoader = Object.freeze({ show: show, hide: hide });

  function settleInitialPage() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { hide(); });
    });
  }

  if (document.readyState === 'complete') settleInitialPage();
  else window.addEventListener('load', settleInitialPage, { once: true });

  // Restoring a page from the back-forward cache does not perform a new load.
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) hide({ immediate: true });
  });

  // Native submissions navigate away from the current document. Inline
  // confirmation handlers run before this listener, so cancelled actions do
  // not leave the loader stranded on screen.
  document.addEventListener('submit', function (event) {
    if (event.defaultPrevented) return;
    var form = event.target;
    if (!form || String(form.method || 'get').toLowerCase() === 'dialog') return;
    show(String(form.method || 'get').toLowerCase() === 'get' ? 'Loading results' : 'Saving changes');
  });

  // Full-document links do not pass through the app's SPA-lite navigator.
  // The SPA handler registers first and prevents its clicks, avoiding a
  // duplicate show call here.
  function isDownloadLink(link, url) {
    if (link.hasAttribute('download') || link.dataset.noLoader === '1') return true;

    var path = url.pathname.toLowerCase();
    // Attachment responses leave the current document in place, so there is
    // no subsequent `load` event that could dismiss the overlay. Recognise
    // both filename-style exports and the app's REST-style download routes.
    if (/\.(csv|docx|zip|pdf|xlsx?|png|jpe?g|svg|ico|md|txt)$/.test(path)) return true;
    if (/(^|\/)download(\/|$)/.test(path)) return true;
    if (/(^|\/)export(\/|$)/.test(path)) return true;
    if (/(^|\/)(audit-pack|handover)(\/|$)/.test(path)) return true;
    if (/\/(csv|docx|zip|pdf|xlsx?)(\/|$)/.test(path)) return true;
    return false;
  }

  document.addEventListener('click', function (event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link) return;
    if (link.target && link.target !== '_self') return;
    var url;
    try { url = new URL(link.href, location.href); } catch (_) { return; }
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return;
    if (isDownloadLink(link, url)) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    show('Opening page');
  });

  // A defensive escape hatch: a failed third-party resource must never make
  // the application permanently inaccessible behind the loading layer.
  setTimeout(function () { hide({ immediate: true }); }, 12000);
})();
