'use strict';
// Seeds the ISO 27001 <-> ISO 42001 crosswalk (data/iso27001-iso42001-crosswalk.js)
// into requirement_mappings on every boot, once the requirements catalogue
// exists. This is not a migration because on a fresh database the catalogue
// is backfilled after the migration chain runs. ISO 27001 is canonical, as for
// the CSF mappings. A pair someone has edited (mapped_by set) is left alone;
// otherwise the coverage label and the note both follow the data file, so a
// correction to a label there reaches an existing database on the next boot.

const { CLAUSES, CONTROLS } = require('../data/iso27001-iso42001-crosswalk');

function pairs() {
  return [
    ...CLAUSES.map(([n, coverage, note]) => [`clause-${n}`, `ai-clause-${n}`, coverage, note]),
    ...CONTROLS.map(([ai, iso, coverage, note]) => [iso, ai, coverage, note]),
  ];
}

function seed(db) {
  const requirement = db.prepare(`SELECT rq.id FROM requirements rq JOIN frameworks f ON f.id = rq.framework_id
    WHERE f.code = ? AND rq.ref = ? AND f.status = 'active' ORDER BY f.id DESC LIMIT 1`);
  const upsert = db.prepare(`INSERT INTO requirement_mappings (canonical_requirement_id, mapped_requirement_id, coverage, residual_gap_note)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (canonical_requirement_id, mapped_requirement_id) DO UPDATE SET coverage = excluded.coverage, residual_gap_note = excluded.residual_gap_note
    WHERE requirement_mappings.mapped_by IS NULL AND (requirement_mappings.coverage != excluded.coverage
      OR COALESCE(requirement_mappings.residual_gap_note, '') != excluded.residual_gap_note)`);
  let written = 0;
  db.transaction(() => {
    for (const [isoRef, aiRef, coverage, note] of pairs()) {
      const canonical = requirement.get('iso27001', isoRef);
      const mapped = requirement.get('iso42001', aiRef);
      if (canonical && mapped) written += upsert.run(canonical.id, mapped.id, coverage, note).changes;
    }
  })();
  return written;
}

module.exports = { seed, pairs };
