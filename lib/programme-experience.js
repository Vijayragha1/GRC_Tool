'use strict';

// Presentation metadata only. Domain services continue to own every transition.
const PROGRAMMES = Object.freeze({
  iso27001: { label: 'ISO 27001', wave: 1, path: 'gap-assessment', review: 'review-queue', reports: 'assurance', endpoint: 'The contracted assessment or certification-support outcome' },
  csf: { label: 'Cybersecurity maturity', wave: 2, path: 'csf', review: 'csf/current/review', reports: 'csf/current/report', endpoint: 'Independently reviewed Policy and Practice conclusions and a controlled report' },
  iso42001: { label: 'ISO 42001', wave: 3, path: 'iso42001/gap-assessment', review: 'review-queue', reports: 'iso42001', endpoint: 'The agreed AI management system scope' },
  dpdpa: { label: 'DPDPA assessment', wave: 4, path: 'dpdpa', review: 'dpdpa/current/review', reports: 'dpdpa/current/report', endpoint: 'An independently approved assessment snapshot as of the recorded date' },
  tprm: { label: 'Third-party risk', wave: 5, path: 'tprm', review: 'tprm/assessments', reports: 'tprm/reports', endpoint: 'The contracted service period, preserving client decision authority' },
  vciso: { label: 'vCISO advisory', wave: 6, path: 'delivery', review: 'delivery?view=qa', reports: 'delivery?view=reports', endpoint: 'The agreed advisory scope and governance cadence' },
  shared: { label: 'Shared delivery', wave: 1, path: 'delivery', review: 'delivery?view=qa', reports: 'assurance', endpoint: 'The agreed engagement deliverables' }
});

function frameworkCodes(value) {
  if (Array.isArray(value)) return value.filter(code => PROGRAMMES[code]);
  try { return frameworkCodes(JSON.parse(value || '[]')); } catch (_) { return []; }
}

function programmeFor(workspace, explicit) {
  if (PROGRAMMES[explicit]) return explicit;
  const codes = frameworkCodes(workspace.frameworks);
  if (codes.length === 1) return codes[0];
  if (!codes.length) {
    const services=['tprm','vciso'].filter(code=>workspace[`${code}_enabled`]);
    if(services.length===1)return services[0];
  }
  return 'shared';
}

function programmeCards(workspace) {
  const codes = frameworkCodes(workspace.frameworks);
  if (workspace.tprm_enabled) codes.push('tprm');
  if (workspace.vciso_enabled) codes.push('vciso');
  return [...new Set(codes)].map(code => ({ code, ...PROGRAMMES[code], href: `/workspaces/${workspace.id}/${PROGRAMMES[code].path}` }));
}

module.exports = { PROGRAMMES, frameworkCodes, programmeFor, programmeCards };
