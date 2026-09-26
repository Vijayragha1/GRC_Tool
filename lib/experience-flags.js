'use strict';

const { PROGRAMMES, frameworkCodes } = require('./programme-experience');

function presentationProgramme(db,workspace){
  if(!workspace)return 'shared';
  const current=db.prepare(`SELECT w.frameworks,
    EXISTS(SELECT 1 FROM tprm_modules m WHERE m.workspace_id=w.id AND m.status IN ('active','needs_classification')) AS tprm_enabled,
    EXISTS(SELECT 1 FROM vciso_services v WHERE v.workspace_id=w.id AND v.status IN ('active','on_hold')) AS vciso_enabled
    FROM workspaces w WHERE w.id=?`).get(workspace.id);
  if(!current)return 'shared';
  const programmes=new Set(frameworkCodes(current.frameworks));
  for(const code of ['tprm','vciso'])if(current[`${code}_enabled`])programmes.add(code);
  // Mixed programmes share the work shell from wave 1 so handoffs and counts
  // never hide obligations from later waves. Native programme lifecycles remain
  // authoritative; this flag only controls the default presentation.
  return programmes.size===1?[...programmes][0]:'shared';
}

// Reads are deliberately side-effect free. No default row is inserted on a GET.
function experienceFor(db, { actor, workspace = null, programme }) {
  if (!actor) return { enabled: false, wave: 0, cohort: null };
  const firmId=actor.user_type==='client'&&workspace?workspace.firm_id:actor.firm_id;
  if (!firmId) return { enabled: false, wave: 0, cohort: null };
  if (workspace && actor.user_type==='client' && !db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get(workspace.id,actor.id)) return { enabled:false,wave:0,cohort:null };
  if (workspace && actor.user_type!=='client' && Number(workspace.firm_id) !== Number(actor.firm_id)) return { enabled: false, wave: 0, cohort: null };
  const rollout = db.prepare('SELECT enabled,wave,cohort FROM experience_rollouts WHERE firm_id=?').get(firmId);
  const override = workspace ? db.prepare('SELECT enabled FROM experience_workspace_overrides WHERE workspace_id=?').get(workspace.id) : null;
  // Explicit environment setting is an emergency presentation switch. Otherwise
  // workspace override > firm cohort > nonproduction default. No default writes.
  const environment = process.env.EXPERIENCE_ENABLED;
  const defaultEnabled = process.env.NODE_ENV !== 'production';
  const enabled = environment === '0' ? false : environment === '1' ? true
    : override ? !!override.enabled : rollout ? !!rollout.enabled : defaultEnabled;
  const wave = rollout?.wave || (defaultEnabled || environment === '1' ? 6 : 1);
  // EXPERIENCE_ENABLED=1 enables presentation but still honours a configured
  // cohort's wave. Without a cohort it enables all six waves for local pilots.
  const selectedProgramme=programme===undefined?presentationProgramme(db,workspace):programme;
  return { enabled: enabled && wave >= (PROGRAMMES[selectedProgramme]?.wave || 1), wave, cohort: rollout?.cohort || (defaultEnabled ? 'development' : null) };
}

function enabledFor(db, input) { return experienceFor(db, input).enabled; }
module.exports = { experienceFor, enabledFor, presentationProgramme };
