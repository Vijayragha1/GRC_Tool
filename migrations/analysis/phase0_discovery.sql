-- phase0_discovery.sql  (READ-ONLY; not applied by the runner)
-- Reproduces the Phase 0 discovery census. Run with:
--   sqlite3 iso27001.db < migrations/analysis/phase0_discovery.sql
-- Results are interpreted in docs/phase0-findings.md.

.headers on
.mode column

-- 1. control_states.assessment_answers shape: total / populated / invalid JSON
SELECT 'control_states.assessment_answers' AS probe,
  (SELECT count(*) FROM control_states) AS total,
  (SELECT count(*) FROM control_states WHERE assessment_answers IS NOT NULL AND assessment_answers <> '') AS populated,
  (SELECT count(*) FROM control_states WHERE assessment_answers IS NOT NULL AND assessment_answers <> '' AND json_valid(assessment_answers)=0) AS invalid_json;

-- 2. control_state_history: rows / distinct (ws,item) / pass_id NULL / populated answers
SELECT 'control_state_history' AS probe,
  (SELECT count(*) FROM control_state_history) AS rows,
  (SELECT count(DISTINCT workspace_id||':'||iso_item_id) FROM control_state_history) AS distinct_ws_item,
  (SELECT count(*) FROM control_state_history WHERE pass_id IS NULL) AS pass_id_null,
  (SELECT count(*) FROM control_state_history WHERE assessment_answers IS NOT NULL AND assessment_answers <> '') AS populated_answers;

-- 3. assessment_passes inventory
SELECT id, workspace_id, pass_number, status FROM assessment_passes;

-- 4. iso_items.questions shape (array-of-strings => index-keyed)
SELECT 'iso_items.questions' AS probe,
  count(*) AS items,
  sum(CASE WHEN questions IS NOT NULL AND questions<>'' THEN 1 ELSE 0 END) AS with_questions,
  sum(CASE WHEN questions IS NOT NULL AND questions<>'' AND json_valid(questions)=0 THEN 1 ELSE 0 END) AS invalid_json
  FROM iso_items;

-- 5. ISO 42001 answer situation (column dropped on iso42001_control_states;
--    history retains the column -- is it populated anywhere?)
SELECT 'iso42001' AS probe,
  (SELECT count(*) FROM iso42001_control_states) AS cs_rows,
  (SELECT count(*) FROM iso42001_control_state_history) AS hist_rows,
  (SELECT count(*) FROM iso42001_control_state_history WHERE assessment_answers IS NOT NULL AND assessment_answers<>'') AS hist_populated_answers;

-- 6. Do SoA payloads embed answer-derived data?
SELECT 'soa_snapshots' AS probe, count(*) AS snaps,
  sum(CASE WHEN payload LIKE '%assessment_answers%' OR payload LIKE '%"answers"%' THEN 1 ELSE 0 END) AS mentions_answers
  FROM soa_snapshots
UNION ALL
SELECT 'iso42001_soa_snapshots', count(*),
  sum(CASE WHEN payload LIKE '%assessment_answers%' OR payload LIKE '%"answers"%' THEN 1 ELSE 0 END)
  FROM iso42001_soa_snapshots;

-- 7. Status / applicability vocab census (control_states) -> normalization map
SELECT 'status' AS dim, COALESCE(status,'(null)') AS value, count(*) AS n FROM control_states GROUP BY status
UNION ALL
SELECT 'applicability', COALESCE(applicability,'(null)'), count(*) FROM control_states GROUP BY applicability
ORDER BY 1, 3 DESC;

-- 8. Per-workspace control_states
SELECT workspace_id, count(*) AS control_states FROM control_states GROUP BY workspace_id ORDER BY workspace_id;

-- 9. CSF catalog version(s) + orphaned-assessment check
SELECT DISTINCT catalog_version FROM csf_functions;
SELECT 'csf_orphaned' AS probe,
  (SELECT count(*) FROM csf_engagements) AS engagements,
  (SELECT count(*) FROM csf_subcategory_assessments) AS assessments,
  (SELECT count(*) FROM csf_subcategory_assessments a LEFT JOIN csf_engagements e ON e.id=a.engagement_id WHERE e.id IS NULL) AS assessments_without_engagement;

