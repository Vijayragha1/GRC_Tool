'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Reviewed semantic colours. The module's chrome stays neutral; anything with
// a hue has to appear here, which is what stops decoration creeping back in.
//
// The first group is the product's semantic set from app.css. TPRM adopted it
// when the module stopped carrying its own palette: a danger colour here and a
// danger colour one page away were visibly different reds, and the tinted
// badge backgrounds were mixed cool against the product's warm surfaces.
const semanticHex = new Set([
  // Shared semantic set, light and dark, plus the surface tints built on it.
  '#b91c1c', '#fbf1f0', '#e3c6c3', '#b45309', '#faf4e9', '#dccdae',
  '#15803d', '#eef4ee', '#c3d3c4', '#ef9189', '#e4ad69', '#77c995',
  // Retained: dark-theme tints and colours still used by TPRM views.
  '#8f2d2d', '#f9eeee', '#dcbaba', '#79551f', '#f8f3e8', '#d8c7a3',
  '#2f6249', '#edf4ef', '#bdd0c3', '#eeaaaa', '#342526', '#704248',
  '#dfbf80', '#312b20', '#655536', '#a2c7ad', '#223029', '#42634f',
  '#8f2f2f', '#725000', '#176a42', '#a36b00', '#9b3030', '#176846',
  '#8a4b0f', '#a72d2d',
]);
const semanticRgb = new Set(['168,54,54', '150,103,0', '30,126,79', '217,119,6']);

function expandHex(value) {
  const lower = value.toLowerCase();
  if (lower.length === 4) return `#${lower.slice(1).split('').map(char => char + char).join('')}`;
  if (lower.length === 5) return `#${lower.slice(1, 4).split('').map(char => char + char).join('')}`;
  return lower.slice(0, 7);
}

function isGrey(hex) {
  const normalized = expandHex(hex);
  const channels = [normalized.slice(1, 3), normalized.slice(3, 5), normalized.slice(5, 7)];
  return channels[0] === channels[1] && channels[1] === channels[2];
}

function auditedSources() {
  const views = fs.readdirSync(path.join(root, 'views'))
    .filter(name => /^(?:tprm|client_tprm|external_supplier_ddq|supplier_due_diligence|supplier_contract_review|supplier_methodology).*\.ejs$/.test(name))
    .map(name => path.join('views', name));
  const partials = fs.readdirSync(path.join(root, 'views', 'partials'))
    .filter(name => /^tprm.*\.ejs$/.test(name))
    .map(name => path.join('views', 'partials', name));
  return ['public/tprm.css', ...views, ...partials];
}

test('TPRM chrome remains monochrome and non-neutral colour remains semantic-only', () => {
  for (const relative of auditedSources()) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    for (const match of source.matchAll(/:\s*(#[0-9a-f]{3,8})(?=[^0-9a-f]|$)/gi)) {
      const color = expandHex(match[1]);
      assert.ok(isGrey(color) || semanticHex.has(color), `${relative} contains an unreviewed non-neutral colour: ${match[1]}`);
    }
    for (const match of source.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
      const channels = `${match[1]},${match[2]},${match[3]}`;
      const neutral = match[1] === match[2] && match[2] === match[3];
      assert.ok(neutral || semanticRgb.has(channels), `${relative} contains an unreviewed non-neutral RGB colour: ${channels}`);
    }
  }
});

// This assertion used to require the opposite: that TPRM define its own
// #222222 action colour and its own --primary-bg, neutralising the shared
// shell. That is what made the background, the sidebar and the borders change
// colour when you walked from Clients into Third-party risk - the module read
// as a different application rather than a section of this one. The module
// keeps its restrained component vocabulary; it no longer repaints the shell.
test('TPRM chrome inherits the shared palette instead of redefining it', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'tprm.css'), 'utf8');
  assert.match(css, /--tprm-action:\s*var\(--accent\)/);
  assert.match(css, /--tprm-action-hover:\s*var\(--accent-deep\)/);
  assert.match(css, /--tprm-focus:\s*var\(--accent\)/);
  assert.match(css, /--tprm-surface:\s*var\(--bg\)/);
  assert.doesNotMatch(css, /--tprm-(?:navy|info)\s*:/);

  // The shell tokens belong to app.css. Redefining any of them here is what
  // made the two surfaces disagree, so the file must not declare them at all.
  for (const token of [
    '--bg', '--bg-subtle', '--bg-muted', '--bg-deep', '--surface', '--surface-raised',
    '--border', '--border-strong', '--text', '--text-secondary', '--text-tertiary',
    '--accent', '--accent-soft', '--accent-deep', '--accent-contrast', '--ink',
    '--sidebar-bg', '--nav-hover', '--nav-active', '--rail-divider',
    '--primary-bg', '--primary-text', '--primary-border',
    '--workspace-inset', '--table-head-bg',
  ]) {
    assert.doesNotMatch(css, new RegExp(`^\\s*\\${token}\\s*:`, 'm'),
      `public/tprm.css redefines the shared shell token ${token}`);
  }
});
