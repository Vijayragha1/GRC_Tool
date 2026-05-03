// Built-in methodology presets selectable from the methodology editor.

module.exports = {
  iso_27005: {
    name: 'ISO 27005:2022 — qualitative 5×5',
    description: 'Standard ISO 27005 qualitative scale aligned with most ISO 27001 audits.',
    likelihood_scale: [
      { value: 1, label: 'Very low',   description: 'Once every 5+ years' },
      { value: 2, label: 'Low',        description: 'Once every 1–5 years' },
      { value: 3, label: 'Medium',     description: 'Once a year' },
      { value: 4, label: 'High',       description: 'Multiple times a year' },
      { value: 5, label: 'Very high',  description: 'Continuous / ongoing' }
    ],
    impact_scale: [
      { value: 1, label: 'Very low',  description: 'Recoverable within hours' },
      { value: 2, label: 'Low',       description: '1 day disruption / minor monetary loss' },
      { value: 3, label: 'Medium',    description: 'Days of disruption / sectoral attention' },
      { value: 4, label: 'High',      description: 'Weeks of disruption / regulator notice' },
      { value: 5, label: 'Very high', description: 'Months / existential' }
    ],
    matrix: [
      ['low','low','low','medium','medium'],
      ['low','low','medium','medium','high'],
      ['low','medium','medium','high','high'],
      ['medium','medium','high','high','critical'],
      ['medium','high','high','critical','critical']
    ],
    thresholds: {
      low:      { color: '#16a34a', action: 'Accept',                    review_months: 24 },
      medium:   { color: '#ca8a04', action: 'Treat or accept',           review_months: 12 },
      high:     { color: '#ea580c', action: 'Treat (mitigate)',          review_months: 6 },
      critical: { color: '#b91c1c', action: 'Treat or transfer ASAP',    review_months: 3 }
    }
  },
  nist_800_30: {
    name: 'NIST SP 800-30 Rev. 1',
    description: 'NIST risk-assessment scale: Very-Low to Very-High on both axes.',
    likelihood_scale: [
      { value: 1, label: 'Very low',  description: 'Highly unlikely (0–4%)' },
      { value: 2, label: 'Low',       description: 'Unlikely (5–20%)' },
      { value: 3, label: 'Moderate',  description: 'Possible (21–79%)' },
      { value: 4, label: 'High',      description: 'Likely (80–95%)' },
      { value: 5, label: 'Very high', description: 'Almost certain (96–100%)' }
    ],
    impact_scale: [
      { value: 1, label: 'Very low',  description: 'Negligible adverse effect' },
      { value: 2, label: 'Low',       description: 'Limited adverse effect' },
      { value: 3, label: 'Moderate',  description: 'Serious adverse effect' },
      { value: 4, label: 'High',      description: 'Severe / catastrophic adverse effect' },
      { value: 5, label: 'Very high', description: 'Multiple severe / catastrophic adverse effects' }
    ],
    matrix: [
      ['low','low','low','low','medium'],
      ['low','low','medium','medium','high'],
      ['low','medium','medium','high','high'],
      ['medium','medium','high','high','critical'],
      ['medium','high','high','critical','critical']
    ],
    thresholds: {
      low:      { color: '#16a34a', action: 'No further action; monitor',    review_months: 24 },
      medium:   { color: '#ca8a04', action: 'Action consideration required', review_months: 12 },
      high:     { color: '#ea580c', action: 'Treatment required',            review_months: 6 },
      critical: { color: '#b91c1c', action: 'Senior leadership intervention',review_months: 3 }
    }
  },
  fair_lite: {
    name: 'FAIR-lite (quantitative bands)',
    description: 'Loss-event-frequency × loss-magnitude in EUR bands. Substitute for full FAIR Monte-Carlo when budget is tight.',
    likelihood_scale: [
      { value: 1, label: 'Rare',   description: '< 0.1 events / yr' },
      { value: 2, label: 'Low',    description: '0.1 – 1 events / yr' },
      { value: 3, label: 'Mod',    description: '1 – 10 events / yr' },
      { value: 4, label: 'High',   description: '10 – 100 events / yr' },
      { value: 5, label: 'V high', description: '> 100 events / yr' }
    ],
    impact_scale: [
      { value: 1, label: '< €10k',     description: 'Single-loss expectancy band' },
      { value: 2, label: '€10k–100k',  description: 'Single-loss expectancy band' },
      { value: 3, label: '€100k–1M',   description: 'Single-loss expectancy band' },
      { value: 4, label: '€1M–10M',    description: 'Single-loss expectancy band' },
      { value: 5, label: '> €10M',     description: 'Existential single-loss expectancy band' }
    ],
    matrix: [
      ['low','low','medium','high','critical'],
      ['low','medium','medium','high','critical'],
      ['low','medium','high','high','critical'],
      ['medium','high','high','critical','critical'],
      ['high','high','critical','critical','critical']
    ],
    thresholds: {
      low:      { color: '#16a34a', action: 'Accept (within risk appetite)',     review_months: 12 },
      medium:   { color: '#ca8a04', action: 'Treat: cost-justified mitigation',  review_months: 6 },
      high:     { color: '#ea580c', action: 'Treat: budget allocated this year', review_months: 3 },
      critical: { color: '#b91c1c', action: 'Treat or transfer immediately',     review_months: 1 }
    }
  },
  three_by_three: {
    name: 'Lightweight 3×3',
    description: 'Compact 3×3 grid for early-stage / smaller orgs.',
    likelihood_scale: [
      { value: 1, label: 'Low',    description: 'Improbable in next 12 months' },
      { value: 2, label: 'Medium', description: 'May occur in next 12 months' },
      { value: 3, label: 'High',   description: 'Expected within 12 months' }
    ],
    impact_scale: [
      { value: 1, label: 'Low',    description: 'Minor / contained' },
      { value: 2, label: 'Medium', description: 'Moderate disruption' },
      { value: 3, label: 'High',   description: 'Severe / business-critical' }
    ],
    matrix: [
      ['low','low','medium'],
      ['low','medium','high'],
      ['medium','high','high']
    ],
    thresholds: {
      low:    { color: '#16a34a', action: 'Accept',          review_months: 24 },
      medium: { color: '#ca8a04', action: 'Treat or accept', review_months: 12 },
      high:   { color: '#b91c1c', action: 'Treat',           review_months: 6 }
    }
  }
};
