-- 037_supplier_assessment_lineage.sql
-- Bind contract conclusions to the approved inherent-risk scope that selected
-- their DDQ modules. This prevents a later reassessment from reusing an older
-- contract conclusion as if it covered the new service scope.

ALTER TABLE supplier_contract_reviews
  ADD COLUMN inherent_assessment_id INTEGER REFERENCES supplier_inherent_assessments(id);

UPDATE supplier_contract_reviews
   SET inherent_assessment_id=(
     SELECT ia.id
       FROM supplier_inherent_assessments ia
      WHERE ia.supplier_id=supplier_contract_reviews.supplier_id
        AND ia.status='approved'
      ORDER BY ia.id DESC
      LIMIT 1
   )
 WHERE inherent_assessment_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_supplier_contract_inherent
  ON supplier_contract_reviews(inherent_assessment_id,status);
