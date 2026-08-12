'use strict';

// Firm-authored assessment guidance for every NIST CSF 2.0 Subcategory.
// NIST outcome text and Implementation Examples remain authoritative source
// material in nist-csf.js. This module adds a consistent, evidence-led
// consulting methodology without presenting the capability scale as a NIST
// score or using it to infer CSF Tiers.

const FUNCTION_EVIDENCE = {
  GV: ['approved governance records', 'risk appetite and committee records', 'roles, policies and decision logs'],
  ID: ['asset and service inventories', 'risk assessments and threat records', 'dependency and vulnerability records'],
  PR: ['approved procedures and configurations', 'access, training and protection records', 'operating metrics and exception logs'],
  DE: ['monitoring coverage and alert records', 'detection procedures and use cases', 'investigation and escalation records'],
  RS: ['incident plans and exercised playbooks', 'incident tickets and decision timelines', 'communications and lessons learned'],
  RC: ['recovery plans and restoration evidence', 'exercise and recovery-test results', 'stakeholder communications and improvement records'],
};

const FUNCTION_PITFALLS = {
  GV: ['Responsibility exists informally but authority and escalation are unclear.', 'Governance is documented but not connected to enterprise risk decisions.', 'Management cannot demonstrate periodic review or follow-through.'],
  ID: ['Inventories or assessments are incomplete, stale, or not reconciled.', 'Risk conclusions are not tied to business services and impact.', 'Threat, vulnerability, supplier, and dependency information is assessed in separate silos.'],
  PR: ['A policy is treated as proof that the control operates.', 'Implementation is inconsistent across systems, locations, or user populations.', 'Exceptions exist without ownership, expiry, monitoring, or risk acceptance.'],
  DE: ['Monitoring is enabled but coverage, tuning, and response ownership are unknown.', 'Alerts are counted without measuring whether relevant events are detected in time.', 'Detection capability is not tested against realistic threat scenarios.'],
  RS: ['Plans are generic, untested, or disconnected from actual systems and decision makers.', 'Incident evidence does not preserve decisions, timing, containment, and communications.', 'Lessons learned are recorded but do not produce controlled improvements.'],
  RC: ['Recovery priorities are not aligned to business impact and dependency information.', 'Backups are mistaken for proven recovery capability.', 'Exercises do not demonstrate restoration criteria, communications, and return-to-normal decisions.'],
};

const CAPABILITY_LADDER = {
  1: 'Ad hoc: the outcome is achieved inconsistently through individual effort, with limited ownership or retained evidence.',
  2: 'Partially implemented: a repeatable practice exists in parts of scope, but coverage, documentation, or execution is inconsistent.',
  3: 'Defined and implemented: the practice is approved, owned, deployed across the agreed scope, and supported by current evidence.',
  4: 'Measured and effective: performance and exceptions are monitored, results are reviewed, and evidence demonstrates consistent effectiveness.',
  5: 'Continuously improved: the practice adapts using metrics, incidents, threat change, testing, and lessons learned.',
};

function cleanExamples(value) {
  return String(value || '')
    .replace(/\s+Ex\d+:/g, '\n- ')
    .replace(/^Ex\d+:/, '- ')
    .trim();
}

function applyGuidance(functions) {
  for (const fn of functions || []) {
    for (const cat of fn.categories || []) {
      const codes = (cat.subcategories || []).map(s => s.code);
      for (const sub of cat.subcategories || []) {
        const examples = cleanExamples(sub.implementation_examples);
        const refs = (sub.iso_27001_refs || [])
          .filter(r => r.value && r.value !== 'None')
          .map(r => `${r.type === 'annex_a' ? 'ISO 27001 Annex A' : 'ISO 27001 clause'} ${r.value}`);
        sub.purpose = `Determine whether the organization can demonstrate the cybersecurity outcome “${sub.description}” across the agreed assessment scope.`;
        sub.what_good_looks_like = examples || `The outcome is formally owned, implemented across scope, evidenced, periodically reviewed, and improved when risk or operating conditions change.`;
        sub.common_pitfalls = [...(FUNCTION_PITFALLS[fn.code] || []), `The assessment relies on assertion without evidence that specifically supports ${sub.code}.`];
        sub.evidence_to_look_for = [
          ...(FUNCTION_EVIDENCE[fn.code] || []),
          `records showing the practice for ${sub.code} operated during the assessment period`,
          'interview corroboration from both the accountable owner and an operator or consumer',
        ];
        sub.maturity_ladder = { ...CAPABILITY_LADDER };
        sub.related_items = [...codes.filter(code => code !== sub.code).slice(0, 4), ...refs].slice(0, 8);
        sub.guidance_source = 'Firm consulting methodology aligned to NIST CSF 2.0 outcomes and Implementation Examples';
        sub.guidance_reviewed_at = '2026-08-10';
        sub.guidance_methodology_version = 'CSF-CAP-1.0';
      }
    }
  }
  return functions;
}

module.exports = { applyGuidance, CAPABILITY_LADDER };
