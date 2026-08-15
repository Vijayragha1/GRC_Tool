-- 032_backfill_intake_crown_jewels.sql
-- Existing engagements may already have crown-jewel answers. Adopt a matching
-- unlinked asset where one exists, otherwise create the critical information
-- asset now so deployment does not require every consultant to resave setup.

UPDATE assets
SET source_type = 'engagement_intake',
    source_ref = (
      SELECT MIN(i.question_id)
      FROM engagement_intake i
      WHERE i.workspace_id = assets.workspace_id
        AND i.question_id GLOB 'crown-jewel-[0-9]*'
        AND length(trim(COALESCE(i.answer,''))) > 0
        AND lower(trim(i.answer)) = lower(trim(assets.name))
    ),
    business_criticality = 'critical',
    classification = COALESCE(NULLIF(classification,''), 'restricted')
WHERE source_type IS NULL
  AND source_ref IS NULL
  AND id = (
    SELECT MIN(a2.id) FROM assets a2
    WHERE a2.workspace_id = assets.workspace_id
      AND lower(trim(a2.name)) = lower(trim(assets.name))
      AND a2.source_type IS NULL AND a2.source_ref IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM engagement_intake i
    WHERE i.workspace_id = assets.workspace_id
      AND i.question_id GLOB 'crown-jewel-[0-9]*'
      AND length(trim(COALESCE(i.answer,''))) > 0
      AND lower(trim(i.answer)) = lower(trim(assets.name))
  );

WITH jewels AS (
  SELECT workspace_id, MIN(question_id) AS question_id, trim(answer) AS name
  FROM engagement_intake
  WHERE question_id GLOB 'crown-jewel-[0-9]*'
    AND length(trim(COALESCE(answer,''))) > 0
  GROUP BY workspace_id, lower(trim(answer))
)
INSERT INTO assets
  (workspace_id,name,type,classification,cia_c,cia_i,cia_a,description,business_criticality,source_type,source_ref)
SELECT j.workspace_id,j.name,'information','restricted',3,3,3,
  'Identified as a crown-jewel information asset during client setup. Assign an owner and complete its business-impact and recovery details in the asset register.',
  'critical','engagement_intake',j.question_id
FROM jewels j
WHERE NOT EXISTS (
  SELECT 1 FROM assets a
  WHERE a.workspace_id=j.workspace_id AND lower(trim(a.name))=lower(trim(j.name))
);
