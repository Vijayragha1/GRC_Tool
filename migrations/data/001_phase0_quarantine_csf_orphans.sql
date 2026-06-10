-- 001_phase0_quarantine_csf_orphans.sql  (DATA op, run manually with sqlite3; NOT a schema migration)
-- Phase 0 triage of csf_subcategory_assessments rows whose parent engagement
-- does not exist (csf_engagements is empty). Decision: Vijay (2026-06-10) —
-- "quarantine, don't migrate, don't delete" if the forensic check shows seed data.
--
-- Forensic verdict = SEED DATA (orphaned):
--   * 212 rows = exactly 106 CSF subcategories x 2 engagements (ids 1,2); contiguous ids 1-212, no gaps
--   * scored_at / narrative_drafted_at all at a single second (2026-05-14 15:45:53)
--   * narratives are one template with the subcategory code substituted; placeholder company "Acme"
--
-- Quarantine = INSERT the full row payload into migration_quarantine. The source
-- rows are NOT deleted (reversibility). Idempotent via NOT EXISTS guard.
--
-- Reverse with:
--   DELETE FROM migration_quarantine WHERE source_table='csf_subcategory_assessments' AND reason='orphaned seed data';

INSERT INTO migration_quarantine (phase, source_table, source_id, reason, raw_payload)
SELECT 'phase0',
       'csf_subcategory_assessments',
       a.id,
       'orphaned seed data',
       json_object(
         'id', a.id, 'engagement_id', a.engagement_id, 'subcategory_id', a.subcategory_id,
         'current_score', a.current_score, 'target_score', a.target_score, 'narrative', a.narrative,
         'status', a.status, 'is_bulk_set', a.is_bulk_set, 'excluded_from_scope', a.excluded_from_scope,
         'exclusion_rationale', a.exclusion_rationale,
         'evidence_collected_by', a.evidence_collected_by, 'evidence_collected_at', a.evidence_collected_at,
         'narrative_drafted_by', a.narrative_drafted_by, 'narrative_drafted_at', a.narrative_drafted_at,
         'scored_by', a.scored_by, 'scored_at', a.scored_at,
         'reviewed_by', a.reviewed_by, 'reviewed_at', a.reviewed_at,
         'last_edited_by', a.last_edited_by, 'last_edited_at', a.last_edited_at,
         'locked_by_user_id', a.locked_by_user_id, 'locked_at', a.locked_at
       )
FROM csf_subcategory_assessments a
WHERE NOT EXISTS (SELECT 1 FROM csf_engagements e WHERE e.id = a.engagement_id)   -- orphaned only
  AND NOT EXISTS (SELECT 1 FROM migration_quarantine q
                  WHERE q.source_table = 'csf_subcategory_assessments'
                    AND q.source_id = a.id
                    AND q.reason = 'orphaned seed data');                          -- idempotent
