// Custom report templates - markdown bodies with {{placeholders}} resolved
// against report-builder context (workspace, controls, risks, ncs, audits, mrms, suppliers, ...).
// Available placeholders are documented in lib/reports.js.

module.exports = [
  {
    name: 'Stage 1 readiness report',
    description: 'Summary of mandatory records, control coverage, open NCs and management cadence - for stage 1 audit submission.',
    body: `# Stage 1 Readiness Report - {{workspace.client_name}}

Generated: {{today}}
Scope: {{workspace.scope}}

## Readiness scorecard
| Metric | Value |
|--------|-------|
| Stage 1 readiness | {{readiness.stage1}}% |
| Stage 2 readiness | {{readiness.stage2}}% |
| Mandatory records found | {{readiness.records.mandatory.found}}/{{readiness.records.mandatory.total}} |
| Annex A controls implemented | {{metrics.implemented}}/{{metrics.totalItems}} |
| High-severity flags | {{readiness.high_flags_count}} |

## Mandatory documented information
{{records_table}}

## Statement of Applicability summary
- Included: {{soa.included}}
- Excluded: {{soa.excluded}}
- Undecided: {{soa.undecided}}

## Open major nonconformities
{{ncs_table}}

## Management review cadence
- Last MRM: {{last_mrm_date}}
- Last internal audit: {{last_audit_date}}

## Conclusion
The ISMS is {{stage1_verdict}} for stage 1 review.`
  },
  {
    name: 'Risk treatment plan summary',
    description: 'Top risks, treatments, expected residual reduction. For management review input.',
    body: `# Risk Treatment Plan - {{workspace.client_name}}

Generated: {{today}}

## Top 10 risks by inherent score
{{top_risks_table}}

## Open treatment actions
{{treatments_table}}

## Risk acceptance log
{{acceptances_table}}`
  },
  {
    name: 'Internal audit annual summary',
    description: 'Roll-up of internal audits performed across the year - for ISO 9.2 evidence.',
    body: `# Internal Audit Programme - {{workspace.client_name}} {{year}}

Generated: {{today}}

## Audits performed
{{audits_table}}

## Findings + observations summary
- Major NCs: {{findings.major}}
- Minor NCs: {{findings.minor}}
- Observations: {{findings.observations}}
- Open findings: {{findings.open}}
- Closed findings: {{findings.closed}}

## Coverage by Annex A category
{{coverage_table}}`
  },
  {
    name: 'Supplier risk dashboard',
    description: 'TPRM snapshot - tier 1 / 2 / 3 counts, expiring attestations, overdue reviews.',
    body: `# Supplier Risk Dashboard - {{workspace.client_name}}

Generated: {{today}}

## Portfolio
- Active suppliers: {{supplier_summary.total}}
- Critical (tier 1): {{supplier_summary.tier1}}
- Single-source dependencies: {{supplier_summary.single_source}}
- Attestations expiring within 30 days: {{supplier_summary.expiring}}
- Overdue reviews: {{supplier_summary.overdueReview}}

## Top suppliers by residual risk
{{top_suppliers_table}}

## Recently terminated suppliers
{{terminated_table}}`
  },
  {
    name: 'Compliance calendar (next 90 days)',
    description: 'All upcoming reviews, expiries, due dates across the ISMS.',
    body: `# Compliance Calendar - {{workspace.client_name}}

Generated: {{today}}

{{calendar_table}}`
  }
];