-- 10. framework_mappings disposition for Phase 1 (only iso27001/iso42001/csf/soc2 loaded as requirements)
SELECT framework,
  CASE WHEN framework='soc2' THEN 'resolvable->soc2'
       WHEN framework='nist_csf' THEN 'maybe->csf'
       ELSE 'not loaded -> cannot become requirement_mapping' END AS disposition,
  count(*) AS n
  FROM framework_mappings GROUP BY framework ORDER BY n DESC;

-- 11. Evidence reconciliation (Phase 2): trio counts + unmirrored rows
SELECT 'evidence' AS t, count(*) AS n FROM evidence
UNION ALL SELECT 'evidence_controls', count(*) FROM evidence_controls
UNION ALL SELECT 'evidence_links', count(*) FROM evidence_links
UNION ALL SELECT 'csf_evidence_items', count(*) FROM csf_evidence_items
UNION ALL SELECT 'evidence_controls_not_in_links',
  (SELECT count(*) FROM evidence_controls ec WHERE NOT EXISTS
    (SELECT 1 FROM evidence_links el WHERE el.evidence_id=ec.evidence_id AND el.framework='iso27001' AND el.item_ref=ec.iso_item_id))
UNION ALL SELECT 'evidence_links_not_in_controls',
  (SELECT count(*) FROM evidence_links el WHERE el.framework='iso27001' AND NOT EXISTS
    (SELECT 1 FROM evidence_controls ec WHERE ec.evidence_id=el.evidence_id AND ec.iso_item_id=el.item_ref));

-- 12. Remediation trackers (Phase 6) + severity-scheme census
SELECT 'risks' t,count(*) n FROM risks
UNION ALL SELECT 'risk_treatments',count(*) FROM risk_treatments
UNION ALL SELECT 'risk_treatment_actions',count(*) FROM risk_treatment_actions
UNION ALL SELECT 'nonconformities',count(*) FROM nonconformities
UNION ALL SELECT 'audit_findings',count(*) FROM audit_findings
UNION ALL SELECT 'audit_observations',count(*) FROM audit_observations
UNION ALL SELECT 'improvements',count(*) FROM improvements
UNION ALL SELECT 'csf_findings',count(*) FROM csf_findings
UNION ALL SELECT 'csf_recommendations',count(*) FROM csf_recommendations
UNION ALL SELECT 'csf_remediation_status',count(*) FROM csf_remediation_status
UNION ALL SELECT 'supplier_findings',count(*) FROM supplier_findings;

SELECT 'nonconformities' src, COALESCE(severity,'(null)') severity, count(*) n FROM nonconformities GROUP BY severity
UNION ALL SELECT 'audit_findings', COALESCE(severity,'(null)'), count(*) FROM audit_findings GROUP BY severity;

-- 13. Phase 2b / 5 donor + post-delta table volumes
SELECT 'soc2_engagements' t,count(*) n FROM soc2_engagements
UNION ALL SELECT 'soc2_requests',count(*) FROM soc2_requests
UNION ALL SELECT 'soc2_request_evidence',count(*) FROM soc2_request_evidence
UNION ALL SELECT 'supplier_questionnaires',count(*) FROM supplier_questionnaires
UNION ALL SELECT 'questionnaire_templates',count(*) FROM questionnaire_templates
UNION ALL SELECT 'questionnaire_questions',count(*) FROM questionnaire_questions
UNION ALL SELECT 'questionnaire_template_versions',count(*) FROM questionnaire_template_versions
UNION ALL SELECT 'questionnaire_question_bank',count(*) FROM questionnaire_question_bank
UNION ALL SELECT 'recurring_questionnaire_schedules',count(*) FROM recurring_questionnaire_schedules
UNION ALL SELECT 'supplier_reviews',count(*) FROM supplier_reviews;
