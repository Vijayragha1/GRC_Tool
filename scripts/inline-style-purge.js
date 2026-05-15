#!/usr/bin/env node
// Single-purpose codemod: replace sole-property inline styles in EJS views
// with semantic utility classes. Each mapping is the exact sole-property
// inline-style string -> the class name to add (null means "just strip,
// no class needed - the inline was redundant").
//
// Scope: only sole-property inline styles. Mixed styles like
// `style="font-size:12px;color:#b91c1c;"` are left alone for later passes.
// The opening tag is rewritten atomically so that style attr placement
// (before or after class) doesn't change the outcome.

const fs = require('fs');
const path = require('path');

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

  // Look for an inline style attr in this opening tag whose value matches
  // one of our sole-property targets.
  const styleRe = /\sstyle="([^"]*)"/;
  const m = styleRe.exec(original);
  if (!m) return null;
  const styleValue = m[1].trim().replace(/;\s*$/, '');
  if (!Object.prototype.hasOwnProperty.call(STYLE_TO_CLASS, styleValue)) return null;
  const newClass = STYLE_TO_CLASS[styleValue];

  // Strip the style attribute entirely.
  let rewritten = original.replace(styleRe, '');

  // Merge the new class. If a class attr already exists, append; otherwise
  // insert one right after the tag name (keeps attrs visually together).
  if (newClass) {
    const classRe = /(\sclass=")([^"]*)(")/;
    const cm = classRe.exec(rewritten);
    if (cm) {
      const existing = cm[2].trim();
      const merged = existing ? `${existing} ${newClass}` : newClass;
      rewritten = rewritten.replace(classRe, `$1${merged}$3`);
    } else {
      const tagNameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(rewritten);
      const insertAt = tagNameMatch[0].length;
      rewritten = rewritten.slice(0, insertAt) + ` class="${newClass}"` + rewritten.slice(insertAt);
    }
  }

  // Tidy doubled whitespace introduced by removing the style attr.
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
