'use strict';
// Local-timezone (IST, pinned in server.js) date-only / month formatters. Use
// these instead of `.toISOString().slice(0,10|7)` for calendar logic:
// toISOString is always UTC and silently shifts the day/month in
// positive-offset zones like IST (e.g. 1 Jun 00:00 IST -> "2026-05-31" in
// UTC), which breaks month nav.

function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ymLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { ymdLocal, ymLocal };
