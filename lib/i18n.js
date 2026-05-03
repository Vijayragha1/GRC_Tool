// Tiny i18n. Loads JSON files from data/locales/<code>.json. Falls back to
// English (or to the key itself) if a translation is missing.

const fs = require('fs');
const path = require('path');

const cache = {};

function load(code) {
  if (cache[code]) return cache[code];
  try {
    const fp = path.join(__dirname, '..', 'data', 'locales', `${code}.json`);
    if (fs.existsSync(fp)) {
      cache[code] = JSON.parse(fs.readFileSync(fp, 'utf8'));
      return cache[code];
    }
  } catch (_) {}
  cache[code] = {};
  return cache[code];
}

function t(locale, key, vars) {
  const dict = load(locale || 'en');
  let str = dict[key] || (locale === 'en' ? key : (load('en')[key] || key));
  if (vars) {
    Object.keys(vars).forEach(k => { str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), vars[k]); });
  }
  return str;
}

function listAvailable() {
  try {
    return fs.readdirSync(path.join(__dirname, '..', 'data', 'locales'))
      .filter(f => f.endsWith('.json')).map(f => f.replace('.json',''));
  } catch (_) { return ['en']; }
}

module.exports = { t, load, listAvailable };
