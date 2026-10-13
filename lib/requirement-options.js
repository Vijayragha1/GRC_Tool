'use strict';
// The requirements a workspace works against, across every framework it has
// enabled, for the screens the frameworks share: internal audit findings and
// samples, nonconformities, risk treatment, document links and metrics.
//
// Those screens store a requirement as the TEXT column `iso_item_id`. The
// name is historical: it began as a key into the ISO 27001 catalogue
// (iso_items), and every picker read that table, so a client working only to
// ISO 42001 could not tie an audit finding or a nonconformity to any of its own
// clauses or controls. The converged `requirements` table holds every
// framework's catalogue with a ref that is unique across frameworks
// ('annex-a.5.1', 'ai-annex-a-2-2', 'GV.OC-01', 'DPDPA-ACC-01'), and those refs
// are exactly the ids the per-framework catalogues use. So the column needs no
// change to hold any framework's requirement; only the pickers and the joins
// that name the requirement had to stop assuming ISO 27001.

const frameworks = require('./frameworks');

// Frameworks whose requirements these shared screens offer. CSF and DPDPA are
// included when enabled: a nonconformity can be raised against a CSF outcome
// or a DPDPA obligation just as well as against an ISO control.
function enabledCodes(workspace) {
  const codes = frameworks.parseWorkspaceFrameworks(workspace && workspace.frameworks);
  return codes.length ? codes : ['iso27001'];
}

const TYPE_FILTERS = {
  control: ['control', 'subcategory'],
  clause: ['clause'],
};

// Every requirement for the workspace's frameworks, in catalogue order.
// `types` narrows to controls or clauses ('control' | 'clause'); ISO
// structure rows and CSF functions and categories are headings, not
// requirements, so they are never offered.
function list(db, workspace, { types = null } = {}) {
  const codes = enabledCodes(workspace);
  const allowed = types ? [].concat(...[].concat(types).map((t) => TYPE_FILTERS[t] || [t])) : ['clause', 'control', 'subcategory'];
  const rows = db.prepare(`SELECT rq.ref AS id, rq.title, rq.req_type AS type, f.code AS framework
    FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
    WHERE f.code IN (${codes.map(() => '?').join(',')}) AND rq.req_type IN (${allowed.map(() => '?').join(',')})
    ORDER BY rq.sort_order, rq.id`).all(...codes, ...allowed);
  const order = (code) => (frameworks.frameworkMeta(code) || { order: 99 }).order;
  return rows
    .map((r) => ({ ...r, code: codeOf(r), frameworkLabel: label(r.framework), label: `${label(r.framework)} ${r.title}` }))
    .sort((a, b) => order(a.framework) - order(b.framework));
}

// The short reference a reader knows a requirement by: '4.1', 'A.5.15',
// 'A.6.2.4', or the id itself where the title carries no number (CSF
// outcomes, DPDPA obligations).
function codeOf(row) {
  const m = /^((?:A\.)?\d+(?:\.\d+)*)\s/.exec(row.title || '');
  return m ? m[1] : row.id;
}

// A requirement's name for display on a shared screen. When the workspace
// works to more than one framework the framework is named too, since clause
// 4.1 exists in both ISO standards.
function displayTitle(workspace, framework, title) {
  if (!title) return title;
  return enabledCodes(workspace).length > 1 && framework ? `${label(framework)} ${title}` : title;
}

// Adds a display name to rows selected with joinSql: rows carry `iso_title`
// and `iso_framework`, and `iso_title` becomes the display name.
function nameRows(workspace, rows) {
  for (const r of rows) r.iso_title = displayTitle(workspace, r.iso_framework, r.iso_title);
  return rows;
}

// The same list grouped by framework, for <optgroup>.
function grouped(db, workspace, opts) {
  const groups = [];
  for (const item of list(db, workspace, opts)) {
    let g = groups.find((x) => x.framework === item.framework);
    if (!g) { g = { framework: item.framework, label: item.frameworkLabel, items: [] }; groups.push(g); }
    g.items.push(item);
  }
  return groups;
}

function label(code) {
  const meta = frameworks.frameworkMeta(code);
  return meta ? meta.shortLabel : code;
}

// Whether `id` is a requirement of one of the workspace's frameworks.
function belongs(db, workspace, id) {
  if (!id) return false;
  const codes = enabledCodes(workspace);
  const row = db.prepare(`SELECT 1 FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
    WHERE rq.ref = ? AND f.code IN (${codes.map(() => '?').join(',')})`).get(id, ...codes);
  return !!row;
}

// SQL that names the requirement in `column`: join it in with this and select
// `${alias}.title` and `${alias}_fw.code`. LEFT joins, so a row that names no
// requirement, or one no longer in any catalogue, still comes back.
function joinSql(column, alias = 'rq') {
  return `LEFT JOIN requirements ${alias} ON ${alias}.ref = ${column}
    LEFT JOIN frameworks ${alias}_fw ON ${alias}_fw.id = ${alias}.framework_id`;
}

// The framework a requirement id belongs to, or null.
function frameworkOf(db, id) {
  if (!id) return null;
  const row = db.prepare(`SELECT f.code FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id WHERE rq.ref = ?`).get(id);
  return row ? row.code : null;
}

module.exports = { enabledCodes, list, grouped, belongs, joinSql, frameworkOf, label, codeOf, displayTitle, nameRows };
