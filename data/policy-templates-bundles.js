// ISO 27001:2022 starter templates - bundled controls. Each template covers
// multiple Annex A controls and/or main-body clauses to reduce document count
// without sacrificing audit traceability. SoA entries should reference the
// specific section within these documents.

const STARTER = `> **Starting point.** Aligned with ISO 27001:2022 and ISO 27002:2022 implementation guidance. Replace bracketed placeholders, adjust to {{client_name}}'s practices, and have the document owner confirm intervals/thresholds before approval.\n\n---\n`;
const HEADER = (kind) => `${STARTER}
**Document Owner:** {{document_owner}}
**Approved by:** {{approval_authority}}
**Effective Date:** {{date}}
**Review Period:** {{review_period}}
**Annex A / Clause reference:** ${kind}

`;

module.exports = [
  {
    name: 'Physical and Environmental Security Policy',
    category: 'policy',
    description: 'Bundled physical security policy covering monitoring, environmental threats, secure areas, off-premises assets, utilities, cabling, and equipment maintenance (A.7.4–7.6, 7.9, 7.11–7.13).',
    content: `# Physical and Environmental Security Policy

${HEADER('A.7.4, A.7.5, A.7.6, A.7.9, A.7.11, A.7.12, A.7.13')}

## 1. Purpose
To prevent unauthorised physical access, damage, theft, or environmental harm to {{client_name}}'s information, equipment, and supporting infrastructure.

## 2. Scope
All {{client_name}} premises, data centres, co-location facilities, equipment rooms, and any equipment used off-premises (laptops, mobile devices, home-office kit, antennas, ATMs, kiosks).

## 3. Roles and responsibilities
- **Facilities / Office Manager:** day-to-day operation of physical controls, key management, visitor management.
- **ISMS Manager:** policy, exceptions, periodic review.
- **IT Operations:** equipment siting, maintenance, monitoring of supporting utilities.
- **All personnel:** comply with rules in this policy and report incidents per the Incident Reporting Procedure.

## 4. Physical security monitoring (A.7.4)

### 4.1 Surveillance
{{client_name}} premises with information processing facilities are continuously monitored using:
- CCTV at all entry/exit points and within data centre / server room areas.
- Intruder alarms on perimeters, with motion detection in server rooms.
- Access-card readers logging every entry/exit to controlled areas.

### 4.2 Recordings and retention
- CCTV footage retained for [30] days minimum, [90] days for data-centre cameras.
- Access logs retained for [12] months.
- Both are protected from tampering and accessible only to Facilities Manager and ISMS Manager.

### 4.3 Alarm response
- Alarms route to [monitoring service / on-call security] 24×7.
- Response procedure: verify → escalate to local law enforcement if intrusion confirmed → notify ISMS Manager within 30 minutes.

### 4.4 Privacy
Monitoring complies with applicable data-protection laws. Notices are posted at all monitored entrances. Footage is not used for performance management.

## 5. Protecting against physical and environmental threats (A.7.5)

### 5.1 Risk assessment
Physical risks (fire, flood, earthquake, civil unrest, power, theft) are assessed at each site annually and when premises change. Document in the {{client_name}} risk register.

### 5.2 Site selection
For new premises, {{client_name}} assesses:
- Local topography (flood plains, fault lines).
- Urban threat profile (proximity to high-risk targets).
- Availability of redundant utilities.

### 5.3 Specific controls
- **Fire:** smoke/heat detection in all areas; suppression in server rooms (gas-based, not water); annual fire drills; fire extinguishers serviced [annually].
- **Flood:** water-leak detection beneath raised floors in server rooms; pumps available; sensitive equipment elevated.
- **Power surges:** UPS on all critical equipment; surge protection at building entry.
- **Explosives / weapons:** random screening of incoming deliveries at sensitive sites.

## 6. Working in secure areas (A.7.6)

### 6.1 Definition
Secure areas at {{client_name}} include: [data centre / server rooms / executive areas / SCIF if applicable].

### 6.2 Rules for secure areas
- Access on a need-to-be-there basis; logged and reviewed [quarterly].
- No unsupervised work - minimum two persons in data-centre during maintenance.
- Photographic, video, or audio recording prohibited unless authorised in writing.
- Personal mobile devices restricted; corporate devices logged in/out at the door.
- Vacant secure areas are physically locked and inspected [weekly].
- Emergency procedures (evacuation, first aid, fire) posted visibly.

## 7. Security of assets off-premises (A.7.9)

### 7.1 Authorisation
Removing equipment or storage media from {{client_name}} premises requires authorisation from [line manager / asset owner] and is logged.

### 7.2 In-transit protection
- Laptops, phones, removable media: encrypted at rest; never left unattended in vehicles or public spaces.
- Printed material classified [Confidential] or higher: transported in tamper-evident envelopes, hand-carried or by approved courier.
- Manufacturer instructions for protection (heat, humidity, EM fields) followed.

### 7.3 Permanently installed off-premises equipment
For antennas, ATMs, kiosks, IoT sensors:
- Tamper-evident enclosures and tamper-detection alarms.
- Physical access controls (locks, restricted-area placement).
- Logical access controls (no default credentials, monitored network connection).

### 7.4 Loss or theft
Reported within 4 hours per Incident Reporting Procedure. Remote wipe initiated for managed devices. Device location tracking enabled where lawful.

## 8. Supporting utilities (A.7.11)

### 8.1 Inventory
Critical supporting utilities at {{client_name}}: electricity, network connectivity, HVAC, water (for cooling), gas (where used), sewage.

### 8.2 Operation and maintenance
- Configured and maintained per manufacturer specification.
- Capacity reviewed [annually] against business growth.
- Inspected and tested [annually]; results logged.

### 8.3 Resilience
- Power: UPS sized for [graceful shutdown / 30 minutes runtime] plus generator backup for [4 hours]; tested under load [quarterly].
- Network: redundant links from [two] providers with diverse physical routing.
- HVAC: N+1 redundancy in server rooms; temperature/humidity alarmed.

### 8.4 Emergency
Emergency switches/valves clearly labelled and located near exits. Emergency contact list maintained and posted.

## 9. Cabling security (A.7.12)

### 9.1 Power and telecommunications cabling
- Underground or in protected conduit where possible.
- Power cables segregated from data cables to prevent interference.
- Fibre preferred over copper for sensitive links.

### 9.2 For sensitive systems
- Armoured conduit, locked cable rooms.
- Periodic technical sweeps and physical inspections for tap devices.
- Patch panels and cable rooms accessible only to authorised IT Ops staff.
- Cables labelled at both ends with source/destination IDs.

## 10. Equipment maintenance (A.7.13)

### 10.1 Maintenance schedule
- Equipment maintained per supplier specification and service intervals.
- Maintenance programme implemented and monitored by IT Operations.
- Records of all preventive and corrective maintenance retained [3 years].

### 10.2 Maintenance personnel
- Only authorised internal staff or vetted vendor engineers.
- External engineers escorted in secure areas; activity logged.
- NDAs signed before work involving access to information.

### 10.3 Off-site maintenance
If equipment leaves {{client_name}}'s premises for repair, sensitive data is removed or the storage media retained on-site. Insurance requirements verified.

### 10.4 Re-entry
After maintenance, equipment inspected to confirm no tampering and correct functioning before returning to operation.

## 11. Records
- Visitor log
- Asset removal authorisation log
- CCTV / access-control system logs
- Maintenance log
- Utility test records

## 12. Review
Reviewed [annually] by ISMS Manager and Facilities Manager, and after any significant change to premises or threat landscape.
`,
  },

  {
    name: 'Operations Security Procedure',
    category: 'procedure',
    description: 'Bundled IT operations security procedure covering monitoring, clock synchronization, privileged utilities, and web filtering (A.8.16, 8.17, 8.18, 8.23).',
    content: `# Operations Security Procedure

${HEADER('A.8.16, A.8.17, A.8.18, A.8.23')}

## 1. Purpose
To define how IT Operations at {{client_name}} monitor systems for anomalies, maintain accurate time across the estate, control powerful utility programs, and filter web access - all foundational technical controls for detecting and preventing security incidents.

## 2. Scope
All {{client_name}}-managed networks, servers, applications, endpoint devices, and the IT operations personnel who run them.

## 3. Monitoring activities (A.8.16)

### 3.1 What is monitored
- Inbound/outbound network traffic at perimeter and key segmentation boundaries.
- Authentication events (success and failure) on critical systems.
- Privileged access usage.
- Critical system and admin-level configuration files.
- Logs from security tools (EDR, IDS/IPS, web filter, firewall, DLP).
- Resource utilisation (CPU, memory, disk, bandwidth) for performance and DoS detection.

### 3.2 Baseline and anomaly detection
- {{client_name}} maintains a baseline of normal behaviour (peak/off-peak utilisation, normal access times and locations per user role).
- Deviations are alerted on, including:
  - Activity from known-bad IP addresses or domains.
  - Logon at unusual time or from unusual geography.
  - Unauthorised scanning of systems.
  - Process behaviour matching known attack patterns.
  - Bandwidth or queueing anomalies suggesting DoS.

### 3.3 Tooling
- SIEM aggregates logs from sources listed above; tuned to suppress known-good patterns.
- Alerts route to [SOC / on-call engineer]; runbook defines triage steps and escalation thresholds.
- Continuous monitoring 24×7 for [Tier-1 systems]; business-hours monitoring for the rest.

### 3.4 Response
Alerts confirmed as security events trigger the Incident Response Procedure. False positives feed back into tuning.

## 4. Clock synchronization (A.8.17)

### 4.1 Reference clock
{{client_name}} synchronises all systems to:
- Primary: [pool.ntp.org / vendor-provided GPS-backed NTP / national time authority].
- Secondary: an alternative independent source for redundancy.

### 4.2 Protocols
- NTP for general systems.
- PTP where sub-millisecond accuracy is required (e.g., transaction systems, distributed databases).
- All TLS, certificate, and Kerberos systems depend on synchronised clocks; misalignment alarmed.

### 4.3 Coverage
All servers, network devices, security appliances, building management systems, CCTV recorders, badge-access systems, and end-user devices.

### 4.4 Drift monitoring
- Time drift > [100 ms] alerts to IT Ops.
- Cloud / on-prem drift specifically tracked when both are in use.

## 5. Use of privileged utility programs (A.8.18)

### 5.1 What counts as a privileged utility
Tools that can override normal system or application controls: diagnostic and patching tools, antivirus admin consoles, disk defragmenters, debuggers, backup/restore software, network packet analysers, registry/config editors, password vaults' master accounts.

### 5.2 Restrictions
- Use limited to the minimum number of trusted, authorised IT Ops or security staff.
- Each user identifiable (no shared accounts) - ties into Privileged Access Management.
- Authorisation required for ad-hoc use; documented in change ticket.
- Default deny: utilities removed or disabled on systems where not needed.
- Logically segregated from application software; on networks separate from application traffic where practical.
- Time-bound: enabled only for the duration of authorised work; disabled afterwards.
- All use logged; logs reviewed [weekly] by security.

### 5.3 Segregation
Personnel who use privileged utilities on a system do not also use the applications running on that system in their day job (segregation of duties - A.5.3).

## 6. Web filtering (A.8.23)

### 6.1 Categories blocked
- Known-malicious domains (phishing, malware C2, exploit kits) - blocked.
- Illegal-content categories per local law - blocked.
- Adult, gambling, weapons (per acceptable-use policy) - blocked.
- File-upload to untrusted destinations - blocked unless business-justified.
- Sites with invalid/expired TLS certificates - warned, not blocked, with override option.

### 6.2 Threat-intel integration
Block list updated automatically from:
- Web-filter vendor feeds.
- {{client_name}}'s threat-intelligence sources (per Threat Intelligence Procedure).
- Internal IOCs from past incidents.

### 6.3 Allowlisting and exceptions
- Business-justified exceptions submitted via [ticket / form], approved by [line manager + ISMS Manager], time-bound, reviewed [quarterly].

### 6.4 User awareness
- Training covers recognising phishing and not overriding browser TLS warnings (per Awareness & Training Programme).
- Block pages explain why a site was blocked and how to request review.

### 6.5 Coverage
Web filtering applies to:
- Corporate network egress (always-on).
- Off-network corporate devices (via cloud-delivered filter / always-on VPN).
- Bring-your-own devices accessing corporate resources (via secure browser / CASB).

## 7. Records
- SIEM alerts and triage notes (retention per Logging Policy).
- Privileged-utility usage log.
- Web-filter category change log.
- Time-sync drift reports.

## 8. Review
Reviewed [annually] by Head of IT Operations and ISMS Manager, and after any major incident in the operations domain.
`,
  },

  {
    name: 'ISMS Governance Manual',
    category: 'policy',
    description: 'ISMS governance manual covering context of organisation, interested parties, planning of changes, resources, and segregation of duties (clauses 4.1, 4.2, 6.3, 7.1, A.5.3).',
    content: `# ISMS Governance Manual

${HEADER('Clauses 4.1, 4.2, 6.3, 7.1; A.5.3')}

## 1. Purpose
To document the foundational governance of {{client_name}}'s Information Security Management System (ISMS) - context, stakeholders, change management at the system level, resources committed, and segregation of duties - so that an auditor or new ISMS member can understand "how this ISMS is run" from one document.

## 2. Context of the organisation (Clause 4.1)

### 2.1 Internal context
{{client_name}} is a [size / sector] organisation providing [products/services]. Material internal factors that affect the ISMS:
- **Organisational structure:** [hierarchy summary].
- **Strategy:** [growth / consolidation / pivot - note relevant security implications].
- **Culture:** [risk tolerance, willingness to invest in security].
- **Capabilities and resources:** in-house expertise, gaps filled by suppliers.
- **Information assets:** [headline categories - customer data, IP, financial].
- **Operational and information systems:** [headline systems / cloud providers].
- **Contractual relationships:** [key customer security obligations].

### 2.2 External context
- **Regulatory:** [list - e.g., GDPR, HIPAA, sector regulator].
- **Legal:** [contract law, IP, employment].
- **Market and competitive:** customer security expectations, peer practices.
- **Threat landscape:** [headline threats relevant to sector].
- **Technology trends:** [cloud adoption, AI, supply-chain risk].
- **Geopolitical / macro:** [where relevant - sanctions, data sovereignty].

## 3. Interested parties (Clause 4.2)

| Party | Type | Interest / requirement | How addressed |
|---|---|---|---|
| Customers | External | Confidentiality of their data, service availability, audit rights | Customer contracts, SoC2/27001 certification, customer-portal SLAs |
| Employees | Internal | Lawful processing of HR data, safe workplace | HR policies, Acceptable Use, training |
| Regulators | External | Compliance with [GDPR/HIPAA/sector] | Compliance Register, breach notification |
| Top management & board | Internal | Risk visibility, return on security investment | MRM outputs, dashboard, board reports |
| Suppliers | External | Clear security expectations, fair contract terms | Supplier policy, supplier agreements |
| Investors | External | Material risk disclosure | Annual report risk section |
| Insurers | External | Demonstrable controls for cyber insurance | SoA, audit reports |
| Public / community | External | Lawful, ethical conduct | Privacy notice, vulnerability disclosure |

This register is reviewed [annually] and on material changes (new product line, new market, new regulator).

## 4. ISMS scope (informational - full scope statement in separate Scope document)
Summary: [in-scope systems, services, locations, business units]. Out of scope: [exclusions and rationale].

## 5. Planning of changes to the ISMS (Clause 6.3)

### 5.1 Triggers for ISMS change
- New or significantly changed products/services.
- New regulatory requirements.
- Significant change in threat landscape (e.g., post-incident lessons learned).
- Organisational change (mergers, divestments, restructure).
- Change in scope (new locations, new cloud providers).
- Change in risk acceptance criteria.

### 5.2 Change procedure
Changes to the ISMS itself (as opposed to operational change covered by A.8.32) follow:
1. **Proposal:** Change initiator submits written proposal to ISMS Manager describing what, why, expected impact on policies/risks/controls.
2. **Impact analysis:** ISMS Manager assesses impact on:
   - Risk assessment results.
   - Statement of Applicability.
   - Topic-specific policies and procedures.
   - Resources and roles.
   - Training needs.
   - Existing certifications.
3. **Approval:** Material changes approved by [Top Management / ISMS Steering Committee]. Minor changes approved by ISMS Manager.
4. **Implementation plan:** Sequence of policy updates, comms, training, and audit-trail updates.
5. **Verification:** Post-implementation review to confirm intended effect; any deviations logged as observations or NCs.

### 5.3 Records
All ISMS-level changes logged with proposal, impact analysis, approval, and post-implementation review.

## 6. Resources for the ISMS (Clause 7.1)

### 6.1 Top management commitment
Top management at {{client_name}} commits to providing:
- Sufficient personnel time, skill, and budget for the ISMS.
- Authority to ISMS Manager and process owners.
- Visible support, including regular review (per Management Review Procedure).

### 6.2 Personnel resources
- **ISMS Manager:** [FTE allocation].
- **Internal Auditor:** [FTE allocation, independent of areas audited].
- **Process owners:** time committed per process.
- **Subject-matter experts:** available for technical reviews, risk assessments.

### 6.3 Financial resources
Annual budget covers:
- Tooling (SIEM, vulnerability scanning, training platform).
- External assessments (penetration testing, certification audits).
- Training and awareness.
- Incident response retainers.
- Insurance.

### 6.4 Infrastructure
[ISMS document repository, GRC tool, audit workpapers store].

### 6.5 Knowledge
Policies, procedures, threat intelligence subscriptions, professional memberships kept current.

## 7. Segregation of duties (A.5.3)

### 7.1 Principle
Conflicting duties at {{client_name}} are separated so that no single person can both commit and conceal an error or fraud, and so that information security controls cannot be bypassed by one individual acting alone.

### 7.2 Conflicting duty pairs (illustrative - adjust to {{client_name}}'s reality)

| Duty A | Duty B (must be separate person) | Where enforced |
|---|---|---|
| Initiate change | Approve change | Change Management Procedure |
| Approve access request | Provision access | Identity and Access Management |
| Develop code | Approve code merge to production | SDLC |
| Operate production system | Audit production system | Internal Audit |
| Use a privileged utility | Run the application that utility manages | Operations Security Procedure |
| Manage encryption keys | Use those keys for production transactions | Cryptography Policy |
| Process supplier invoice | Approve supplier payment | Finance procedure |

### 7.3 When segregation is impractical
For very small teams, full segregation may be impractical. Compensating controls applied: enhanced logging, peer review, management oversight, independent audit. Each compensating arrangement documented.

### 7.4 RBAC and conflict detection
- Roles in the IAM system are designed to prevent conflicting permissions being held simultaneously.
- Toxic-combination report run [quarterly] and reviewed by ISMS Manager.

### 7.5 Review
Conflicting-duty matrix reviewed [annually] and on material organisational change.

## 8. Records
- Interested-parties register
- ISMS change log
- Resource commitment letter / budget approval
- Toxic-combination report

## 9. Review
This manual reviewed [annually] by ISMS Manager and approved by Top Management. Updated whenever clause-4 context, parties, or resourcing materially change.
`,
  },

  {
    name: 'Legal, Regulatory and Compliance Register',
    category: 'record',
    description: 'Combined register and procedure for legal/regulatory requirements, intellectual property, and compliance review (A.5.31, 5.32, 5.36).',
    content: `# Legal, Regulatory and Compliance Register

${HEADER('A.5.31, A.5.32, A.5.36')}

## 1. Purpose
To identify, document, and track {{client_name}}'s legal, statutory, regulatory, and contractual obligations related to information security, intellectual property rights, and the procedure by which compliance with these obligations and with internal policies is reviewed.

## 2. Scope
All jurisdictions in which {{client_name}} operates or processes information; all material customer/supplier contracts; all internal information-security policies.

## 3. Roles
- **General Counsel / Legal:** maintains the legal register; provides legal interpretation.
- **ISMS Manager:** maps obligations to controls; runs compliance review.
- **Process owners:** confirm operational compliance for their domain.
- **Internal Auditor:** independent verification.

## 4. Legal and regulatory requirements (A.5.31)

### 4.1 Register structure
Each entry in the register captures:
- Reference number.
- Source (statute, regulation, standard, contract).
- Jurisdiction.
- Description of the obligation.
- Effective date.
- Internal owner.
- Mapped policy / control / SoA reference.
- Compliance status (Compliant / Partial / Non-compliant / N/A).
- Last reviewed.
- Next review.

### 4.2 Categories tracked
- **Data protection and privacy:** [GDPR, UK DPA, CCPA, state laws, sector privacy laws].
- **Cybersecurity:** [NIS2, sector cyber regulations, breach-notification laws].
- **Sector-specific:** [HIPAA / PCI-DSS / financial regulator].
- **Cross-border data transfer:** [SCCs, adequacy decisions, BCRs, local data-residency rules].
- **Cryptography:** [import/export restrictions, mandatory key-disclosure regimes].
- **Records retention:** [tax, employment, sector-specific].
- **Electronic signatures and evidence:** [eIDAS, ESIGN, sector rules].
- **Employment and HR:** [background-check rules, monitoring rules].
- **Contractual:** [customer security clauses, supplier security obligations].

### 4.3 Maintaining the register
- Reviewed [quarterly] by Legal and ISMS Manager.
- Updated immediately on:
  - New legislation/regulation affecting {{client_name}}.
  - Entry into a new market or jurisdiction.
  - New material contract with security obligations.
  - Material legal interpretation change (court ruling, regulator guidance).
- Subscribed sources: [legal alert service, sector association, regulator newsletters].

### 4.4 Cryptography legislation
Specific obligations tracked:
- Restrictions on import/export of cryptographic hardware/software in jurisdictions {{client_name}} operates.
- Restrictions on use of cryptography (e.g., specific algorithms permitted/prohibited).
- Mandatory disclosure regimes (lawful access to encrypted data).
- Validity rules for digital signatures, seals, certificates.
Legal advice obtained before moving encrypted data or cryptographic tools across jurisdictional borders.

## 5. Intellectual property rights (A.5.32)

### 5.1 Scope
Both: (a) {{client_name}}'s obligations to respect third-party IP, and (b) protection of {{client_name}}'s own IP from misuse by personnel or third parties.

### 5.2 Software licensing
- Software acquired only from known, reputable sources.
- Asset register includes licence records, proof of purchase, allowed user/CPU counts.
- Reviews [annually] confirm only licensed/authorised software installed (cross-references Configuration Management).
- Procedures for transferring or disposing of software comply with licence terms.

### 5.3 Standards, books, articles, recordings
- No duplication, format conversion, or extraction beyond what copyright law or licence allows.
- ISO/IEC standards referenced in policies are not republished verbatim - only used per ISO copyright terms.

### 5.4 {{client_name}}'s own IP
- Source code, designs, trade secrets protected via:
  - Access control (Access Control Policy).
  - NDAs with personnel and third parties.
  - Marking and classification (Information Classification Policy).
  - Termination procedures (Asset Return).
- IP developed by employees or contractors: ownership clarified in employment / contractor agreements.

### 5.5 Data acquired from third parties
- Data-sharing agreements record what processing is permitted, retention, deletion.
- Provenance recorded; data not used outside licensed purpose.

### 5.6 Sanctions for infringement
Wilful infringement may result in disciplinary action up to dismissal, and recovery of associated costs.

## 6. Compliance review (A.5.36)

### 6.1 Two layers
- **Management compliance review:** owners review their own areas against policy.
- **Independent review:** Internal Audit and external assessments (covered in Independent Review Procedure, A.5.35).

### 6.2 Management review schedule

| Domain | Owner | Frequency |
|---|---|---|
| Access rights | IT Ops | Quarterly |
| Privileged access | Security | Monthly |
| Supplier compliance | Procurement / ISMS | Annually + on contract renewal |
| Backups & restoration | IT Ops | Monthly |
| Vulnerability remediation SLAs | Security | Monthly |
| Awareness training completion | HR / ISMS | Quarterly |
| Records retention | Records Manager | Annually |
| Cryptographic key inventory | Security | Annually |
| Physical security inspection | Facilities | Quarterly |
| Legal register accuracy | Legal | Quarterly |

### 6.3 Method
Owners use checklists or automated reports to verify compliance. Findings classified:
- **Compliant** - evidence sufficient.
- **Partial** - gap identified, plan in place.
- **Non-compliant** - corrective action required (raised as a Nonconformity).

### 6.4 Corrective action
For non-compliance:
1. Identify root cause.
2. Determine corrective action proportionate to risk.
3. Assign owner and due date.
4. Track to closure.
5. Verify effectiveness; if next scheduled review still shows non-compliance, escalate.

### 6.5 Reporting
Compliance review results feed into:
- Independent Review (A.5.35).
- Management Review (clause 9.3).
- Board / risk committee reporting.

## 7. Records
- Legal register (live document - see appendix or linked spreadsheet).
- Compliance review checklists and findings.
- Corrective action log.
- Software licence inventory.
- Data-sharing agreements register.

## 8. Review
This register and procedure reviewed [quarterly] by Legal and ISMS Manager. The review approach itself reviewed [annually].
`,
  },
];
