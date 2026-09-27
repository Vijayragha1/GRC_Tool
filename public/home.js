// Public home page motion. The page is complete without this script, and
// nothing here runs on a timer: every motion answers the reader.
//  - The headline rises once on load (CSS only, in public/public.css).
//  - Scattered emails, spreadsheets and folders become one record as the
//    reader scrolls, and scatter again on the way back up.
//  - Stages: on wider screens each stage's deliverable lands on a pile
//    beside the table as that stage scrolls past, and lifts off again on
//    the way back up.
//  - Screens settle into place as they scroll into view.
//  - A clicked screen grows to full size, through a view transition where
//    the browser has one.
// With reduced motion only the full-size view runs, without the transition.
(function () {
  'use strict';
  var root = document.documentElement;
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var list = function (sel, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(sel)); };
  var clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };
  var ease = function (t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  if (!reduce) root.classList.add('motion');

  // Scroll sequence: scattered artefacts become one record. Each card starts
  // where its --sx, --sy and --sr put it, scaled so the scatter fits the
  // stage at any width, and travels to its row as the section scrolls.
  var mess = document.querySelector('[data-mess]');
  if (mess && !reduce && window.matchMedia) {
    var roomy = window.matchMedia('(min-width: 761px) and (min-height: 640px)');
    var field = mess.querySelector('.mess-field');
    var mcards = list('[data-mcard]', mess);
    var start = mcards.map(function (c) { return ['--sx', '--sy', '--sr'].map(function (k) { return parseFloat(c.style.getPropertyValue(k)) || 0; }); });
    var spanX = Math.max.apply(null, start.map(function (s) { return Math.abs(s[0]); })) || 1;
    var spanY = Math.max.apply(null, start.map(function (s) { return Math.abs(s[1]); })) || 1;
    var messQueued = false;
    var render = function () {
      messQueued = false;
      if (!mess.classList.contains('live')) return;
      var r = mess.getBoundingClientRect();
      var vh = window.innerHeight || 800;
      var e = ease(clamp((clamp(-r.top / Math.max(r.height - vh, 1), 0, 1) - .12) / .6, 0, 1));
      var cw = mcards[0].offsetWidth;
      var ch = mcards[0].offsetHeight;
      // Room either side of a card, allowing for its tilt.
      var kx = Math.min(1, (field.clientWidth / 2 - cw / 2 - 16) / spanX);
      var ky = Math.min(1, (field.clientHeight / 2 - ch / 2 - cw * .08 - 8) / spanY);
      var gap = Math.min(66, (field.clientHeight - ch - 24) / Math.max(mcards.length - 1, 1));
      var mid = (mcards.length - 1) / 2;
      mcards.forEach(function (c, i) {
        var s = start[i];
        c.style.setProperty('--x', (s[0] * kx * (1 - e)).toFixed(1) + 'px');
        c.style.setProperty('--y', (s[1] * ky * (1 - e) + (i - mid) * gap * e).toFixed(1) + 'px');
        c.style.setProperty('--r', (s[2] * (1 - e)).toFixed(2) + 'deg');
        c.style.setProperty('--c', clamp((e - .55) / .35, 0, 1).toFixed(3));
      });
      mess.classList.toggle('done', e > .6);
    };
    var messQueue = function () { if (!messQueued) { messQueued = true; window.requestAnimationFrame(render); } };
    var messMode = function () {
      mess.classList.toggle('live', roomy.matches);
      if (!roomy.matches) mcards.forEach(function (c) { ['--x', '--y', '--r', '--c'].forEach(function (k) { c.style.removeProperty(k); }); });
      messQueue();
    };
    window.addEventListener('scroll', messQueue, { passive: true });
    window.addEventListener('resize', messQueue);
    if (roomy.addEventListener) roomy.addEventListener('change', messMode); else if (roomy.addListener) roomy.addListener(messMode);
    messMode();
  }

  // Stages and the pile of deliverables.
  var stages = document.querySelector('[data-stages]');
  if (stages && !reduce && window.matchMedia) {
    var wide = window.matchMedia('(min-width: 761px)');
    var rows = list('[data-stage]', stages);
    var tiles = list('[data-tile]', stages);
    var exitMark = stages.querySelector('[data-tile-exit]');
    var end = stages.querySelector('[data-stage-end]');
    var exitAt = rows.map(function (r) { return !!r.querySelector('.st-exit'); }).indexOf(true);
    var queued = false;
    var update = function () {
      queued = false;
      if (!stages.classList.contains('live')) return;
      var line = (window.innerHeight || 800) * .6;
      var reached = 0;
      rows.forEach(function (r, i) {
        var hit = r.getBoundingClientRect().top <= line;
        r.classList.toggle('reached', hit);
        if (hit) reached = i + 1;
      });
      var done = end.getBoundingClientRect().top <= line;
      tiles.forEach(function (t, i) { t.classList.toggle('got', i < reached || (done && i === tiles.length - 1)); });
      if (exitMark) exitMark.classList.toggle('got', exitAt >= 0 && reached > exitAt);
    };
    var queue = function () { if (!queued) { queued = true; window.requestAnimationFrame(update); } };
    var mode = function () {
      stages.classList.toggle('live', wide.matches);
      if (!wide.matches) list('.reached, .got', stages).forEach(function (el) { el.classList.remove('reached', 'got'); });
      queue();
    };
    // A page opened part way down shows the pile as it stands, without
    // every tile landing at once.
    stages.classList.add('instant');
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    if (wide.addEventListener) wide.addEventListener('change', mode); else if (wide.addListener) wide.addListener(mode);
    mode();
    window.requestAnimationFrame(function () { window.requestAnimationFrame(function () { stages.classList.remove('instant'); }); });
  }

  // Screens settle into place as they arrive.
  var shots = list('[data-reveal]');
  if (shots.length && !reduce && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('seen');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: .12 });
    shots.forEach(function (s) { io.observe(s); });
  } else {
    shots.forEach(function (s) { s.classList.add('seen'); });
  }

  // Click a screen to see it full size.
  var dialog = document.querySelector('[data-zoom-dialog]');
  if (dialog && typeof dialog.showModal === 'function') {
    var big = dialog.querySelector('img');
    var from = null;
    var morph = !reduce && typeof document.startViewTransition === 'function';
    // Hands the name "shot" from one image to the other across the change,
    // so the browser animates the first into the second.
    var swap = function (a, b, change) {
      if (!morph) { change(); return; }
      var clear = function () { b.style.viewTransitionName = ''; };
      a.style.viewTransitionName = 'shot';
      var t = document.startViewTransition(function () {
        a.style.viewTransitionName = '';
        b.style.viewTransitionName = 'shot';
        change();
      });
      t.finished.then(clear, clear);
    };
    var open = function (hit) {
      from = hit;
      big.src = hit.currentSrc || hit.src;
      big.alt = hit.alt || 'Screenshot';
      var go = function () { swap(hit, big, function () { dialog.showModal(); }); };
      if (typeof big.decode === 'function') big.decode().then(go, go); else go();
    };
    var close = function () {
      if (!dialog.open) return;
      if (from && document.contains(from)) swap(big, from, function () { dialog.close(); });
      else dialog.close();
    };
    list('img[data-zoom]').forEach(function (i) { i.classList.add('zoomable'); });
    dialog.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    document.addEventListener('click', function (e) {
      var t = e.target;
      var hit = t.closest && t.closest('img[data-zoom]');
      if (hit && !dialog.open) { open(hit); return; }
      if (dialog.open && (t === dialog || t === big || (t.closest && t.closest('[data-zoom-close]')))) close();
    });
  }
})();
