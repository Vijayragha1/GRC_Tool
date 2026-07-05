'use strict';
// Shared LIMIT/OFFSET pagination for unbounded list pages.
//
//   const { paginate } = require('./lib/paginate');
//   const pg = paginate(db, req, {
//     count: `SELECT COUNT(*) c FROM evidence WHERE workspace_id = ?`,
//     rows:  `SELECT * FROM evidence WHERE workspace_id = ? ORDER BY uploaded_at DESC`,
//     params: [ws.id],
//     perPage: 50,
//   });
//   // pg.rows to render, pg for the pager partial
//
// The rows SQL must NOT contain LIMIT/OFFSET; the helper appends them. Page
// comes from ?page, clamped to [1, pages] so a stale link never 404s or
// queries a negative offset. Aggregates that must span the full set (counts,
// heatmaps) stay separate queries by design; never derive them from pg.rows.

function paginate(db, req, { count, rows, params = [], perPage = 50 }) {
  const total = db.prepare(count).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  let page = parseInt((req.query && req.query.page) || '1', 10);
  if (!Number.isFinite(page)) page = 1;
  page = Math.min(Math.max(1, page), pages);
  const items = db.prepare(`${rows} LIMIT ? OFFSET ?`).all(...params, perPage, (page - 1) * perPage);
  return { rows: items, page, pages, total, perPage };
}

// Same contract for lists that are filtered in JS after a full-set query
// (e.g. the evidence library's expiry/tag filters). The full set is still
// read server-side; what pagination buys here is the page payload.
function paginateArray(req, arr, perPage = 50) {
  const total = arr.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  let page = parseInt((req.query && req.query.page) || '1', 10);
  if (!Number.isFinite(page)) page = 1;
  page = Math.min(Math.max(1, page), pages);
  return { rows: arr.slice((page - 1) * perPage, page * perPage), page, pages, total, perPage };
}

// Querystring for a target page, preserving every other filter param.
function pageHref(req, page) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k === 'page' || v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach(x => q.append(k, x)); else q.append(k, v);
  }
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return s ? `?${s}` : '?';
}

module.exports = { paginate, paginateArray, pageHref };
