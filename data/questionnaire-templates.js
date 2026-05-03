// System questionnaire templates for supplier security assessment.
// Inspired by SIG Lite, CAIQ, and standard privacy/data-protection questionnaires.
// Each question has: section, question, type (yes_no/text/scale_1_5), weight, expected_answer.
// `expected_answer` is what scores positive (e.g., "yes" for security questions).

module.exports = [
  {
    name: 'Vendor Security Assessment (SIG Lite-style)',
    description: 'A general-purpose information security questionnaire for vendors and suppliers, covering governance, access control, data protection, incident management, business continuity, and compliance.',
    category: 'security',
    questions: [
      // 1. Governance & Risk
      { section: 'Governance & Risk Management', q: 'Do you have a documented information security policy approved by senior management and reviewed at least annually?', expected: 'yes', iso: 'A.5.1' },
      { section: 'Governance & Risk Management', q: 'Do you have a designated information security officer or equivalent role?', expected: 'yes', iso: 'A.5.2' },
      { section: 'Governance & Risk Management', q: 'Do you have a formal risk management process for identifying, assessing, and treating information security risks?', expected: 'yes', iso: '6.1.2' },
      { section: 'Governance & Risk Management', q: 'Are you ISO 27001 certified or do you hold a SOC 2 Type II report?', expected: 'yes', iso: '' },
      // 2. Access Control
      { section: 'Access Control', q: 'Is access to systems and data granted based on the principle of least privilege?', expected: 'yes', iso: 'A.5.15' },
      { section: 'Access Control', q: 'Is multi-factor authentication enforced for all remote and privileged access?', expected: 'yes', iso: 'A.5.17, A.8.5' },
      { section: 'Access Control', q: 'Are access reviews performed at planned intervals?', expected: 'yes', iso: 'A.5.18' },
      { section: 'Access Control', q: 'Is access promptly revoked upon termination or role change?', expected: 'yes', iso: 'A.5.18' },
      // 3. Data Protection
      { section: 'Data Protection', q: 'Is sensitive customer data encrypted at rest using current industry-standard algorithms?', expected: 'yes', iso: 'A.8.24' },
      { section: 'Data Protection', q: 'Is sensitive data encrypted in transit using TLS 1.2 or higher?', expected: 'yes', iso: 'A.8.24' },
      { section: 'Data Protection', q: 'Do you have a documented data classification scheme that you apply to customer data?', expected: 'yes', iso: 'A.5.12' },
      { section: 'Data Protection', q: 'Do you have documented procedures for secure deletion of customer data?', expected: 'yes', iso: 'A.8.10' },
      // 4. Endpoint & Network Security
      { section: 'Endpoint & Network Security', q: 'Are endpoints protected with managed anti-malware, full-disk encryption, and centralized configuration?', expected: 'yes', iso: 'A.8.1, A.8.7' },
      { section: 'Endpoint & Network Security', q: 'Is your production network segmented from corporate and development networks?', expected: 'yes', iso: 'A.8.22' },
      { section: 'Endpoint & Network Security', q: 'Do you perform vulnerability scanning at planned intervals and remediate findings on a defined SLA?', expected: 'yes', iso: 'A.8.8' },
      { section: 'Endpoint & Network Security', q: 'Have you had an external penetration test within the last 12 months?', expected: 'yes', iso: 'A.8.29' },
      // 5. SDLC
      { section: 'Secure Development', q: 'Do you have a documented secure software development lifecycle (SDLC)?', expected: 'yes', iso: 'A.8.25' },
      { section: 'Secure Development', q: 'Are security requirements specified for new applications and material changes?', expected: 'yes', iso: 'A.8.26' },
      { section: 'Secure Development', q: 'Are static and/or dynamic application security testing tools integrated into the build pipeline?', expected: 'yes', iso: 'A.8.28, A.8.29' },
      { section: 'Secure Development', q: 'Are development, test, and production environments separated, with controlled promotion?', expected: 'yes', iso: 'A.8.31' },
      // 6. Incident Management
      { section: 'Incident Management', q: 'Do you have a documented incident response plan that is exercised at planned intervals?', expected: 'yes', iso: 'A.5.24' },
      { section: 'Incident Management', q: 'Will you notify us of incidents affecting our data within 72 hours of confirmation?', expected: 'yes', iso: 'A.5.20, A.5.26' },
      { section: 'Incident Management', q: 'Do you have a process for collecting and preserving incident evidence (chain of custody)?', expected: 'yes', iso: 'A.5.28' },
      // 7. Business Continuity
      { section: 'Business Continuity', q: 'Do you have a documented business continuity / disaster recovery plan?', expected: 'yes', iso: 'A.5.29, A.5.30' },
      { section: 'Business Continuity', q: 'Do you test your continuity / DR arrangements at planned intervals?', expected: 'yes', iso: 'A.5.30' },
      { section: 'Business Continuity', q: 'Are your services architected for redundancy aligned with stated availability commitments?', expected: 'yes', iso: 'A.8.14' },
      // 8. People
      { section: 'People', q: 'Do you perform background screening on personnel handling customer data, where lawful?', expected: 'yes', iso: 'A.6.1' },
      { section: 'People', q: 'Do all personnel with access to customer data complete information security awareness training at planned intervals?', expected: 'yes', iso: 'A.6.3' },
      { section: 'People', q: 'Do personnel sign confidentiality / non-disclosure agreements?', expected: 'yes', iso: 'A.6.6' },
      // 9. Supplier / Sub-processor
      { section: 'Sub-processors', q: 'Do you maintain a current list of sub-processors that handle customer data, available on request?', expected: 'yes', iso: 'A.5.21' },
      { section: 'Sub-processors', q: 'Do you assess sub-processors against equivalent security standards before engagement?', expected: 'yes', iso: 'A.5.19' },
      // 10. Compliance
      { section: 'Compliance', q: 'Are you compliant with applicable privacy regulations (e.g., GDPR, CCPA, DPDP) where customer data is processed?', expected: 'yes', iso: 'A.5.34' },
      { section: 'Compliance', q: 'Will you sign a data processing agreement (DPA) appropriate to the regulatory regime governing customer data?', expected: 'yes', iso: 'A.5.20, A.5.34' }
    ]
  },

  {
    name: 'Privacy & Data Protection Assessment',
    description: 'Privacy-focused questionnaire for vendors processing personal data — aligned with GDPR Article 28 / DPDP / equivalent regimes.',
    category: 'privacy',
    questions: [
      { section: 'Lawful Basis & Roles', q: 'Will you act exclusively as a processor (or sub-processor) for the personal data we share with you, processing only on documented instructions?', expected: 'yes', iso: 'A.5.34' },
      { section: 'Lawful Basis & Roles', q: 'Have you appointed a Data Protection Officer (DPO) or equivalent privacy lead, where applicable?', expected: 'yes', iso: 'A.5.34' },
      { section: 'Data Handling', q: 'Do you maintain records of processing activities (Article 30 / equivalent)?', expected: 'yes', iso: 'A.5.34' },
      { section: 'Data Handling', q: 'Are personal data flows mapped and reviewed at planned intervals?', expected: 'yes', iso: 'A.5.34' },
      { section: 'Data Subject Rights', q: 'Do you have a process to assist with data subject requests (access, deletion, rectification, portability) within statutory timelines?', expected: 'yes', iso: 'A.5.34' },
      { section: 'International Transfers', q: 'Are cross-border transfers of personal data covered by an appropriate transfer mechanism (SCCs, BCRs, adequacy)?', expected: 'yes', iso: 'A.5.34' },
      { section: 'Sub-processors', q: 'Do you obtain prior approval for engaging new sub-processors that will handle customer personal data?', expected: 'yes', iso: 'A.5.20' },
      { section: 'Sub-processors', q: 'Do sub-processor contracts contain materially equivalent privacy obligations to those between us and you?', expected: 'yes', iso: 'A.5.20' },
      { section: 'Breach Notification', q: 'Will you notify us of a personal data breach without undue delay (and within 72 hours of awareness)?', expected: 'yes', iso: 'A.5.26' },
      { section: 'Security', q: 'Are pseudonymization or encryption used as appropriate to the risk?', expected: 'yes', iso: 'A.8.11, A.8.24' },
      { section: 'Security', q: 'Do you have a documented procedure for the secure deletion of personal data at the end of services?', expected: 'yes', iso: 'A.8.10' },
      { section: 'Audit', q: 'Will you make available all information necessary to demonstrate compliance and allow audits / inspections at reasonable cadence?', expected: 'yes', iso: 'A.5.20' },
      { section: 'Children & Sensitive Categories', q: 'If special-category data (health, biometric, etc.) or children\'s data is involved, are additional safeguards in place?', expected: 'yes', iso: 'A.5.34' },
      { section: 'Retention', q: 'Do you maintain a documented retention schedule and purge data when retention periods elapse?', expected: 'yes', iso: 'A.5.33' },
      { section: 'Privacy by Design', q: 'Are privacy considerations embedded in product and process design (privacy by design / by default)?', expected: 'yes', iso: 'A.5.34' }
    ]
  },

  {
    name: 'Cloud Provider Assessment (CAIQ-style)',
    description: 'Assessment for cloud (IaaS / PaaS / SaaS) providers, derived from CSA CAIQ and ISO 27017 / 27018 themes.',
    category: 'cloud',
    questions: [
      { section: 'Shared Responsibility', q: 'Have you documented the shared responsibility model for the services you provide?', expected: 'yes', iso: 'A.5.23' },
      { section: 'Tenant Isolation', q: 'Are tenants logically isolated within your multi-tenant infrastructure?', expected: 'yes', iso: 'A.8.22' },
      { section: 'Data Location', q: 'Can customers select or restrict the geographic regions where their data is stored?', expected: 'yes', iso: 'A.5.34' },
      { section: 'Encryption', q: 'Is customer data encrypted at rest by default?', expected: 'yes', iso: 'A.8.24' },
      { section: 'Encryption', q: 'Can customers manage their own encryption keys (BYOK / HYOK)?', expected: 'yes', iso: 'A.8.24' },
      { section: 'Identity Federation', q: 'Do you support SSO via SAML / OIDC?', expected: 'yes', iso: 'A.8.5' },
      { section: 'Logging', q: 'Are administrative actions and significant tenant activities logged and retrievable by the customer?', expected: 'yes', iso: 'A.8.15' },
      { section: 'Vulnerability Management', q: 'Do you publish a security advisories / vulnerability disclosure program?', expected: 'yes', iso: 'A.8.8' },
      { section: 'Vulnerability Management', q: 'Are critical vulnerabilities remediated within a documented SLA?', expected: 'yes', iso: 'A.8.8' },
      { section: 'Personnel', q: 'Are personnel with access to customer environments trained, screened, and subject to least privilege?', expected: 'yes', iso: 'A.6.1, A.5.15' },
      { section: 'Customer Access', q: 'Is customer data accessed by your personnel only on documented instructions or for legitimate operational reasons, with logging?', expected: 'yes', iso: 'A.5.15' },
      { section: 'Backups', q: 'Are backups of tenant data taken, encrypted, and tested for restoration?', expected: 'yes', iso: 'A.8.13' },
      { section: 'Resilience', q: 'Do you provide a published SLA with stated availability targets and remedies?', expected: 'yes', iso: 'A.8.14' },
      { section: 'Resilience', q: 'Is your service architected with multi-AZ / multi-region redundancy?', expected: 'yes', iso: 'A.8.14' },
      { section: 'Termination', q: 'Will customer data be returned and / or securely deleted within a defined period after contract termination?', expected: 'yes', iso: 'A.5.20, A.8.10' },
      { section: 'Sub-processors', q: 'Is your list of sub-processors published or available on request, with notification of changes?', expected: 'yes', iso: 'A.5.21' },
      { section: 'Compliance', q: 'Are you ISO 27017 / 27018 / SOC 2 Type II / equivalent certified?', expected: 'yes', iso: '' },
      { section: 'Customer Audit', q: 'Will you provide audit reports (e.g., SOC 2, ISO 27001) under NDA on request?', expected: 'yes', iso: 'A.5.20' }
    ]
  }
];
