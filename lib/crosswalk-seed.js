'use strict';
// Seeds the ISO 27001 <-> ISO 42001 crosswalk (data/iso27001-iso42001-crosswalk.js)
// into requirement_mappings on every boot, once the requirements catalogue
// exists. This is not a migration because on a fresh database the catalogue
// is backfilled after the migration chain runs. ISO 27001 is canonical, as for
// the CSF mappings. A pair someone has edited (mapped_by set) is left alone;
// otherwise the note follows the data file.

const { CLAUSES, CONTROLS } = require('../data/iso27001-iso42001-crosswalk');

function pairs() {
  return [
    ...CLAUSES.map(([n, note]) => [`clause-${n}`, `ai-clause-${n}`, note]),
    ...CONTROLS.map(([ai, iso, note]) => [iso, ai, note]),
  ];
}

function seed(db) {
  const requirement = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
    WHERE f.code = ? AND rq.ref = ? AND f.status = 'active' ORDER BY f.id DESC LIMIT 1`);
  const upsert = db.prepare(`INSERT INTO requirement_mappings (canonical_requirement_id, mapped_requirement_id, coverage, residual_gap_note)
    VALUES (?, ?, 'partial', ?)
    ON CONFLICT (canonical_requirement_id, mapped_requirement_id) DO UPDATE SET residual_gap_note = excluded.residual_gap_note
    WHERE requirement_mappings.mapped_by IS NULL AND COALESCE(requirement_mappings.residual_gap_note, '') != excluded.residual_gap_note`);
  let written = 0;
  db.transaction(() => {
    for (const [isoRef, aiRef, note] of pairs()) {
      const canonical = requirement.get('iso27001', isoRef);
      const mapped = requirement.get('iso42001', aiRef);
      if (canonical && mapped) written += upsert.run(canonical.id, mapped.id, note).changes;
    }
  })();
  return written;
}

module.exports = { seed, pairs };
