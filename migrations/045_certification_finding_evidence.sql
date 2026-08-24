-- 045_certification_finding_evidence.sql
-- Retain workspace-qualified CAPA proof for Stage 1 and Stage 2 findings.
-- The link itself is audit history: it cannot be rewritten or removed, and
-- neither side can be hard-deleted while the retained link exists.

CREATE UNIQUE INDEX IF NOT EXISTS uq_nonconformities_workspace_id
  ON nonconformities(workspace_id,id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_workspace_id
  ON evidence(workspace_id,id);

CREATE TABLE IF NOT EXISTS nonconformity_evidence_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  nonconformity_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('remediation','validation')),
  linked_by INTEGER NOT NULL,
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id,nonconformity_id,evidence_id,evidence_role),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,nonconformity_id)
    REFERENCES nonconformities(workspace_id,id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,evidence_id)
    REFERENCES evidence(workspace_id,id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(linked_by) REFERENCES users(id) ON DELETE NO ACTION
);

CREATE INDEX IF NOT EXISTS idx_nc_evidence_finding_role
  ON nonconformity_evidence_links(workspace_id,nonconformity_id,evidence_role,linked_at);

CREATE INDEX IF NOT EXISTS idx_nc_evidence_evidence
  ON nonconformity_evidence_links(workspace_id,evidence_id);

CREATE TRIGGER IF NOT EXISTS trg_nc_evidence_link_no_update
BEFORE UPDATE ON nonconformity_evidence_links
BEGIN
  SELECT RAISE(ABORT,'nonconformity evidence lineage is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_nc_evidence_link_no_delete
BEFORE DELETE ON nonconformity_evidence_links
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT,'nonconformity evidence lineage is immutable');
END;

-- Once a finding points to a retained Stage 1/Stage 2 event, generic routes or
-- direct SQL must not rewrite or manufacture that audit lineage.
CREATE TRIGGER IF NOT EXISTS trg_certification_finding_lineage_immutable
BEFORE UPDATE OF workspace_id,source,source_ref ON nonconformities
FOR EACH ROW
WHEN (
  EXISTS (
    SELECT 1 FROM cert_cycle_events ce
    WHERE ce.workspace_id=OLD.workspace_id
      AND ce.event_type IN ('stage_1','stage_2')
      AND OLD.source_ref='cert_cycle_event:' || ce.id
      AND lower(COALESCE(OLD.source,''))='external_audit'
  )
  AND (
    NEW.workspace_id IS NOT OLD.workspace_id
    OR lower(COALESCE(NEW.source,'')) IS NOT lower(COALESCE(OLD.source,''))
    OR NEW.source_ref IS NOT OLD.source_ref
  )
) OR (
  NOT EXISTS (
    SELECT 1 FROM cert_cycle_events ce
    WHERE ce.workspace_id=OLD.workspace_id
      AND ce.event_type IN ('stage_1','stage_2')
      AND OLD.source_ref='cert_cycle_event:' || ce.id
      AND lower(COALESCE(OLD.source,''))='external_audit'
  )
  AND EXISTS (
    SELECT 1 FROM cert_cycle_events ce
    WHERE ce.workspace_id=NEW.workspace_id
      AND ce.event_type IN ('stage_1','stage_2')
      AND NEW.source_ref='cert_cycle_event:' || ce.id
      AND lower(COALESCE(NEW.source,''))='external_audit'
  )
)
BEGIN
  SELECT RAISE(ABORT,'certification finding lineage is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_certification_finding_no_delete
BEFORE DELETE ON nonconformities
FOR EACH ROW
WHEN lower(COALESCE(OLD.source,''))='external_audit'
 AND EXISTS (
   SELECT 1 FROM cert_cycle_events ce
   WHERE ce.workspace_id=OLD.workspace_id
     AND ce.event_type IN ('stage_1','stage_2')
     AND OLD.source_ref='cert_cycle_event:' || ce.id
 )
BEGIN
  SELECT RAISE(ABORT,'certification findings are retained audit history');
END;

CREATE TRIGGER IF NOT EXISTS trg_certification_event_with_findings_no_delete
BEFORE DELETE ON cert_cycle_events
FOR EACH ROW
WHEN OLD.event_type IN ('stage_1','stage_2')
 AND EXISTS (
   SELECT 1 FROM nonconformities n
   WHERE n.workspace_id=OLD.workspace_id
     AND lower(COALESCE(n.source,''))='external_audit'
     AND n.source_ref='cert_cycle_event:' || OLD.id
 )
BEGIN
  SELECT RAISE(ABORT,'certification events with retained findings cannot be deleted');
END;

-- Database-boundary closure proof. The route supplies a more actionable
-- checklist, while these triggers prevent a forgotten write path or direct
-- database mutation from marking an unsupported finding closed or verified.
CREATE TRIGGER IF NOT EXISTS trg_certification_finding_closure_insert
BEFORE INSERT ON nonconformities
FOR EACH ROW
WHEN lower(COALESCE(NEW.status,'')) IN ('closed','verified')
 AND lower(COALESCE(NEW.source,''))='external_audit'
 AND EXISTS (
   SELECT 1 FROM cert_cycle_events ce
   WHERE ce.workspace_id=NEW.workspace_id
     AND ce.event_type IN ('stage_1','stage_2')
     AND NEW.source_ref='cert_cycle_event:' || ce.id
 )
 AND (
   trim(COALESCE(NEW.corrective_action,''))=''
   OR trim(COALESCE(NEW.effectiveness_check,''))=''
   OR (lower(COALESCE(NEW.severity,'')) IN ('major','minor') AND trim(COALESCE(NEW.root_cause,''))='')
   OR NOT EXISTS (
     SELECT 1 FROM nonconformity_evidence_links l
     WHERE l.workspace_id=NEW.workspace_id
       AND l.nonconformity_id=NEW.id
       AND l.evidence_role='validation'
   )
 )
BEGIN
  SELECT RAISE(ABORT,'certification finding closure requires CAPA and validation evidence');
END;

CREATE TRIGGER IF NOT EXISTS trg_certification_finding_closure_update
BEFORE UPDATE OF status,severity,root_cause,corrective_action,effectiveness_check,workspace_id,source,source_ref
ON nonconformities
FOR EACH ROW
WHEN lower(COALESCE(NEW.status,'')) IN ('closed','verified')
 AND lower(COALESCE(NEW.source,''))='external_audit'
 AND EXISTS (
   SELECT 1 FROM cert_cycle_events ce
   WHERE ce.workspace_id=NEW.workspace_id
     AND ce.event_type IN ('stage_1','stage_2')
     AND NEW.source_ref='cert_cycle_event:' || ce.id
 )
 AND (
   trim(COALESCE(NEW.corrective_action,''))=''
   OR trim(COALESCE(NEW.effectiveness_check,''))=''
   OR (lower(COALESCE(NEW.severity,'')) IN ('major','minor') AND trim(COALESCE(NEW.root_cause,''))='')
   OR NOT EXISTS (
     SELECT 1 FROM nonconformity_evidence_links l
     WHERE l.workspace_id=NEW.workspace_id
       AND l.nonconformity_id=NEW.id
       AND l.evidence_role='validation'
   )
 )
BEGIN
  SELECT RAISE(ABORT,'certification finding closure requires CAPA and validation evidence');
END;
