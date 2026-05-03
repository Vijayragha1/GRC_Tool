// ISO 27001:2022 starter templates — forms and ISMS role cards.

const STARTER = `> **Starting point.** Aligned with ISO 27001:2022. Replace bracketed placeholders, adjust to {{client_name}}'s practices.\n\n---\n`;
const HEADER = (kind) => `${STARTER}
**Document Owner:** {{document_owner}}
**Approved by:** {{approval_authority}}
**Effective Date:** {{date}}
**Review Period:** {{review_period}}
**Annex A reference:** ${kind}

`;

module.exports = [
// =============== Forms ===============
  {
    name: 'Risk Acceptance Form',
    category: 'form',
    description: 'Formal e-signed acceptance of residual risk that exceeds appetite.',
    content: `# Risk Acceptance Form

${HEADER('Clause 6.1.3 / A.5.31')}

> Use the Risk Acceptances feature in the ISMS tool to record this with a tamper-evident e-signature. This form is the printable / contractual equivalent.

## 1. Risk identification
| Field | Value |
|-------|-------|
| Risk ID | [R-NNN] |
| Title | [Title] |
| Asset(s) affected | [Asset names] |
| Threat | [Threat description] |
| Vulnerability | [Vulnerability description] |
| Inherent score (L × I) | [N × N = NN] |
| Residual score (L × I) | [N × N = NN] |
| Linked Annex A control(s) | [Control IDs] |

## 2. Why acceptance is sought
[Explain why treatment to lower residual risk has not been pursued or has reached an acceptable practical minimum. Reference the Risk Treatment Plan if applicable.]

## 3. Compensating controls in place
[List any controls or mitigating circumstances that reduce the practical likelihood or impact, even if the score has not been adjusted.]

## 4. Conditions and triggers for re-review
This acceptance is conditional on the following remaining true:
- [Condition 1]
- [Condition 2]
- [Condition 3]

If any condition changes, the acceptance is revoked and the risk returns to "open" for treatment review.

## 5. Acceptance period
| Field | Value |
|-------|-------|
| Acceptance start | {{date}} |
| Acceptance expires (re-review by) | [DATE] |

## 6. Approver

I, the undersigned, accept the residual risk described above on behalf of {{client_name}} for the period stated. I acknowledge that this acceptance is recorded in the ISMS audit trail with my identity, IP address, and timestamp.

| Approver | |
|---|---|
| Name | [Approver name] |
| Role | [Approver role — must be authorised per the Risk Appetite] |
| Signature | __________________________ |
| Date | {{date}} |

| ISMS Manager (witness) | |
|---|---|
| Name | {{document_owner}} |
| Signature | __________________________ |
| Date | {{date}} |

## 7. Outcome of acceptance
- Risk status set to "accepted" in the register.
- Acceptance recorded in Risk Acceptances log with HMAC signature.
- Re-review scheduled for [DATE] in the compliance calendar.
`
  },
  {
    name: 'Exception / Waiver Request Form',
    category: 'form',
    description: 'Time-bounded exception to a policy or control with compensating measures.',
    content: `# Exception / Waiver Request Form

${HEADER('Clause 7.5 / general')}

## 1. Requestor
| Field | Value |
|-------|-------|
| Name | [Name] |
| Role | [Role] |
| Department | [Department] |
| Date submitted | {{date}} |

## 2. What is the exception requested?
[Describe the policy / control / standard from which an exception is sought. Quote the specific rule.]

| Field | Value |
|-------|-------|
| Source policy / control | [Document — section] |
| Annex A reference | [If applicable] |

## 3. Reason
[Why is the exception needed? Business driver, technical constraint, transitional state.]

## 4. Scope
[What systems / people / data does this exception apply to? Be specific — this is what gets exempted.]

## 5. Compensating controls
[What controls are in place that reduce the residual risk while the exception is active? Be specific.]

## 6. Risk
| Field | Value |
|-------|-------|
| Likelihood (during exception) | [1–5] |
| Impact (during exception) | [1–5] |
| Residual band | [low / medium / high / critical] |
| Linked risk register entry | [R-NNN] |

## 7. Duration
| Field | Value |
|-------|-------|
| Start | [DATE] |
| Sunset (mandatory) | [DATE — max 180 days] |
| Extension policy | New request required; no automatic renewal |

## 8. Approval
| Approver | Name | Decision | Date | Signature |
|----------|------|----------|------|-----------|
| Line manager | | | | |
| ISMS Manager | | | | |
| Risk owner (per appetite) | | | | |

## 9. Outcome
- Exception ID assigned: [E-NNN].
- Recorded in the Exception Register.
- Sunset reminder set in the compliance calendar.
- Linked to relevant control(s) so subsequent control assessments reflect the exception.
`
  },
  {
    name: 'Access Request and Approval Form',
    category: 'form',
    description: 'Granting / changing access to a system or dataset (A.5.15).',
    content: `# Access Request and Approval Form

${HEADER('A.5.15')}

## 1. Subject
| Field | Value |
|-------|-------|
| Name | [Name] |
| Role | [Role] |
| Manager | [Manager] |
| Employment status | [Employee / contractor / partner] |
| Engagement end date (if known) | [DATE] |

## 2. Access being requested
| Field | Value |
|-------|-------|
| System / dataset | [System name] |
| Role / privilege requested | [e.g., "read access to customer-pii dataset", "Jenkins admin"] |
| Information classification involved | [Internal / Confidential / Restricted] |
| Standing or just-in-time | [Standing / JIT] |
| Duration (if temporary) | [DATE → DATE] |

## 3. Justification
[Why is this access needed? What task can the subject not currently perform? Why are existing roles insufficient?]

## 4. Least privilege check
[Confirm the requested role grants only what is needed. If a narrower role exists, justify why this broader role is requested.]

## 5. Conflict of duties check
[List the subject's other roles that interact with the requested role. Confirm there is no conflict (e.g., approver also being implementer for the same change).]

## 6. Approvals
| Approver | Name | Decision | Date | Signature |
|----------|------|----------|------|-----------|
| Line manager | | | | |
| System / data owner | | | | |
| ISMS Manager (for Restricted only) | | | | |

## 7. Provisioning
| Field | Value |
|-------|-------|
| Assigned by | [IT engineer] |
| Date provisioned | |
| Mechanism | [SSO group / IAM role / direct] |
| Review date (next periodic review) | [next quarterly review] |

## 8. Outcome
- Access granted as specified.
- Recorded in the system's audit log.
- Captured in the periodic access review baseline.
- Subject notified.
`
  },
  {
    name: 'Change Request Form',
    category: 'form',
    description: 'Submission template for the Change Management Procedure (A.8.32).',
    content: `# Change Request Form

${HEADER('A.8.32')}

## 1. Change identification
| Field | Value |
|-------|-------|
| Change ID | [CR-NNN] |
| Title | [Short title] |
| Class | [Standard / Normal / Emergency] |
| Requester | [Name + role] |
| Implementer | [Name + role] |
| Risk owner | [Name + role] |
| Submission date | {{date}} |
| Target window | [Date / time, duration] |

## 2. Description
| Field | Value |
|-------|-------|
| What is changing | [What] |
| Why | [Driver — incident, project, customer, vulnerability remediation] |
| Affected services / assets | [List] |
| Affected information classification | [Internal / Confidential / Restricted] |

## 3. Risk and impact
| Field | Value |
|-------|-------|
| Likelihood of negative impact | [1–5] |
| Worst-case impact | [1–5] |
| Specific risks identified | [Bullet list] |
| Customer / external impact | [None / Notify / Approval required] |

## 4. Implementation plan
[Steps the implementer will follow, with verification at each step.]

## 5. Verification
[How success is confirmed. Specific metrics, queries, dashboards.]

## 6. Rollback plan
[How the change is reversed if verification fails or unexpected impact occurs. Time required.]

## 7. Communications
| Audience | Channel | Sent by | Pre or post |
|---------|---------|---------|-------------|
| | | | |

## 8. Reviews and approvals
| Reviewer | Role | Decision | Date | Comment |
|----------|------|----------|------|---------|
| | Security review | | | |
| | Architecture review | | | |
| | CAB approval | | | |

## 9. Post-implementation
| Field | Value |
|-------|-------|
| Implemented at | [Timestamp] |
| Verified by | [Name] at [Timestamp] |
| Outcome | [Successful / Partially successful + notes / Rolled back] |
| Lessons | [Any takeaways] |
| Linked NCs / incidents | [If applicable] |
`
  },
  {
    name: 'Visitor Log',
    category: 'form',
    description: 'Visitor sign-in record for premises (A.7.1, A.7.4).',
    content: `# Visitor Log

${HEADER('A.7.1, A.7.2, A.7.4')}

> Use this log at every reception of a {{client_name}} premises with controlled-zone entry. Retain entries for [12 months] minimum.

| # | Date | Time in | Time out | Visitor name | Visitor company | Visiting whom | Purpose | ID checked? | Badge issued | Escort name | Signed in by |
|---|------|---------|----------|--------------|-----------------|---------------|---------|-------------|--------------|-------------|--------------|
| 1 | | | | | | | | ☐ | | | |
| 2 | | | | | | | | ☐ | | | |
| 3 | | | | | | | | ☐ | | | |
| 4 | | | | | | | | ☐ | | | |
| 5 | | | | | | | | ☐ | | | |

## Reception instructions
- Verify each visitor's identity using government-issued photo ID.
- Issue a visibly distinct visitor badge that must be worn at all times.
- Record arrival and departure times.
- Confirm an authorised host accepts responsibility for the visitor.
- Visitors entering Restricted or High-security zones require pre-approval and escort at all times.
- For deliveries, record the courier and the recipient; do not let couriers proceed beyond the public zone.

## Privacy
This log captures personal data. It is retained only for the period necessary (per the Records Retention Schedule) and is destroyed thereafter. Access to the log is restricted to facilities and security personnel.
`
  },
  {
    name: 'Asset Disposal Record',
    category: 'form',
    description: 'Per-item record of equipment / media disposal (A.7.14).',
    content: `# Asset Disposal Record

${HEADER('A.7.14')}

> Use one record per item (or per batch, where appropriate). Retain certificate for [7 years].

## 1. Identification
| Field | Value |
|-------|-------|
| Asset ID (from register) | |
| Asset type | [Laptop / Server / Disk / Tape / Phone / Removable media / Other] |
| Make / model | |
| Serial number | |
| Owner role / department | |
| Information classification of data ever held | [Internal / Confidential / Restricted] |

## 2. Sanitisation
| Field | Value |
|-------|-------|
| Method (per Secure Disposal Procedure) | [Crypto-erase / Overwrite / Degauss / Shred / Manufacturer secure-erase] |
| Tooling used | [Tool / version] |
| Operator name + signature | |
| Date | {{date}} |
| Verification by (second person, for Confidential / Restricted) | |
| Verification method | [Sample read / status flag check / visual] |

## 3. Disposition
| Field | Value |
|-------|-------|
| Outcome | [Reused internally / Sold / Donated / Recycled / Destroyed] |
| Recipient (if any) | [Internal user / external party / disposal supplier] |
| Supplier name (if outsourced) | |
| Supplier certificate of destruction reference | |

## 4. Asset register update
| Field | Value |
|-------|-------|
| Register status set to | [disposed / reassigned] |
| Updated by | |
| Updated at | |

## 5. Confirmation

I confirm that the equipment / media identified above has been sanitised and disposed of in accordance with the Secure Disposal and Reuse Procedure, and that {{client_name}} information cannot reasonably be recovered.

Signature: ____________________________  Date: ____________

Name (printed): _______________________________  Role: ____________
`
  },
  {
    name: 'Training Acknowledgement Record',
    category: 'form',
    description: 'Per-person attestation of completion of mandatory training (A.6.3, clause 7.2).',
    content: `# Training Acknowledgement Record

${HEADER('Clause 7.2 / A.6.3')}

> Use the Training module in the ISMS tool to record this with timestamp + IP. This printable form is for offline / wet-signature use.

## 1. Subject
| Field | Value |
|-------|-------|
| Name | [Name] |
| Role | [Role] |
| Department | [Department] |
| Manager | [Manager] |

## 2. Training
| Field | Value |
|-------|-------|
| Course | [Course name] |
| Course version | [Version] |
| Date assigned | [DATE] |
| Date completed | {{date}} |
| Duration | [HH:MM] |
| Quiz score (if applicable) | [%] |
| Pass mark | [%] |

## 3. Topics covered
- {{client_name}} Information Security Policy.
- Acceptable Use Policy.
- Information classification and handling.
- Authentication and password / MFA hygiene.
- Phishing recognition and reporting.
- Reporting information security events (A.6.8).
- Privacy and PII handling (A.5.34).
- Specific role-based topics: [list].

## 4. Attestation

I confirm that I:
- Have completed the training listed above.
- Understand the policies and procedures referenced.
- Understand my obligations under {{client_name}}'s Information Security Policy and the consequences of non-compliance.
- Will comply with these obligations during my engagement with {{client_name}}.

| | |
|---|---|
| Signature | __________________________ |
| Date | {{date}} |

## 5. Manager confirmation (where required)

| | |
|---|---|
| Manager signature | __________________________ |
| Date | |

## 6. Validity
This acknowledgement is valid until [validity_months] months from the completion date, after which the training must be retaken.
`
  },

// =============== ISMS roles ===============
  {
    name: 'ISMS Role — CISO / ISMS Manager',
    category: 'record',
    description: 'Job description / role definition for the senior ISMS authority (A.5.2).',
    content: `# ISMS Role — Chief Information Security Officer / ISMS Manager

${HEADER('A.5.2')}

## 1. Purpose of the role
To lead {{client_name}}'s information security programme, own the ISMS, and provide top management with reasonable assurance that information risks are managed in line with the organisation's appetite.

## 2. Reports to
[CEO / CTO / Board / equivalent]

## 3. Key responsibilities

### 3.1 Strategy and governance
- Define and maintain the information security strategy aligned with {{client_name}}'s business objectives and risk appetite.
- Own the ISMS and ensure compliance with ISO 27001:2022.
- Lead Management Reviews (Clause 9.3).
- Brief the Board / executive on information security posture and material risks.
- Maintain the ISMS scope, policy, objectives, and risk methodology.

### 3.2 Risk management
- Drive identification, assessment, treatment, and monitoring of information security risks.
- Approve risk treatment plans and chair the risk acceptance process.
- Maintain the risk register and methodology.

### 3.3 Operations
- Oversee security operations: monitoring, detection, response, vulnerability management, supplier risk.
- Approve incident classifications and major-incident response decisions.
- Direct the security awareness programme.

### 3.4 Compliance
- Ensure {{client_name}} meets applicable legal, regulatory, and contractual security and privacy requirements.
- Coordinate external audits and customer security assessments.
- Lead Internal Audit programme (or delegate, with independence).

### 3.5 People
- Build and develop the security team.
- Promote security culture across the organisation.

## 4. Authority
- Authority to approve / reject the addition of any system or supplier to the ISMS scope on security grounds.
- Authority to declare a security incident and direct response.
- Authority to recommend policy changes to the {{approval_authority}}.
- Budget authority within the approved security budget.

## 5. Required competence (per clause 7.2)
- Demonstrable expertise in information security management at appropriate scale.
- Knowledge of ISO 27001:2022 and ISO 27002:2022.
- Familiarity with applicable privacy and sectoral regulation.
- Experience leading audits and incidents.
- Recognised certification (e.g., CISSP, CISM, ISO 27001 Lead Implementer / Lead Auditor) is preferred.

## 6. Independence and segregation
The CISO/ISMS Manager:
- Is not the same person as the lead developer / operator of the systems being secured (separation of duties).
- Has a direct reporting line to executive management.
- Has the authority to escalate over operational management when material risk is unaddressed.

## 7. Performance metrics
- Stage 1 / Stage 2 ISMS readiness scores.
- NCs by severity, ageing, and recurrence rate.
- Vulnerability SLA compliance.
- Awareness training completion %.
- Incident response timeliness.
- Outcomes of internal and external audits.

## 8. Delegation
The CISO may delegate operational duties but retains accountability. Delegations are recorded in writing.

## 9. Approval

This role description is approved by **{{approval_authority}}** on **{{date}}**.
`
  },
  {
    name: 'ISMS Role — Information Security Officer / Risk Owner',
    category: 'record',
    description: 'Job description for an ISO / risk owner reporting into the CISO (A.5.2).',
    content: `# ISMS Role — Information Security Officer / Risk Owner

${HEADER('A.5.2')}

## 1. Purpose
To operate the day-to-day ISMS activities for an assigned scope (workspace / business unit / risk area) under the direction of the CISO/ISMS Manager.

## 2. Reports to
CISO / ISMS Manager

## 3. Key responsibilities

### 3.1 Risk
- Own a defined slice of the risk register: identify, assess, document, and drive treatment of risks within their scope.
- Liaise with business and engineering stakeholders to understand risk context.
- Submit risks above appetite for formal acceptance through the workflow.

### 3.2 Controls
- Implement and maintain the assigned Annex A controls within their scope.
- Track effectiveness through the CCM dashboard and other measurement methods.
- Update SoA contributions for their controls.

### 3.3 Supporting evidence and audits
- Collect and retain evidence demonstrating controls operate as intended.
- Support internal and external audits with documentation, demonstrations, and interviews.

### 3.4 Incidents and NCs
- Triage and respond to security events affecting their scope per the Information Security Incident Management Procedure.
- Drive corrective action for nonconformities they own.

### 3.5 Communication
- Brief stakeholders on changes to security posture.
- Run targeted awareness for their scope (e.g., engineering team brown-bags, supplier-team briefings).

## 4. Authority
- Authority to require remediation of in-scope deficiencies within the SLAs of the relevant procedures.
- Authority to escalate to the CISO when blocked by competing priorities.

## 5. Required competence
- Solid working knowledge of ISO 27001 / 27002.
- Practical experience with security risk assessment and mitigation.
- Ability to communicate with technical and non-technical audiences.
- Certification (e.g., CISSP / CISM / ISO 27001 Lead Implementer) preferred.

## 6. Performance metrics
- Risk register quality (coverage, freshness, treatment progress) for assigned scope.
- Control effectiveness via CCM.
- Open-NC rate for assigned controls.
- Stakeholder feedback (qualitative).

## 7. Approval

Approved by **{{approval_authority}}** on **{{date}}**.
`
  },
  {
    name: 'ISMS Role — Internal Auditor',
    category: 'record',
    description: 'Job description / role definition for the internal auditor (A.5.2 / clause 9.2).',
    content: `# ISMS Role — Internal Auditor

${HEADER('A.5.2 / Clause 9.2')}

## 1. Purpose
To conduct independent, objective assurance over {{client_name}}'s ISMS through an internal audit programme, providing top management with confidence that controls are designed and operating effectively.

## 2. Reports to
For day-to-day duties: [HEAD_OF_AUDIT or CFO or independent of CISO].
For ISMS access and resources: cooperative relationship with the CISO/ISMS Manager.

The reporting line MUST preserve independence from the operational ISMS roles.

## 3. Key responsibilities

### 3.1 Audit programme
- Develop and maintain a risk-based annual audit programme covering the ISMS over a planned cycle.
- Submit the programme to the {{approval_authority}} for approval.
- Maintain a master audit calendar in the ISMS tool.

### 3.2 Audit execution
- Plan each audit: scope, criteria, sampling approach.
- Conduct audits using interviews, document review, observation, and sampling.
- Document working papers in the ISMS tool, with traceable evidence references.
- Hold opening and closing meetings with auditees.

### 3.3 Findings and reporting
- Document findings: nonconformity (major / minor), observation, opportunity for improvement.
- Promote findings through the NC / CAPA flow where applicable.
- Issue audit reports to the auditee, ISMS Manager, and {{approval_authority}}.

### 3.4 Follow-up
- Track corrective actions to closure.
- Verify effectiveness of corrective actions in subsequent audits.

### 3.5 Continuous improvement
- Feed systemic patterns into Management Review.
- Maintain auditor competence and update audit practice as standards evolve.

## 4. Independence
The internal auditor:
- Does not audit work they themselves performed or controls they themselves operate.
- Has no reporting / financial conflict of interest with auditees.
- Has unrestricted access to information, systems, and personnel needed for audits.

## 5. Required competence
- Knowledge of ISO 27001:2022 and audit principles per ISO 19011.
- Practical experience auditing information-security management systems.
- Strong interview, observation, and documentation skills.
- Recognised certification (e.g., ISO 27001 Lead Auditor, IRCA / Exemplar Global) preferred.
- Continuing professional development plan documented.

## 6. Performance metrics
- Audits delivered against programme.
- Quality of findings (specific, evidenced, actionable).
- Closure rate of corrective actions raised from internal audits.
- Stakeholder feedback.

## 7. Records retained
Audit programme, audit plans, working papers, reports, follow-up records — all in the ISMS tool — for at least [3 audit cycles].

## 8. Approval

Approved by **{{approval_authority}}** on **{{date}}**.
`
  },
  {
    name: 'ISMS Role — Asset Owner',
    category: 'record',
    description: 'Definition of an Asset Owner for inventoried information assets (A.5.9 / A.5.2).',
    content: `# ISMS Role — Asset Owner

${HEADER('A.5.9 / A.5.2')}

## 1. Purpose
To assign clear individual or role-based accountability for each information asset in {{client_name}}'s register, in line with A.5.9.

## 2. Scope
Applies to assets recorded in the Asset Register, including information assets (datasets, source code, contracts), software / system assets, hardware, and intangible assets. An asset owner is named for every Confidential and Restricted asset; for Internal assets a department / team owner is acceptable.

## 3. Responsibilities

### 3.1 Inventory
- Ensure the asset's record in the inventory is accurate (description, classification, location, dependencies).
- Notify IT Operations of changes (new instances, decommissioned).

### 3.2 Classification
- Determine and review the asset's classification per the Information Classification Policy.
- Reclassify when the asset's nature or sensitivity changes.

### 3.3 Access
- Approve who has access to the asset, periodically reviewing per A.5.18 / Access Reviews.
- Approve access requests submitted via the Access Request Form.

### 3.4 Protection
- Ensure controls appropriate to the classification are in place (technical and organisational).
- Confirm backup / availability arrangements meet business needs.
- Liaise with the ISMS Manager on residual risks.

### 3.5 Lifecycle
- Approve major changes to the asset.
- Authorise disposal (per Secure Disposal and Reuse Procedure).

### 3.6 Incidents and breaches
- Be notified of incidents affecting the asset.
- Provide context to incident response (data sensitivity, dependencies, business impact).

## 4. Authority
- Authority to approve / refuse access requests for the asset.
- Authority to require remediation of vulnerabilities affecting the asset within SLA.
- Authority to recommend that the asset be removed from active use.

## 5. Required competence
- Sufficient knowledge of the business purpose of the asset.
- Understanding of {{client_name}}'s Information Classification Policy.
- Awareness of Acceptable Use, Access Control, Change Management Procedures.

## 6. Records
The Asset Register reflects current ownership at all times. Ownership changes are logged.

## 7. Approval

Approved by **{{approval_authority}}** on **{{date}}**.
`
  },
  {
    name: 'ISMS Steering Committee Charter',
    category: 'record',
    description: 'Constitutes the ISMS Steering Committee, its mandate, composition, and operation (A.5.2 / Clause 5.1).',
    content: `# ISMS Steering Committee Charter

${HEADER('A.5.2 / Clause 5.1')}

## 1. Purpose
To provide top-management leadership, direction, and oversight of {{client_name}}'s ISMS in line with Clause 5.1 of ISO 27001:2022.

## 2. Mandate
The ISMS Steering Committee:
- Endorses the information security policy and information security objectives.
- Approves the risk methodology and risk appetite.
- Approves material risk treatment decisions and risk acceptances above appetite.
- Receives reports on ISMS performance, NCs, incidents, and supplier risk.
- Provides resources to operate the ISMS effectively.
- Champions security culture across {{client_name}}.

## 3. Composition

| Member | Role |
|--------|------|
| Chair | [CEO / CTO / equivalent — top management representative] |
| Information security lead | CISO / ISMS Manager |
| Engineering / IT | [VP Engineering / Head of IT] |
| People / HR | [Head of People] |
| Legal / Privacy | [General Counsel / DPO] |
| Operations / Finance | [COO / CFO] |
| Customer-facing | [VP Customer Success or equivalent] |

Other invitees attend as needed (auditors, DPO, supplier-risk lead).

Quorum: [Chair + 4 other members].

## 4. Frequency
The Committee meets at least [quarterly]. The annual Management Review is one of these meetings.

## 5. Inputs (per Clause 9.3.2)
- Status of actions from previous meetings.
- Changes in external and internal issues that affect the ISMS.
- Changes in interested-parties' needs and expectations.
- ISMS performance: trends in NCs and corrective actions, monitoring and measurement, audit results, achievement of objectives.
- Supplier risk and concentration.
- Material risks and risk treatment status.
- Opportunities for continual improvement.

## 6. Outputs (per Clause 9.3.3)
- Decisions on continual improvement opportunities.
- Decisions on changes to the ISMS.
- Resource needs.
- Material risk acceptances.
- Updates to objectives.

## 7. Working practices
- Agenda and pre-read circulated [3] business days before each meeting.
- Minutes captured in the Management Review module of the ISMS tool.
- Attendees attest attendance with electronic signature.
- Action items tracked in the ISMS task system.

## 8. Records
- Meeting minutes, decisions, attendance, signed attestations.
- Retained for [3 audit cycles + 3 years] under the Records Control Procedure.

## 9. Review
This charter is reviewed annually and on any material change to {{client_name}}'s structure or scope.

## 10. Approval

Approved by **{{approval_authority}}** on **{{date}}**.
`
  }
];
