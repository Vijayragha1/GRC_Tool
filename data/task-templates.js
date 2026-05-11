module.exports = [
  {
    name: 'New joiner - IT onboarding',
    category: 'onboarding',
    description: 'Day-1 access, equipment, training assignments for a new employee.',
    steps: [
      { title: 'Provision identity (SSO + email)', days_offset: -3 },
      { title: 'Assign role-based access groups',   days_offset: -2 },
      { title: 'Issue laptop + MDM enrolment',      days_offset: -1 },
      { title: 'MFA enrolment',                     days_offset: 0 },
      { title: 'Assign mandatory awareness training', days_offset: 0 },
      { title: 'Assign role-specific training',     days_offset: 0 },
      { title: 'Confirm AUP signed',                days_offset: 1 },
      { title: 'Hardware asset registered',         days_offset: 1 },
      { title: 'Day-30 access review',              days_offset: 30 }
    ]
  },
  {
    name: 'Leaver - IT offboarding',
    category: 'offboarding',
    description: 'Same-day access revocation + asset return + data preservation.',
    steps: [
      { title: 'Disable SSO / email on last day',   days_offset: 0 },
      { title: 'Revoke admin / privileged access',  days_offset: 0 },
      { title: 'Recover hardware + wipe',           days_offset: 1 },
      { title: 'Disable VPN / API keys',            days_offset: 0 },
      { title: 'Mailbox / drive transfer to manager', days_offset: 1 },
      { title: 'Remove from all access groups',     days_offset: 1 },
      { title: 'HR exit interview - security topics', days_offset: 0 },
      { title: 'Final attestation of returned assets / NDA reminder', days_offset: 1 }
    ]
  },
  {
    name: 'Quarterly access review',
    category: 'access_review',
    description: 'Periodic review of user access (A.5.18). Run every 90 days.',
    steps: [
      { title: 'Generate access list per system',   days_offset: 0 },
      { title: 'Send to system owners for review',  days_offset: 1 },
      { title: 'Reconcile against HR active roster', days_offset: 5 },
      { title: 'Revoke accounts flagged for removal', days_offset: 7 },
      { title: 'Document outcomes + retain evidence', days_offset: 10 }
    ]
  },
  {
    name: 'Annual policy review cycle',
    category: 'policy_review',
    description: 'Confirm every published policy is reviewed in the past 12 months.',
    steps: [
      { title: 'List policies + last review date',  days_offset: 0 },
      { title: 'Schedule reviews with policy owners', days_offset: 3 },
      { title: 'Update content based on operational changes', days_offset: 14 },
      { title: 'Re-submit for approval through workflow', days_offset: 21 },
      { title: 'Publish updated versions + ack campaign to staff', days_offset: 28 }
    ]
  },
  {
    name: 'Internal audit kickoff',
    category: 'audit',
    description: 'Tasks needed at the start of every internal audit.',
    steps: [
      { title: 'Define scope + sample size',        days_offset: -10 },
      { title: 'Confirm auditor independence',      days_offset: -10 },
      { title: 'Notify auditees + request artefacts', days_offset: -7 },
      { title: 'Pre-audit checklist',               days_offset: -3 },
      { title: 'Execute audit',                     days_offset: 0 },
      { title: 'Closing meeting + draft findings',  days_offset: 1 },
      { title: 'Promote findings to NCs',           days_offset: 3 },
      { title: 'Final report + management sign-off', days_offset: 7 }
    ]
  },
  {
    name: 'Vendor onboarding',
    category: 'supplier',
    description: 'Pre-contract security due diligence for a new supplier.',
    steps: [
      { title: 'Inherent risk assessment',          days_offset: 0 },
      { title: 'Send security questionnaire',       days_offset: 2 },
      { title: 'Collect attestations (SOC 2, ISO 27001, DPA)', days_offset: 5 },
      { title: 'Review responses + score',          days_offset: 10 },
      { title: 'Contract clauses negotiated',       days_offset: 15 },
      { title: 'Approval recorded + tier assigned', days_offset: 20 },
      { title: 'Schedule first review date',        days_offset: 25 }
    ]
  }
];
