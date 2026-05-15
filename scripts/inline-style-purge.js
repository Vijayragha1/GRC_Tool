#!/usr/bin/env node
// Codemod: replace inline-style properties with semantic utility classes.
//
// Per property we look at every css `key:value` declaration found in any
// style="..." attribute and check it against a mapping table. If a property
// matches, we strip it from the style string and add the corresponding
// class to the element. If the style is empty afterwards we drop the
// attribute entirely; otherwise we keep the rest.
//
// EJS expressions are skipped: any style attribute whose value contains a
// `<%` token is left alone, since the conditional output can contain
// semicolons and partial property pairs that a naive splitter would
// mangle. Those remain for hand-cleanup.

const fs = require('fs');
const path = require('path');

// Composite mappings - a full inline-style value (after sorting its
// `;`-separated declarations) maps to a single utility class. Used to
// replace recurring layout patterns like flex+gap+align that don't make
// sense to decompose into atomic utilities. The codemod tries composite
// matches BEFORE the per-property splitter so that a style attribute
// matching one of these is rewritten in one shot.
const COMPOSITE_TO_CLASS = {
  // .row = display:flex;gap:6px
  'display:flex;gap:6px':                                       'row',
  // .row-center = display:flex;align-items:center;gap:6px
  'align-items:center;display:flex;gap:6px':                    'row-center',
  // .stack = display:flex;flex-direction:column;gap:6px
  'display:flex;flex-direction:column;gap:6px':                 'stack',
  // .grid-2 = display:grid;grid-template-columns:1fr 1fr;gap:12px
  // (also recognises the repeat(2,1fr) shorthand).
  'display:grid;gap:12px;grid-template-columns:1fr 1fr':        'grid-2',
  'display:grid;gap:12px;grid-template-columns:repeat(2,1fr)':  'grid-2'
};

const STYLE_TO_CLASS = {
  'color:#b91c1c':               'text-danger',
  'color:#a16207':               'text-warn',
  'color:#15803d':               'text-success',
  'color:#16a34a':               'text-success',
  'color:var(--text-secondary)': 'text-secondary',
  'color:var(--text-tertiary)':  'text-tertiary',
  'color:var(--ink)':            'text-ink',
  // Redundant inline overrides - body already inherits to --text. Strip,
  // don't add a class.
  'color:var(--text)':           null,
  'grid-column:1/-1':            'col-full',
  'grid-column:1 / -1':          'col-full',
  // Type scale - eight named sizes covering every pixel value in the
  // codebase. Half-step pixel values (10.5/11.5/12.5) get explicit names
  // so it's obvious they're off the standard 6-step scale.
  'font-size:10px':              'text-xxs',
  'font-size:10.5px':            'text-eyebrow',
  'font-size:11px':              'text-xs',
  'font-size:11.5px':            'text-sm',
  'font-size:12px':              'text-base',
  'font-size:12.5px':            'text-md',
  'font-size:13px':              'text-lg',
  'font-size:14px':              'text-xl'
};

// Build a regex that matches the start of any HTML opening tag. We don't
// match the full tag in one pass because EJS expressions inside attribute
// values can contain characters that confuse a single regex; instead we
// scan tag-by-tag with a bounded look-ahead.
const TAG_OPEN = /<([a-zA-Z][a-zA-Z0-9-]*)\b/g;

// Normalize a single property declaration so values with stray whitespace
// (`color: #b91c1c` vs `color:#b91c1c`) hit the same lookup key.
function normalizeDecl(decl) {
  const colon = decl.indexOf(':');
  if (colon < 0) return decl.trim();
  const key = decl.slice(0, colon).trim();
  const value = decl.slice(colon + 1).trim();
  return `${key}:${value}`;
}

// Split a style attribute value into individual property declarations on
// the top-level `;`. We don't recurse into parens (no url(...) values in
// this codebase), but we do trim and skip empties.
function splitDecls(styleValue) {
  return styleValue.split(';').map(s => s.trim()).filter(Boolean);
}

