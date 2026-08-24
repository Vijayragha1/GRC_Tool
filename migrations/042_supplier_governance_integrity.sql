-- Supplier contract and decision governance integrity.
--
-- Preserve every historic decision exactly while making all new decisions
-- replay-safe and their lineage explicit. If a legacy database has multiple
-- active rows for one supplier, the unique index intentionally fails the
-- migration so that ambiguous governance history receives human remediation.

ALTER TABLE supplier_decisions
  ADD COLUMN idempotency_nonce TEXT;

ALTER TABLE supplier_decisions
  ADD COLUMN request_fingerprint TEXT;

ALTER TABLE supplier_decisions
  ADD COLUMN expected_current_decision_id INTEGER REFERENCES supplier_decisions(id);

ALTER TABLE supplier_decisions
  ADD COLUMN supersedes_id INTEGER REFERENCES supplier_decisions(id);

CREATE INDEX IF NOT EXISTS idx_supplier_decisions_supersedes
  ON supplier_decisions(supersedes_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_decisions_supersession_lineage
  ON supplier_decisions(supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_decisions_idempotency
  ON supplier_decisions(idempotency_nonce)
  WHERE idempotency_nonce IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_decisions_one_active
  ON supplier_decisions(workspace_id,supplier_id)
  WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_decisions_expected_current
  ON supplier_decisions(expected_current_decision_id);

-- New route-created decisions carry all four concurrency fields. Historical
-- and fixture decisions may retain NULL metadata, but a partially populated or
-- cross-supplier lineage is never accepted.
CREATE TRIGGER IF NOT EXISTS trg_supplier_decision_governed_insert
BEFORE INSERT ON supplier_decisions
FOR EACH ROW
WHEN (
   NEW.idempotency_nonce IS NOT NULL
   OR NEW.request_fingerprint IS NOT NULL
   OR NEW.expected_current_decision_id IS NOT NULL
   OR NEW.supersedes_id IS NOT NULL
 )
 AND (
   length(COALESCE(NEW.idempotency_nonce,''))<32
   OR length(NEW.idempotency_nonce)>128
   OR NEW.idempotency_nonce<>trim(NEW.idempotency_nonce)
   OR length(COALESCE(NEW.request_fingerprint,''))<>64
   OR COALESCE(NEW.request_fingerprint,'') GLOB '*[^0-9a-f]*'
   OR NEW.expected_current_decision_id IS NOT NEW.supersedes_id
   OR (
     NEW.supersedes_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM supplier_decisions prior
        WHERE prior.id=NEW.supersedes_id
          AND prior.workspace_id=NEW.workspace_id
          AND prior.supplier_id=NEW.supplier_id
     )
   )
 )
BEGIN
  SELECT RAISE(ABORT,'invalid governed supplier decision concurrency metadata');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_decision_concurrency_immutable
BEFORE UPDATE OF idempotency_nonce,request_fingerprint,expected_current_decision_id,supersedes_id
ON supplier_decisions
BEGIN
  SELECT RAISE(ABORT,'supplier decision concurrency metadata is immutable');
END;

-- Existing invalid reviews remain visible for replacement; only a new active
-- review or a new completion transition must carry executed-agreement identity.
CREATE TRIGGER IF NOT EXISTS trg_supplier_contract_agreement_insert
BEFORE INSERT ON supplier_contract_reviews
FOR EACH ROW
WHEN NEW.status!='superseded' AND (
  trim(COALESCE(NEW.agreement_reference,''))=''
  OR NEW.agreement_reference<>trim(NEW.agreement_reference)
  OR length(COALESCE(NEW.agreement_date,''))!=10
  OR COALESCE(NEW.agreement_date,'') NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR strftime('%Y-%m-%d',NEW.agreement_date||' 00:00:00','+0 days') IS NOT NEW.agreement_date
)
BEGIN
  SELECT RAISE(ABORT,'active supplier contract review requires an agreement reference and valid ISO agreement date');
END;

CREATE TRIGGER IF NOT EXISTS trg_supplier_contract_agreement_complete
BEFORE UPDATE OF status ON supplier_contract_reviews
FOR EACH ROW
WHEN NEW.status='complete' AND (
  trim(COALESCE(NEW.agreement_reference,''))=''
  OR NEW.agreement_reference<>trim(NEW.agreement_reference)
  OR length(COALESCE(NEW.agreement_date,''))!=10
  OR COALESCE(NEW.agreement_date,'') NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  OR strftime('%Y-%m-%d',NEW.agreement_date||' 00:00:00','+0 days') IS NOT NEW.agreement_date
)
BEGIN
  SELECT RAISE(ABORT,'completed supplier contract review requires an agreement reference and valid ISO agreement date');
END;
