-- Repair: ISO 27001 intakes recorded against clients that do not have ISO 27001.
--
-- Two sources put them there. POST /workspaces special-cased three
-- single-service clients and sent everyone else to /intake, so a client bought
-- as ISO 42001 or NIST CSF was walked through the ISO 27001 engagement intake.
-- scripts/seed-framework-matrix.js called seedIntake() unconditionally, before
-- its framework loop, so every demo client got one too. Both are fixed; this
-- clears what they left behind.
--
-- Scope of the repair, deliberately narrow:
--   removed  engagement_intake rows        - a questionnaire for a standard the
--                                            client is not assessed against
--   cleared  scope_confirmed_at/_by        - the ISO 27001 clause 4.3 sign-off.
--                                            Left in place it is a latent lie:
--                                            enable ISO 27001 on that client
--                                            later and the setup hub would
--                                            immediately report a scope signed
--                                            off against an intake nobody did.
--   cleared  assets.source_type/source_ref - only where it pointed at the
--                                            deleted intake, so the asset page
--                                            stops linking to an empty one
--   KEPT     workspaces.scope              - the statements are written by the
--                                            client-creation form and are
--                                            framework-appropriate prose worth
--                                            keeping
--   KEPT     the crown-jewel assets        - crown jewels are framework
--                                            agnostic; only the stale lineage
--                                            label is removed
--
-- Only workspaces whose frameworks column is valid JSON are considered. A NULL
-- or malformed value means the legacy default set, which includes iso27001, so
-- those are skipped rather than assumed. Idempotent, and a no-op on a database
-- the bug never touched.

DELETE FROM engagement_intake
 WHERE workspace_id IN (
   SELECT w.id FROM workspaces w
    WHERE json_valid(w.frameworks)
      AND NOT EXISTS (SELECT 1 FROM json_each(w.frameworks) WHERE value = 'iso27001')
 );

UPDATE workspaces
   SET scope_confirmed_at = NULL,
       scope_confirmed_by = NULL
 WHERE scope_confirmed_at IS NOT NULL
   AND json_valid(frameworks)
   AND NOT EXISTS (SELECT 1 FROM json_each(frameworks) WHERE value = 'iso27001');

UPDATE assets
   SET source_type = NULL,
       source_ref = NULL
 WHERE source_type = 'engagement_intake'
   AND workspace_id IN (
     SELECT w.id FROM workspaces w
      WHERE json_valid(w.frameworks)
        AND NOT EXISTS (SELECT 1 FROM json_each(w.frameworks) WHERE value = 'iso27001')
   );