function rewriteTag(src, tagStart) {
  // Find the matching '>' for the opening tag starting at `tagStart`. EJS
  // expressions inside attribute values are safe as long as they don't
  // contain '>'; if one does, we bail on rewriting this tag.
  let i = tagStart;
  let inAttr = false;
  let attrQuote = null;
  while (i < src.length) {
    const c = src[i];
    if (inAttr) {
      if (c === attrQuote) { inAttr = false; attrQuote = null; }
    } else {
      if (c === '"' || c === "'") { inAttr = true; attrQuote = c; }
      else if (c === '>') break;
    }
    i++;
  }
  if (i >= src.length) return null;
  const tagEnd = i; // index of '>'
  const original = src.slice(tagStart, tagEnd + 1);

  // Look for an inline style attribute in this opening tag.
  const styleRe = /\sstyle="([^"]*)"/;
  const m = styleRe.exec(original);
  if (!m) return null;
  const rawValue = m[1];

  // Skip styles that contain an EJS expression. Splitting on `;` inside an
  // expression would mangle conditional rendering.
  if (rawValue.includes('<%')) return null;

  const decls = splitDecls(rawValue);

  // Composite match: if the full style (after normalizing + sorting its
  // declarations alphabetically) equals a composite key, swap the whole
  // attribute for the matching class. This catches recurring layout shapes
  // regardless of the source property order.
  const normalizedAll = decls.map(normalizeDecl).slice().sort().join(';');
  if (Object.prototype.hasOwnProperty.call(COMPOSITE_TO_CLASS, normalizedAll)) {
    const compositeClass = COMPOSITE_TO_CLASS[normalizedAll];
    let rewritten = original.replace(styleRe, '');
    const classRe = /(\sclass=")([^"]*)(")/;
    const cm = classRe.exec(rewritten);
    if (cm) {
      const existing = cm[2].trim();
      const merged = existing ? `${existing} ${compositeClass}` : compositeClass;
      rewritten = rewritten.replace(classRe, `$1${merged}$3`);
    } else {
      const tagNameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rewritten);
      const insertAt = tagNameMatch[0].length;
      rewritten = rewritten.slice(0, insertAt) + ` class="${compositeClass}"` + rewritten.slice(insertAt);
    }
    rewritten = rewritten.replace(/\s{2,}/g, ' ').replace(/\s+>/, '>');
    return { original, rewritten, tagEnd };
  }

  const remaining = [];
  const newClasses = [];
  let matched = 0;
  for (const decl of decls) {
    const normalized = normalizeDecl(decl);
    if (Object.prototype.hasOwnProperty.call(STYLE_TO_CLASS, normalized)) {
      const cls = STYLE_TO_CLASS[normalized];
      if (cls) newClasses.push(cls);
      matched++;
    } else {
      remaining.push(decl);
    }
  }
  if (matched === 0) return null;

  let rewritten;
  if (remaining.length === 0) {
    // Style attribute has no surviving properties - drop it entirely.
    rewritten = original.replace(styleRe, '');
  } else {
    // Reassemble the surviving properties, preserving trailing semicolon if
    // the original had one.
    const trailing = /;\s*$/.test(rawValue) ? ';' : '';
    rewritten = original.replace(styleRe, ` style="${remaining.join(';')}${trailing}"`);
  }

  // Merge any new classes. Add them to an existing class attribute, or
  // insert one right after the tag name.
  if (newClasses.length) {
    const classRe = /(\sclass=")([^"]*)(")/;
    const cm = classRe.exec(rewritten);
    if (cm) {
      const existing = cm[2].trim();
      const merged = existing ? `${existing} ${newClasses.join(' ')}` : newClasses.join(' ');
      rewritten = rewritten.replace(classRe, `$1${merged}$3`);
    } else {
      const tagNameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rewritten);
      const insertAt = tagNameMatch[0].length;
      rewritten = rewritten.slice(0, insertAt) + ` class="${newClasses.join(' ')}"` + rewritten.slice(insertAt);
    }
  }

  // Tidy doubled whitespace introduced by removing the style attribute.
  rewritten = rewritten.replace(/\s{2,}/g, ' ').replace(/\s+>/, '>');

  return { original, rewritten, tagEnd };
}

function transform(src) {
  let out = '';
  let cursor = 0;
  let count = 0;
  let m;
  TAG_OPEN.lastIndex = 0;
  while ((m = TAG_OPEN.exec(src)) !== null) {
    // Skip closing tags and comments. Our regex already ignores '</' but
    // covers '<TagName'.
    const result = rewriteTag(src, m.index);
    if (result) {
      out += src.slice(cursor, m.index);
      out += result.rewritten;
      cursor = result.tagEnd + 1;
      // Move the regex past the rewritten tag to avoid re-scanning it.
      TAG_OPEN.lastIndex = cursor;
      count++;
    }
  }
  out += src.slice(cursor);
  return { out, count };
}

function walk(dir, files) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, files);
    else if (entry.isFile() && p.endsWith('.ejs')) files.push(p);
  }
}

function main() {
  const viewsDir = path.resolve(__dirname, '..', 'views');
  const files = [];
  walk(viewsDir, files);

  let totalSwaps = 0;
  let touched = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const { out, count } = transform(src);
    if (count > 0) {
      fs.writeFileSync(f, out);
      touched++;
      totalSwaps += count;
      console.log(`  ${path.relative(path.resolve(__dirname, '..'), f)}: ${count}`);
    }
  }
  console.log(`\n${totalSwaps} swap${totalSwaps === 1 ? '' : 's'} across ${touched} file${touched === 1 ? '' : 's'}`);
}

main();
