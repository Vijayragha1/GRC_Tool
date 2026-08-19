'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { todayFor, workspaceTimeZone, shiftMonth } = require('../lib/dates');

test('workspace timezone overrides the firm default for calendar decisions', () => {
  const instant = new Date('2026-08-16T19:00:00.000Z');
  const firm = { timezone: 'America/Los_Angeles' };
  assert.equal(todayFor({ timezone: 'Asia/Kolkata' }, firm, instant), '2026-08-17');
  assert.equal(todayFor({}, firm, instant), '2026-08-16');
  assert.equal(workspaceTimeZone({}, firm), 'America/Los_Angeles');
});

test('invalid timezone values fall back to UTC and month shifts are calendar safe', () => {
  const instant = new Date('2026-08-16T23:30:00.000Z');
  assert.equal(todayFor({ timezone: 'not/a-zone' }, null, instant), '2026-08-16');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});
