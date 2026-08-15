-- 030_client_delivery_presentation.sql
-- Client-facing deliverable wording and framework attribution are governed
-- data. They must not depend on exact consultant-facing strings in an EJS
-- template, because those strings can legitimately change over time.

ALTER TABLE engagement_delivery_deliverables ADD COLUMN client_title TEXT;
ALTER TABLE engagement_delivery_deliverables ADD COLUMN client_description TEXT;
ALTER TABLE engagement_delivery_deliverables ADD COLUMN framework_code TEXT NOT NULL DEFAULT 'iso27001';
ALTER TABLE engagement_delivery_deliverables ADD COLUMN requirement_refs TEXT;

UPDATE engagement_delivery_deliverables
SET client_title = CASE (
    SELECT m.milestone_key FROM engagement_delivery_milestones m
    WHERE m.id = engagement_delivery_deliverables.milestone_id
  )
  WHEN 'w1-kickoff' THEN 'Kick-off records and role acknowledgements'
  WHEN 'w1-intake' THEN 'Completed engagement intake and draft scope statement'
  WHEN 'w1-stakeholders' THEN 'Interested parties register and sponsor approval'
  WHEN 'w2-assets' THEN 'Asset register with classification and assigned owners'
  WHEN 'w2-crown' THEN 'Critical asset register approved'
  WHEN 'w3-method' THEN 'Approved risk assessment method'
  WHEN 'w3-risks' THEN 'Risk register completed and prioritised'
  WHEN 'w4-treatment' THEN 'Risk treatment plan'
  WHEN 'w4-soa' THEN 'Statement of Applicability approved'
  WHEN 'w5-policies-a' THEN 'Draft leadership and governance policies'
  WHEN 'w5-objectives' THEN 'Information security objectives agreed'
  WHEN 'w6-policies-b' THEN 'Operational policies ready for review'
  WHEN 'w7-policies-publish' THEN 'Required management-system documents approved'
  WHEN 'w7-awareness' THEN 'Communications and acknowledgement records'
  WHEN 'w8-programme' THEN 'Internal audit programme approved'
  WHEN 'w8-first-audit' THEN 'Internal audit report and findings'
  WHEN 'w9-mrm' THEN 'Management review minutes and decisions'
  WHEN 'w9-actions' THEN 'Improvement actions assigned and tracked'
  WHEN 'w10-pack' THEN 'Certification readiness evidence pack'
  WHEN 'w10-mock' THEN 'Pre-audit improvement actions'
  WHEN 'w10-fixes' THEN 'Priority pre-audit actions completed'
  WHEN 'w11-stage1' THEN 'Stage 1 audit report and findings'
  WHEN 'w11-remediation' THEN 'Audit findings closed and operating evidence ready'
  WHEN 'w12-evidence' THEN 'Evidence coverage report for priority controls'
  WHEN 'w12-handoff' THEN 'Ongoing assurance and surveillance plan'
  WHEN 'continuous-calendar' THEN 'Information security operating calendar approved'
  WHEN 'continuous-surveillance' THEN 'Surveillance and continual-improvement plan approved'
  ELSE title
END,
client_description = COALESCE(client_description, 'Provide this item for review and approval.'),
framework_code = COALESCE(NULLIF(framework_code, ''), 'iso27001'),
requirement_refs = CASE (
    SELECT m.milestone_key FROM engagement_delivery_milestones m
    WHERE m.id = engagement_delivery_deliverables.milestone_id
  )
  WHEN 'w1-kickoff' THEN '5.1, 5.3'
  WHEN 'w1-intake' THEN '4.1, 4.3'
  WHEN 'w1-stakeholders' THEN '4.2'
  WHEN 'w2-assets' THEN 'A.5.9, A.5.10'
  WHEN 'w2-crown' THEN 'A.5.9'
  WHEN 'w3-method' THEN '6.1.2'
  WHEN 'w3-risks' THEN '6.1.2, 8.2'
  WHEN 'w4-treatment' THEN '6.1.3, 8.3'
  WHEN 'w4-soa' THEN '6.1.3.d'
  WHEN 'w5-policies-a' THEN '5.2, 6.2, 7.5.1'
  WHEN 'w5-objectives' THEN '6.2'
  WHEN 'w6-policies-b' THEN 'A.5.15, A.5.19, A.5.24'
  WHEN 'w7-policies-publish' THEN '7.5'
  WHEN 'w7-awareness' THEN '7.3, 7.4, A.6.3'
  WHEN 'w8-programme' THEN '9.2'
  WHEN 'w8-first-audit' THEN '9.2'
  WHEN 'w9-mrm' THEN '9.3'
  WHEN 'w9-actions' THEN '9.3, 10.1'
  WHEN 'w10-pack' THEN '7.5'
  WHEN 'w10-fixes' THEN '10.2'
  WHEN 'w11-remediation' THEN '10.2'
  WHEN 'w12-evidence' THEN '7.5, 9.1'
  WHEN 'continuous-calendar' THEN '9.1, 9.2, 9.3, 10.1'
  WHEN 'continuous-surveillance' THEN '10.1, 10.2'
  ELSE requirement_refs
END;

CREATE INDEX IF NOT EXISTS idx_delivery_deliverables_framework
  ON engagement_delivery_deliverables(workspace_id, framework_code, status);
