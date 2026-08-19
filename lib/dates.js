'use strict';

// Calendar decisions must use the firm or workspace timezone, never the host
// timezone. UTC remains the safe fallback for records created before timezone
// settings existed.
const DEFAULT_TIME_ZONE = 'UTC';

function isValidTimeZone(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeTimeZone(value, fallback = DEFAULT_TIME_ZONE) {
  return isValidTimeZone(value) ? value : (isValidTimeZone(fallback) ? fallback : DEFAULT_TIME_ZONE);
}

function workspaceTimeZone(workspace, firm) {
  return normalizeTimeZone(
    workspace && workspace.timezone,
    (workspace && workspace.firm_timezone) || (firm && firm.timezone) || DEFAULT_TIME_ZONE
  );
}

function partsInZone(input, timeZone = DEFAULT_TIME_ZONE) {
  const date = input instanceof Date ? input : new Date(input);
  const values = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: normalizeTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).forEach(part => { if (part.type !== 'literal') values[part.type] = part.value; });
  return values;
}

function ymdInZone(input = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const p = partsInZone(input, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function ymInZone(input = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const p = partsInZone(input, timeZone);
  return `${p.year}-${p.month}`;
}

function todayFor(workspace, firm, input = new Date()) {
  return ymdInZone(input, workspaceTimeZone(workspace, firm));
}

function shiftMonth(monthKey, offset) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) throw new Error('Month key must use YYYY-MM.');
  const [year,month] = String(monthKey).split('-').map(Number);
  const date = new Date(Date.UTC(year,month-1+Number(offset || 0),1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}

// Backward-compatible aliases now use UTC instead of a process-global zone.
function ymdLocal(input) { return ymdInZone(input, DEFAULT_TIME_ZONE); }
function ymLocal(input) { return ymInZone(input, DEFAULT_TIME_ZONE); }

module.exports = {
  DEFAULT_TIME_ZONE, isValidTimeZone, normalizeTimeZone, workspaceTimeZone,
  partsInZone, ymdInZone, ymInZone, todayFor, shiftMonth, ymdLocal, ymLocal
};
