// ISO 27001:2022 starter templates — Technological controls (A.8.x).

const STARTER = `> **Starting point.** Aligned with ISO 27001:2022 and ISO 27002:2022 implementation guidance. Replace bracketed placeholders, adjust to {{client_name}}'s practices, and have the document owner confirm intervals/thresholds before approval.\n\n---\n`;
const HEADER = (kind) => `${STARTER}
**Document Owner:** {{document_owner}}
**Approved by:** {{approval_authority}}
**Effective Date:** {{date}}
**Review Period:** {{review_period}}
**Annex A reference:** ${kind}

`;

module.exports = [
  {
    name: 'User Endpoint Devices Policy',
    category: 'policy',
    description: 'Security baseline for laptops, desktops, and mobile devices (A.8.1).',
    content: `# User Endpoint Devices Policy

${HEADER('A.8.1')}

## 1. Purpose
To establish the security baseline applied to every endpoint device that processes {{client_name}} information.

## 2. Scope
All laptops, desktops, tablets, and mobile phones used to access {{client_name}} systems or data, whether owned by {{client_name}} or by the user (where BYOD is permitted under the Remote Working Policy).

## 3. Standard build
{{client_name}}-managed endpoints are deployed from a hardened baseline image that includes:
- Supported OS version with current cumulative patches.
- Full-disk encryption (BitLocker / FileVault / Linux LUKS) with recovery key escrowed.
- EDR / anti-malware agent in protect mode, reporting to the central console.
- MDM / device-management enrolment.
- Centrally managed firewall enabled with the default-deny inbound profile.
- Local admin disabled for the standard user.
- Idle screen lock at [10] minutes.
- USB and removable-media policy applied per Removable Storage Media Procedure.
- Logging forwarded to the central log platform.

The hardened baseline is documented in [BUILD_DOC_REF] and reviewed [annually].

## 4. Authentication
- Sign-in is via {{client_name}}'s identity provider with MFA per Authentication Policy (A.8.5).
- Passwordless / FIDO2 is the preferred method where supported.
- Cached credentials are limited to the local user.

## 5. Patching
Patches are applied within the windows defined in the Vulnerability Management Procedure (A.8.8). Auto-update is enabled for:
- OS and security updates.
- Browsers.
- Office productivity suite.
- VPN and EDR clients.

## 6. Application installation
- Software is installed from the {{client_name}} software catalog only.
- Self-service install is allowed for vetted, non-elevated apps.
- Elevated install requires a temporary admin session granted by IT.
- Unauthorised software is removed automatically by the EDR; repeated violations follow the Disciplinary Process.

## 7. Mobile devices
- Mobile devices accessing {{client_name}} mail or apps must be enrolled in MDM and pass attestation (jailbreak / root detection).
- Personal devices follow the Remote Working Policy's BYOD rules.

## 8. Loss or theft
Lost or stolen endpoints are reported within [4 hours] via the Reporting Information Security Events Procedure. IT performs a remote wipe and credential reset.

## 9. End-of-life
Endpoints are decommissioned per the Secure Disposal and Reuse Procedure.

## 10. Records
The asset register lists every endpoint with its owner, serial number, build version, and current status. The register is reconciled with directory and EDR enrolment quarterly.

## 11. Related documents
- Authentication Policy (A.8.5)
- Vulnerability Management Procedure (A.8.8)
- Configuration Management Procedure (A.8.9)
- Removable Storage Media Procedure (A.7.10)
`
  },
  {
    name: 'Privileged Access Management Procedure',
    category: 'procedure',
    description: 'Provisioning, monitoring, and review of privileged accounts (A.8.2).',
    content: `# Privileged Access Management Procedure

${HEADER('A.8.2')}

## 1. Purpose
To restrict, monitor, and time-bound privileged access in line with the principle of least privilege.

## 2. What counts as privileged
- Domain / directory administrator accounts.
- Cloud platform administrator roles (AWS root / Org admin, Azure Global Admin, GCP Owner).
- Database superuser / DBA roles.
- Network device admin (firewall, router, load balancer).
- Application administrative roles that permit configuration of access control or data extraction.
- Hypervisor and container-orchestrator admin (vCenter, Kubernetes cluster-admin).
- Production deploy / release pipelines.
- Break-glass / emergency-access accounts.

## 3. Provisioning

### 3.1 Just-in-time access
Privileged access is granted just-in-time wherever the platform supports it (Azure PIM, AWS IAM Identity Center session policies, Okta privileged access, custom ticket-driven flows). Standing privileged access is permitted only by exception, recorded in the Exception Register.

### 3.2 Approval
A privileged-access request requires:
- The target system / role.
- Business reason.
- Duration (default [4 hours], maximum [8 hours] without re-approval).
- Approver from a different reporting line.

Approvals are recorded in the privileged-access management tool with a tamper-evident audit log.

### 3.3 Account separation
Each user with privileged need has two accounts: a standard everyday account and a privileged account. Privileged accounts:
- Are not used for email, browsing, or chat.
- Cannot be used for interactive desktop login on standard endpoints.
- Have stronger authentication (FIDO2 / hardware token / MFA + step-up).

## 4. Session controls
- Privileged sessions are recorded (keystroke / screen) where the platform supports it.
- All privileged actions are logged to the central log platform.
- Idle sessions are terminated after [15] minutes.
- Concurrent privileged sessions are limited per role.

## 5. Break-glass
Emergency-access ("break-glass") accounts:
- Are stored in a sealed container (physical safe + sealed envelope, or dedicated vault).
- Their use generates an alert to the ISMS Manager and CISO.
- Use is reviewed within [24 hours] and a post-use rotation is mandatory.
- Credentials are rotated after every use.

## 6. Periodic review
Privileged-account membership is reviewed every [90 days] by the system owner and the ISMS Manager. The review:
- Lists every standing privileged grant and confirms continued business need.
- Identifies dormant privileged accounts (no use in 90 days) for revocation.
- Records the outcome (retain / modify / remove) in the Access Review module.

## 7. Termination / role change
Privileged access is revoked on the same day for terminations and same-day-or-next for role changes, per the Termination and Change of Employment Procedure (A.6.5).

## 8. Records
- Privileged access requests, approvals, and session recordings are retained for [3] years.
- Periodic review records are retained for [3] years.

## 9. Related documents
- Access Control Policy (A.5.15)
- Authentication Policy (A.8.5)
- Termination and Change of Employment Procedure (A.6.5)
`
  },
  {
    name: 'Authentication Policy',
    category: 'policy',
    description: 'Authentication standards including MFA and passwords (A.8.5).',
    content: `# Authentication Policy

${HEADER('A.8.5')}

## 1. Purpose
To define how {{client_name}} authenticates people and services accessing its systems.

## 2. Identity provider
All workforce authentication is centralised in [IDP_NAME] (single sign-on). Local accounts on production systems are prohibited except for documented break-glass.

## 3. Authentication factor requirements

| Asset class | Minimum |
|-------------|---------|
| Standard workforce SSO | Phishing-resistant MFA (FIDO2 / WebAuthn preferred); TOTP acceptable as fallback |
| Privileged accounts | Phishing-resistant MFA (FIDO2 hardware token), no SMS, no fallback to TOTP without step-up approval |
| Cloud platform admin | FIDO2 + per-action MFA on destructive operations |
| Customer-facing app (admin tier) | MFA required |
| Customer-facing app (end-user tier) | MFA optional but offered |
| Service-to-service | Mutual TLS or short-lived OAuth tokens; no static API keys for cross-environment access |
| Break-glass | FIDO2 token + dual control |

## 4. Passwords (where used as a factor)
Where passwords are still used:
- Length: [14] characters minimum, no complexity rules; longer where the platform supports it.
- Reject the most common 100,000 breached passwords (haveibeenpwned-style list bundled at install).
- No periodic forced rotation; rotation is required only on suspected compromise.
- Rate-limit and lock-out per industry guidance.
- Stored as Argon2id (or platform default) with per-user salt.

## 5. Hardware tokens / FIDO2
- Issued to all workforce users by [date].
- Recovery via a registered backup token; recovery without a token requires identity verification with HR.
- Lost tokens are reported under A.6.8 within [4 hours] and revoked immediately.

## 6. Service accounts
- Each service account has a documented owner and use case.
- Credentials are stored in the central secrets manager.
- Rotation: every [90 days] for static secrets; transient where possible.
- Service accounts are not interactive — interactive login is blocked.

## 7. Federated and external identity
- Federation with customer / partner IdPs is permitted only after security review and is recorded in the Integration Register.
- Social logins are not used for any {{client_name}}-internal system.

## 8. Audit and monitoring
- Authentication events are logged to the central platform per the Logging & Monitoring Policy (A.8.15–16).
- Anomalous sign-ins (impossible travel, new geo, brute force) trigger automated alerts.

## 9. Related documents
- Privileged Access Management Procedure (A.8.2)
- Access Control Policy (A.5.15)
- User Endpoint Devices Policy (A.8.1)
`
  },
  {
    name: 'Capacity Management Policy',
    category: 'policy',
    description: 'Forecasting and provisioning capacity to meet performance and security objectives (A.8.6).',
    content: `# Capacity Management Policy

${HEADER('A.8.6')}

## 1. Purpose
To ensure that {{client_name}} information processing facilities have sufficient capacity to meet current and projected needs without compromising security or service objectives.

## 2. Scope
All compute, storage, network, and licensing capacity that supports services within the ISMS scope.

## 3. Principles
- Capacity is monitored continuously, not at incident time.
- Forecasting considers business growth, marketing campaigns, customer onboarding, audit cycles, and seasonality.
- Headroom targets prevent capacity exhaustion from causing availability or integrity failures.

## 4. Monitoring

### 4.1 Metrics
For each resource class:
- Compute: CPU, memory, queue depth, application response time.
- Storage: used %, IOPS, latency, free inodes.
- Network: bandwidth, packet loss, latency, concurrent connections.
- Identity / auth: sign-in throughput, MFA challenge rate.
- Logging: ingest rate vs. quota.

### 4.2 Thresholds
- **Green** (< [70]%): no action.
- **Amber** ([70–85]%): increase forecast confidence; raise capacity request.
- **Red** (> [85]%): scale immediately; document.

## 5. Forecasting
Forecasting is performed [quarterly] for each resource class. The forecast considers:
- Historical trend (last 12 months).
- Known business changes (launches, large customer onboarding).
- Procurement / provisioning lead time.

The output is a capacity plan reviewed by the ISMS Manager and (where material) referenced at Management Review.

## 6. Cloud capacity
Auto-scaling rules:
- Have a documented maximum (cost cap) approved by [FINANCE].
- Trigger an alert on max scale-out so capacity exhaustion is visible.
- Are tested monthly with a chaos-style burst test.

## 7. Capacity tests
Pre-launch and pre-peak capacity tests are documented and signed off by [SRE_LEAD] and [SECURITY].

## 8. Records
Capacity reports and forecast vs. actual variance are retained for [3] years.

## 9. Related documents
- Logging and Monitoring Policy (A.8.15–16)
- Information Backup Policy (A.8.13)
- Business Continuity Plan
`
  },
  {
    name: 'Malware Protection Policy',
    category: 'policy',
    description: 'Detection and prevention of malicious code (A.8.7).',
    content: `# Malware Protection Policy

${HEADER('A.8.7')}

## 1. Purpose
To protect {{client_name}}'s information assets from malicious code and to ensure that suspected infections are detected and contained quickly.

## 2. Scope
All endpoints, servers, and email / web gateways processing or transmitting {{client_name}} information.

## 3. Required controls

### 3.1 Endpoints and servers
- A {{client_name}}-approved EDR product is installed on every endpoint and server.
- Definitions / engine are kept current automatically.
- Real-time protection is enabled.
- Tamper protection is enabled — users cannot disable EDR.
- The EDR reports health and detections to the central console.

### 3.2 Email
- Inbound email passes through a gateway that scans for malware, phishing indicators, and known bad senders.
- High-risk attachments (executables, macro-enabled documents, ISO containers) are stripped, sandboxed, or quarantined.
- Outbound email is monitored for sensitive content (DLP integration, A.8.12).

### 3.3 Web
- Workforce web browsing transits a secure web gateway or DNS-layer filter that blocks known-malicious categories and IOCs.
- File downloads above [50] MB are sandbox-scanned.

### 3.4 Removable media
- Removable media is scanned on insertion (per Removable Storage Media Procedure, A.7.10).

## 4. Allowlisting / application control
On Restricted-tier systems, only approved binaries may execute. The allowlist is owned by IT Operations, and is updated through the Change Management Procedure.

## 5. Detection response
- A medium / high severity detection raises an alert in the SIEM.
- The endpoint is automatically isolated where the EDR supports it.
- Triage is initiated by [SOC] within [15] minutes during business hours and [60] minutes out-of-hours.
- Confirmed infection follows the Information Security Incident Management Procedure.

## 6. User education
- Awareness training (A.6.3) covers phishing, downloads, and how to report suspected infection.
- Phishing simulations are run [quarterly]; results feed targeted training.

## 7. Suppliers
Suppliers handling {{client_name}} data must demonstrate equivalent malware controls per the Supplier Information Security Policy.

## 8. Records
EDR detection reports and SOC triage outcomes are retained for [12 months].

## 9. Related documents
- Information Security Incident Management Procedure (A.5.24)
- User Endpoint Devices Policy (A.8.1)
- Vulnerability Management Procedure (A.8.8)
- Logging and Monitoring Policy (A.8.15–16)
`
  },
  {
    name: 'Vulnerability Management Procedure',
    category: 'procedure',
    description: 'Identifying, prioritising, and remediating technical vulnerabilities (A.8.8).',
    content: `# Vulnerability Management Procedure

${HEADER('A.8.8')}

## 1. Purpose
To identify and remediate technical vulnerabilities in {{client_name}}'s information systems before they can be exploited.

## 2. Scope
All systems within the ISMS scope: endpoints, servers, network devices, container images, cloud accounts, third-party libraries, and externally exposed services.

## 3. Sources of vulnerability information
- Vendor advisories (Microsoft, Apple, Linux distributions).
- CVE feed (NVD or equivalent).
- Container base-image scan results.
- Software composition analysis on the codebase (per Secure Development Life Cycle).
- Authenticated and unauthenticated network scans.
- Penetration tests and bug-bounty reports.
- Threat intelligence (per A.5.7).
- Incidents and near-misses indicating possible vulnerability.

## 4. Inventory
Each scannable asset must be in the asset inventory (per Asset Management Procedure) so that scans cover the full estate.

## 5. Scanning cadence
| Asset class | Cadence | Tooling |
|-------------|---------|---------|
| Internet-exposed services | Continuous + weekly authenticated | [TOOL] |
| Production server fleet | Weekly authenticated | [TOOL] |
| Endpoints | Weekly via EDR + monthly authenticated | EDR |
| Container images | On every build + daily for deployed images | [TOOL] |
| Codebase (SCA) | On every PR + nightly | [TOOL] |
| Cloud configuration | Continuous | CSPM |

## 6. Prioritisation
Vulnerabilities are prioritised by:
1. Exploitability (active exploitation? proof-of-concept? KEV catalog?).
2. Reachability (internet-facing? auth-required?).
3. Impact (asset criticality + classification).
4. CVSS score (as a tie-breaker only — not as the sole ranking).

## 7. Remediation SLA

| Severity | SLA |
|----------|-----|
| Critical / actively exploited | [48 hours] from confirmation |
| High | [7] days |
| Medium | [30] days |
| Low | [90] days or accept |

SLAs are measured from confirmation, not initial detection.

## 8. Patching workflow
1. Triage: confirm applicability and severity. False positives are recorded with rationale.
2. Test: validate the patch in a non-production environment for in-scope systems.
3. Deploy: apply via the configuration management / endpoint management tool.
4. Verify: confirm via re-scan that the vulnerability is no longer present.

For zero-days where no patch exists, compensating controls (network isolation, WAF rule, feature disable) are documented and reviewed weekly until a patch is available.

## 9. Exceptions
Where a vulnerability cannot be remediated within SLA, an exception is raised in the Exception Register with:
- Reason.
- Compensating controls.
- Risk owner approval.
- Sunset date (no longer than [180] days).

## 10. Reporting
A monthly vulnerability dashboard is presented to the ISMS Manager and reviewed at Management Review. Metrics:
- Open vulnerabilities by severity.
- SLA compliance %.
- Mean time to remediate.
- Trend over the quarter.

## 11. Related documents
- Configuration Management Procedure (A.8.9)
- Change Management Procedure (A.8.32)
- Threat Intelligence Procedure (A.5.7)
- Logging and Monitoring Policy (A.8.15–16)
`
  },
  {
    name: 'Configuration Management Procedure',
    category: 'procedure',
    description: 'Establishing and maintaining secure baselines (A.8.9).',
    content: `# Configuration Management Procedure

${HEADER('A.8.9')}

## 1. Purpose
To establish, document, and maintain secure baselines for {{client_name}}'s information processing systems and to detect drift from those baselines.

## 2. Scope
Endpoints, servers, network devices, cloud platform configurations, identity provider configurations, and applications within the ISMS scope.

## 3. Baseline standards
For each asset class, a documented baseline specifies:
- Approved OS version(s).
- Required security agents (EDR, monitoring, MDM).
- Patch level minimum.
- Local accounts and group memberships.
- Service / port profile.
- Logging configuration.
- Hardening reference (e.g., CIS Benchmark Level 1 + organisation-specific overrides).

Baselines are owned by [IT_OPS] and version-controlled in [REPO_LOCATION].

## 4. Baseline application
- New endpoints are imaged from the baseline.
- Servers are deployed from infrastructure-as-code that pins the baseline.
- Cloud accounts apply the baseline via guardrails / Service Control Policies.

## 5. Drift detection
- Configuration scans (CSPM, endpoint compliance, server hardening checks) run [daily] on Restricted assets and [weekly] elsewhere.
- Drift is auto-remediated where safe (config-as-code apply); otherwise a ticket is raised to [IT_OPS] with the SLA from the Vulnerability Management Procedure.

## 6. Approved exceptions
Specific deviations from baseline are recorded in the Exception Register with sunset dates. The register is reviewed at every Management Review.

## 7. Change control
Every baseline change passes through the Change Management Procedure (A.8.32) including security review.

## 8. Records
- Current baseline document(s).
- Drift scan reports retained for [12 months].
- Exception register.

## 9. Related documents
- Change Management Procedure (A.8.32)
- Vulnerability Management Procedure (A.8.8)
- Logging and Monitoring Policy (A.8.15–16)
`
  },
  {
    name: 'Information Deletion Procedure',
    category: 'procedure',
    description: 'Routine and on-request deletion of information (A.8.10).',
    content: `# Information Deletion Procedure

${HEADER('A.8.10')}

## 1. Purpose
To delete information from {{client_name}} systems when it is no longer required for the purpose for which it was collected and processed, in line with retention rules and applicable law.

## 2. Scope
All information held by {{client_name}}, including:
- Personal data.
- Customer-supplied data.
- Source code and intellectual property.
- Records (training, MRM, audit).
- Backups and archives.
- Log data.

## 3. Categories of deletion

### 3.1 Routine retention-driven deletion
Information is deleted automatically when its retention period (per Retention Schedule, see Records Control Procedure) expires. Retention rules are configured per data store.

### 3.2 On-request deletion
A.5.34 / privacy law may require deletion on data-subject request. The request is recorded in the Privacy Request Register, completed within [30 days] of receipt (extending only as permitted by law), and verified.

### 3.3 Deletion at end of processing
When a processing activity ends (decommissioned product, terminated supplier engagement), the data store inventory is reviewed and information is deleted unless retention requires otherwise.

## 4. Deletion methods

| Asset | Method |
|-------|--------|
| Database row | DELETE statement; soft-delete is permitted only if a hard-delete job runs within the retention window |
| File / object storage | Permanent delete with bypass of soft-delete buckets |
| Backups | Either crypto-shred (per crypto-shred policy) or wait for backup retention to expire |
| Logs | Delete by retention rule applied at the log platform |
| Endpoint data | Delete locally + ensure not synced to backup beyond retention |
| Decommissioned media | Per Secure Disposal and Reuse Procedure (A.7.14) |

## 5. Backups
Where data is in long-retention backups that cannot be selectively deleted in time, the **crypto-shred** approach is used: the encryption key for the affected backup tier is rotated, rendering old backups unrecoverable.

## 6. Verification
For Confidential and Restricted data, deletion is verified by:
- Sampling the data store.
- Confirming that a query for the original record returns no rows.
- Where appropriate, running a forensic recovery attempt.

A verification certificate is recorded in the Deletion Register and retained for [3 years].

## 7. Roles
- **Data owner** confirms what data exists and what should be deleted.
- **IT Operations** performs deletion.
- **ISMS Manager** signs off Confidential/Restricted deletion certificates.

## 8. Related documents
- Records Control Procedure (A.5.33)
- Privacy and PII Protection Policy (A.5.34)
- Secure Disposal and Reuse Procedure (A.7.14)
`
  },
  {
    name: 'Data Masking and Pseudonymisation Policy',
    category: 'policy',
    description: 'When and how to mask, pseudonymise, or anonymise data (A.8.11).',
    content: `# Data Masking and Pseudonymisation Policy

${HEADER('A.8.11')}

## 1. Purpose
To reduce information risk by limiting the exposure of identifiable or sensitive information beyond the minimum needed for the task.

## 2. Scope
Any system or process that stores, processes, or transfers personal data, financial data, secrets, or other Confidential / Restricted information.

## 3. Definitions
- **Anonymisation:** transformation that renders re-identification practically impossible. Out of scope of GDPR once truly anonymised.
- **Pseudonymisation:** replacement of identifiers with pseudonyms while keeping a separate key to re-identify. Still personal data under GDPR.
- **Masking:** redaction or transformation of data values for display or downstream use, often reversible only under controlled conditions (e.g., dynamic masking).

## 4. When to apply

| Use case | Technique |
|----------|-----------|
| Production data in test / dev environments | Mask or synthesise — never copy raw production |
| Logs and analytics | Pseudonymise identifiers; never log secrets, tokens, full card numbers, or full health data |
| Support tools displaying customer data | Dynamic masking by default; reveal under role + auditable click |
| Data sharing with researchers / suppliers | Anonymise where possible, pseudonymise otherwise — DPA required either way |
| Demos and training materials | Use synthetic or anonymised data |

## 5. Techniques (illustrative)
- Format-preserving tokenisation for card numbers.
- Hash + salt for identifiers when only equality is needed.
- Suppression / generalisation for analytics.
- k-anonymity / l-diversity tooling for research datasets.
- Vault-based tokenisation for high-sensitivity data.

## 6. Re-identification key management
The pseudonymisation key:
- Is stored in the central secrets manager.
- Has a documented owner.
- Is rotated on a defined schedule and after any suspected compromise.
- Is not logged, included in backups in the same security tier, or reachable from the dataset.

## 7. Verification
For new datasets that {{client_name}} considers anonymous:
- A risk-of-re-identification review is performed by [DPO] before release.
- The review considers auxiliary data, dataset size, and known re-identification attacks.

## 8. Records
- Inventory of pseudonymised datasets.
- Re-identification reviews.
- Approvals for raw-data access in support tools.
Retained for [3 years].

## 9. Related documents
- Information Classification Policy (A.5.12)
- Privacy and PII Protection Policy (A.5.34)
- Logging and Monitoring Policy (A.8.15–16)
`
  },
  {
    name: 'Data Leakage Prevention Policy',
    category: 'policy',
    description: 'Preventing unauthorised information transfer (A.8.12).',
    content: `# Data Leakage Prevention Policy

${HEADER('A.8.12')}

## 1. Purpose
To detect and prevent unauthorised disclosure or transfer of {{client_name}} information.

## 2. Scope
All channels through which information may leave the {{client_name}} environment: outbound email, web upload, removable media, SaaS sync, code repositories, and printing.

## 3. Detection mechanisms
{{client_name}} operates DLP detection on:
- Outbound email — content + attachment inspection at the gateway.
- Web traffic — secure web gateway with content rules.
- Cloud SaaS — CASB or native DLP within sanctioned platforms.
- Endpoints — file-fingerprinting and removable-media controls.
- Source code repositories — secret scanning + classification rules.
- Printers — secure print release with reporting.

## 4. Detection rules
Rules are tuned for the data {{client_name}} actually holds — generic templates produce noise. Examples:
- Customer record bulk download (> [N] records).
- Health-data identifiers in unsanctioned destinations (where applicable).
- Credentials / tokens in code commits or messages.
- Encryption keys leaving the secret store.
- Mass forwarding of internal email to external domains.

The rule set is reviewed [quarterly].

## 5. Response

| Verdict | Action |
|---------|--------|
| Confirmed leak | Block transfer + raise incident under A.5.24 + initial investigation within [4 hours] |
| Suspected leak | Quarantine + review by [SOC] within [4 business hours] |
| User-warned (e.g., pop-up) | Logged, optional follow-up by manager |

## 6. Allow-listing
Some legitimate large transfers occur (customer data exports, supplier integrations). These are pre-approved and documented in the DLP Allow-List Register, owned by [IT_OPS] and reviewed quarterly.

## 7. Privacy and proportionality
DLP monitoring is proportionate, lawful, and disclosed to staff in the Acceptable Use Policy and applicable employment notices. Personal email content is not targeted; automated scanning is for security indicators, with escalation to humans only on positive hits.

## 8. Records
DLP detection events, false-positive resolutions, and confirmed leaks are retained for [12 months]. Incident records are retained per the Information Security Incident Management Procedure.

## 9. Related documents
- Acceptable Use Policy (A.5.10)
- Information Classification Policy (A.5.12)
- Information Security Incident Management Procedure (A.5.24)
`
  },
  {
    name: 'Logging and Monitoring Policy',
    category: 'policy',
    description: 'What to log, where, and how it is monitored (A.8.15, A.8.16).',
    content: `# Logging and Monitoring Policy

${HEADER('A.8.15, A.8.16, A.8.17')}

## 1. Purpose
To ensure that {{client_name}} systems generate sufficient log information for accountability, detection of anomalies, investigation of incidents, and demonstration of compliance.

## 2. Scope
All systems within the ISMS scope that produce or transit information, including endpoints, servers, network devices, cloud platforms, identity provider, applications, and security tooling.

## 3. Events that must be logged
At a minimum, the following events are captured for in-scope systems:
- Authentication: success, failure, MFA challenges, password reset.
- Authorisation: privilege escalation, sudo, role assumption.
- Account management: creation, modification, deletion, group membership changes.
- Access to information classified Confidential or above.
- Configuration changes: OS, application, security control, firewall rule, IAM policy.
- Use of administrative functions.
- Security alerts: EDR detections, IDS/IPS alerts, DLP events.
- Application events: unhandled exceptions, error rates, business-critical actions.
- System events: start / stop, crashes, capacity warnings.

Logs must include: timestamp, source, actor, action, target, outcome, and source IP where applicable.

## 4. Clock synchronisation (A.8.17)
All in-scope systems synchronise clocks against a {{client_name}} time source (NTP / chrony) which is itself synced to authoritative public sources. Drift is monitored and a deviation > [60] seconds raises an alert.

## 5. Log integrity and protection
- Logs are forwarded to a central platform within [60] seconds of generation.
- The central platform stores logs in append-only / write-once mode.
- Log access by administrators is itself logged.
- Logs are encrypted at rest and in transit.
- Tamper-evident hash chains are used where required by control criticality.

## 6. Retention
| Source | Retention |
|--------|-----------|
| Authentication / IAM logs | [12 months] hot, [3 years] cold |
| Network firewall / IDS | [12 months] |
| EDR / SIEM detections | [12 months] |
| Application audit logs | [3 years] (or longer per record retention rule) |
| OS / system | [12 months] |
| Privileged session recordings | [3 years] |

Retention is overridden by Records Control Procedure where the same data is also a record.

## 7. Monitoring and alerting
- A SIEM or equivalent correlates and alerts on:
  - Brute force / credential stuffing.
  - Impossible travel / new geo.
  - Privilege escalation.
  - Mass data export.
  - Disablement of security tooling.
  - Detection patterns from threat intelligence.
- High-severity alerts page the [SOC] 24×7.
- Medium-severity alerts are triaged within [4 business hours].

## 8. Reviews
- The detection rule set is reviewed [quarterly] for coverage and false-positive rate.
- A monthly summary is produced for the ISMS Manager.

## 9. Related documents
- Authentication Policy (A.8.5)
- Privileged Access Management Procedure (A.8.2)
- Information Security Incident Management Procedure (A.5.24)
`
  },
  {
    name: 'Network Security Policy',
    category: 'policy',
    description: 'Network design, segregation, and external connectivity (A.8.20–A.8.23).',
    content: `# Network Security Policy

${HEADER('A.8.20, A.8.21, A.8.22, A.8.23')}

## 1. Purpose
To establish secure design and operation of {{client_name}}'s networks, including segregation of trust zones and protection of services exposed to external networks.

## 2. Scope
All networks owned or operated by {{client_name}}: corporate, production, lab/test, guest, and any cloud virtual networks within the ISMS scope.

## 3. Trust zones
Networks are designed in trust zones with default-deny between them:

| Zone | Examples | Connectivity policy |
|------|----------|--------------------|
| Public | Internet | Untrusted |
| Guest | Visitor Wi-Fi | Internet only, no internal |
| Corp | Workforce LAN / corporate VPN | Limited egress, no direct production access |
| Production | Customer-serving services | Highly restricted; only via documented service-mesh / NACLs |
| Management | Bastion / admin access | Reachable only from named admin endpoints with MFA + privileged session |

## 4. Boundary controls
- Stateful firewalls or cloud security groups at every zone boundary.
- Default-deny inbound; all rules documented with owner and review date.
- Egress filtering on Production: known destinations only.
- IDS / IDS-like monitoring at internet boundary.
- WAF in front of internet-exposed web applications.

## 5. Segregation (A.8.22)
- Customers, environments (dev/test/prod), and services with different sensitivity levels are isolated by network controls.
- VLAN / VPC / subnet boundaries match security groups; no flat networks.
- Wireless networks: corp Wi-Fi uses 802.1X + MFA-equivalent; guest Wi-Fi is fully isolated from corp.

## 6. Web filtering (A.8.23)
Workforce internet traffic transits a secure web gateway / DNS filter that:
- Blocks known-malicious categories (malware, phishing, command-and-control).
- Blocks personal-storage where Acceptable Use prohibits.
- Logs to the central log platform.

## 7. Encryption in transit
- Public-facing services use TLS 1.2 minimum (1.3 preferred), with managed cipher suites and HSTS.
- Service-to-service in Production uses mutual TLS where feasible.
- Certificates are issued by approved authorities; expiry is monitored with [30-day] alerting.

## 8. Remote access
Workforce remote access uses a managed VPN or zero-trust access broker with MFA and device-posture checks. Split tunnelling is permitted only for approved low-sensitivity destinations.

## 9. Network change control
All firewall, security-group, and routing changes go through the Change Management Procedure with security review for production changes.

## 10. Records
- Network architecture diagram (current + history).
- Firewall rule register with owner and last review.
- IDS / WAF detection summary monthly.

## 11. Related documents
- Authentication Policy (A.8.5)
- Configuration Management Procedure (A.8.9)
- Logging and Monitoring Policy (A.8.15–16)
- Change Management Procedure (A.8.32)
`
  },
  {
    name: 'Secure Development Life Cycle Policy',
    category: 'policy',
    description: 'Security through every phase of software development (A.8.25, A.8.26, A.8.27).',
    content: `# Secure Development Life Cycle Policy

${HEADER('A.8.25, A.8.26, A.8.27, A.8.30')}

## 1. Purpose
To embed information security into every phase of {{client_name}}'s software development, from requirements through to retirement.

## 2. Scope
All software developed by or for {{client_name}}, whether for internal use, customer-facing services, or back-office tooling — including outsourced development (A.8.30).

## 3. Phases and security activities

### 3.1 Requirements and design (A.8.26, A.8.27)
- Security requirements are derived from data classification, legal / regulatory obligations, and threat modelling.
- Threat modelling (lightweight STRIDE or equivalent) is performed for every new feature that handles Confidential data, integrates with new external systems, or changes authentication / authorisation.
- Architecture decisions follow secure design principles: least privilege, defence in depth, fail safe, separation of duties, complete mediation, secure defaults, minimal attack surface, economy of mechanism.
- Security findings from threat modelling become design tasks tracked in the engineering backlog.

### 3.2 Implementation (A.8.28)
- Coding standards reference an external baseline (OWASP Application Security Verification Standard, SEI CERT, or platform-specific) plus {{client_name}} additions.
- Pre-commit hooks block secrets and low-quality code.
- Branch protection requires:
  - Code review by at least one reviewer who did not author.
  - All required CI checks pass (build, lint, tests, SCA, SAST, container scan).
  - Signed commits where used.
- Dependencies are pulled from approved registries with provenance verification (Sigstore / signed releases) where available.

### 3.3 Build and deploy (A.8.31)
- Build pipelines are reproducible and produce signed artefacts.
- Secrets are injected at build / deploy time from the central secrets manager — never committed.
- Production deploys go through a release approval that records who, what, and when.
- Separation of duties: developer ≠ approver ≠ deployer for production releases of Restricted services.

### 3.4 Test (A.8.29)
- Automated tests run on every PR: unit, integration, security-relevant tests.
- Application security testing combines SAST, SCA, DAST, and (for high-risk releases) manual penetration testing.
- All findings above the SLA threshold (per Vulnerability Management Procedure) gate the release.

### 3.5 Operate
- Production telemetry is reviewed (per Logging and Monitoring Policy).
- Vulnerabilities discovered post-release follow the Vulnerability Management Procedure.
- Security incidents follow the Information Security Incident Management Procedure.

### 3.6 Retirement
- Retirement of a service triggers data deletion per Information Deletion Procedure.
- Customer notice is given where applicable.

## 4. Outsourced development (A.8.30)
Where development is outsourced:
- Contractual security requirements are included (per Supplier Information Security Policy).
- Source code review and security testing are performed before acceptance.
- The supplier's development practices are reviewed annually.

## 5. Records
- Threat models, design reviews, security testing reports.
- Retained for [3 years] or for the lifetime of the service plus [1 year], whichever is longer.

## 6. Related documents
- Application Security and Secure Coding Standard (A.8.26 / A.8.28 detail)
- Security Testing in Development and Acceptance Procedure (A.8.29)
- Change Management Procedure (A.8.32)
- Vulnerability Management Procedure (A.8.8)
- Supplier Information Security Policy
`
  },
  {
    name: 'Application Security and Secure Coding Standard',
    category: 'policy',
    description: 'Concrete coding rules and application security baselines (A.8.26, A.8.28).',
    content: `# Application Security and Secure Coding Standard

${HEADER('A.8.26, A.8.28')}

## 1. Purpose
To set concrete, testable rules for application security and secure coding within {{client_name}}.

## 2. Scope
All in-house developed software within the ISMS scope.

## 3. Required practices

### 3.1 Input handling
- All inputs from outside the trust boundary are validated against an allow-list before use.
- Output encoding is applied at the boundary appropriate to the sink (HTML escape, attribute escape, URL encode, JSON encode, SQL parameter, OS command argument).
- Parameterised queries are mandatory for SQL; string concatenation into queries is prohibited.
- File path inputs are normalised and validated against the allowed root before use.

### 3.2 Authentication and session
- Authentication is delegated to the central identity provider (per Authentication Policy).
- Session tokens are HttpOnly, Secure, SameSite=Lax (or Strict), random, and short-lived.
- Logout invalidates the server-side session, not just the cookie.

### 3.3 Authorisation
- Authorisation is enforced server-side on every request — never relied on the client.
- The principle of least privilege governs API permissions; deny by default.
- IDOR (insecure direct object references) is prevented by checking object ownership / membership before any read or mutation.

### 3.4 Cryptography
- Use the platform's vetted cryptographic library; do not implement primitives.
- Algorithms and key lengths follow the Cryptography Policy (A.8.24).
- Random values for tokens / IDs use a CSPRNG.
- Plaintext storage of passwords, secrets, or keys in code, configuration, or logs is prohibited.

### 3.5 Secrets
- Secrets are read from the central secrets manager at runtime.
- Secrets are not logged, printed, or returned in error messages.
- Pre-commit and CI scan for accidental commits of secrets.

### 3.6 Dependency hygiene
- Direct and transitive dependencies are scanned per the Vulnerability Management Procedure.
- Pinning to versions (lockfiles) is required.
- Unmaintained dependencies (no release in [24 months]) are flagged for replacement.

### 3.7 Errors and logging
- Errors expose no stack traces, internal paths, or sensitive data to the client.
- Server logs include enough context for forensic analysis but do not log secrets, full payment data, or full health identifiers.

### 3.8 Headers and transport
- HTTPS is mandatory; HSTS is set with a long max-age and includeSubDomains.
- Security headers: Content-Security-Policy, X-Content-Type-Options, X-Frame-Options or frame-ancestors, Referrer-Policy, Permissions-Policy.
- Cookies follow Secure + HttpOnly + SameSite as above.

### 3.9 Common high-impact classes
The OWASP Top 10 (current edition) and OWASP API Security Top 10 are required reading; specific rules covering each class are documented in [REPO_DOC] and enforced via SAST + reviewer checklist.

## 4. Verification
- SAST runs on every PR.
- DAST runs on staging on a [weekly] basis and pre-release.
- Penetration tests on customer-facing services [annually] and on major releases.

## 5. Exceptions
Deviations from this standard require an entry in the Exception Register, with a sunset date, owner, and compensating control.

## 6. Records
SAST / DAST findings, exceptions, pen-test reports — retained per the Secure Development Life Cycle Policy.

## 7. Related documents
- Secure Development Life Cycle Policy (A.8.25)
- Cryptography Policy (A.8.24)
- Logging and Monitoring Policy (A.8.15–16)
`
  },
  {
    name: 'Security Testing in Development and Acceptance Procedure',
    category: 'procedure',
    description: 'Required security tests before code reaches production (A.8.29).',
    content: `# Security Testing in Development and Acceptance Procedure

${HEADER('A.8.29')}

## 1. Purpose
To define the security testing required before code is accepted into production.

## 2. Scope
All software changes to in-scope systems, whether developed in-house or by suppliers.

## 3. Test types and triggers

| Test | When | Owner | Required pass criterion |
|------|------|-------|--------------------------|
| SAST (static analysis) | Every PR | Engineering | No new critical / high findings |
| SCA (software composition) | Every PR + nightly | Engineering | No critical CVEs in direct deps |
| Container image scan | On build | Engineering | No critical CVEs unless documented exception |
| Secret scanning | Every PR | Engineering | Zero detections |
| Unit + integration tests including security cases | Every PR | Engineering | All pass |
| DAST | Weekly on staging + pre-release | Engineering | No new critical / high |
| Penetration test | Annually + on major release of internet-facing service | External / Security | Critical / high closed before launch |
| Threat-model walkthrough | New feature with auth / data flow change | Architect + Security | Risks documented + mitigated or accepted |

## 4. Process

### 4.1 Pre-merge gates
A PR cannot be merged unless all required automated checks pass and at least one peer review approves. The branch-protection rules in [REPO] enforce this.

### 4.2 Pre-release gates
Before a release reaches production:
- The release manager confirms the test matrix above is satisfied for the change.
- Outstanding security findings are either remediated or have an entry in the Exception Register with risk-owner approval.
- Release notes are produced.

### 4.3 Acceptance testing for supplier-developed code
- Supplier delivers a security testing report covering the same matrix.
- {{client_name}} performs an independent SAST + DAST + dependency check on the delivered artefact.
- Acceptance is conditional on closing critical / high findings.

## 5. Re-testing
- Critical / high findings remediated in production are verified by re-running the test that found them.
- Pen-test findings are re-tested by the same vendor or by {{client_name}} security to confirm closure.

## 6. Records
Test results, exception approvals, and pen-test reports are retained for [3 years].

## 7. Related documents
- Secure Development Life Cycle Policy (A.8.25)
- Application Security and Secure Coding Standard (A.8.26 / A.8.28)
- Vulnerability Management Procedure (A.8.8)
`
  },
  {
    name: 'Separation of Development, Test and Production Environments Policy',
    category: 'policy',
    description: 'Environment isolation and data handling (A.8.31).',
    content: `# Separation of Development, Test and Production Environments Policy

${HEADER('A.8.31')}

## 1. Purpose
To prevent unauthorised access to or unintended changes in production by maintaining clear separation between development, test, and production environments.

## 2. Scope
All environments hosting in-scope services or processing in-scope information.

## 3. Required separation

### 3.1 Network
- Development, test, and production reside in distinct network boundaries (separate VPCs / VLANs / accounts).
- Cross-environment connectivity is denied by default and permitted only by documented exception.

### 3.2 Identity and access
- Production uses a separate set of IAM principals from non-production.
- Developers may have read access to production logs (for debugging) but no write access by default — write access is privileged and time-bounded per the Privileged Access Management Procedure.
- Service accounts in non-production cannot authenticate to production and vice versa.

### 3.3 Data
- Production data is not copied into development or test environments.
- Where realistic data shapes are needed, masked / synthetic data is used (per Data Masking and Pseudonymisation Policy).
- Where customer-data testing is unavoidable (e.g., support reproduction), the access is time-bounded, recorded, and limited to the specific record(s).

### 3.4 Code and configuration
- Builds promoted to production are the same artefacts that passed test, with no manual modifications.
- Configuration that differs between environments is held in a configuration store and injected at runtime.

### 3.5 Tooling
- Engineers' local machines do not hold production credentials except via the central secrets manager with auth + MFA.
- CI/CD has separate runners or scopes for production and non-production deployments.

## 4. Verification
- Quarterly review of cross-environment IAM grants.
- Quarterly review of network exceptions.
- DLP monitors for production-data signatures appearing in non-production stores.

## 5. Exceptions
Time-bounded exceptions are recorded in the Exception Register with sunset dates and owner.

## 6. Related documents
- Configuration Management Procedure (A.8.9)
- Privileged Access Management Procedure (A.8.2)
- Data Masking and Pseudonymisation Policy (A.8.11)
- Change Management Procedure (A.8.32)
`
  },
  {
    name: 'Change Management Procedure',
    category: 'procedure',
    description: 'Risk-managed changes to information processing facilities (A.8.32).',
    content: `# Change Management Procedure

${HEADER('A.8.32')}

## 1. Purpose
To manage changes to {{client_name}}'s information processing facilities so that risks introduced by the change are identified, assessed, and mitigated before deployment.

## 2. Scope
Any change that may affect the confidentiality, integrity, or availability of in-scope systems, including:
- Software releases and feature flags affecting auth / authorisation / data flow.
- Infrastructure / cloud configuration changes.
- Network / firewall / IAM policy changes.
- Third-party integrations.
- Major configuration changes to security tooling.

Excluded: routine patches following the Vulnerability Management Procedure and emergency containment actions during a declared incident (which follow that procedure).

## 3. Change classes

| Class | Examples | Approval | Lead time |
|-------|----------|----------|-----------|
| Standard | Pre-approved low-risk template (e.g., scaling, routine deploy) | Self-service via change ticket | Same day |
| Normal | Most production changes | Change Advisory Board (CAB) | [3] business days |
| Emergency | Resolves an active incident or critical security issue | On-call CAB + post-implementation review | Immediate |

## 4. Required information for a change

### 4.1 Description
- What is changing.
- Why (driver: incident, customer commitment, project, etc.).
- Risk owner and implementer.

### 4.2 Risk and impact
- Affected services and dependencies.
- Information classification of data touched.
- Worst-case impact.
- Probability assessment.

### 4.3 Implementation plan
- Steps and timeline.
- Verification steps.
- Rollback plan.

### 4.4 Communications
- Internal stakeholders to notify.
- Customer / external communications if applicable.

## 5. Approval

### 5.1 Standard
Pre-approved templates are auto-approved on submission; risk owner is notified.

### 5.2 Normal
The CAB reviews:
- Risk and impact.
- Implementation and rollback plan.
- Test evidence.
- Conflicts with other changes.

The CAB meets [weekly]. Quorum is [3] including a security representative.

### 5.3 Emergency
On-call CAB members (including security) approve verbally; the request is documented within [4 hours] post-event.

## 6. Implementation
- Changes are deployed by authorised personnel only.
- For Restricted-tier services, four-eyes execution is required.
- Production changes outside maintenance windows require justification.

## 7. Verification
- The implementer verifies success per the plan.
- Post-deployment monitoring is reviewed for [60] minutes after deploy.
- Standard health metrics confirm no regression.

## 8. Rollback
If verification fails, the rollback plan is executed. The original change ticket is updated with the rollback decision and rationale.

## 9. Post-implementation review
For Normal and Emergency changes affecting Restricted-tier services, a brief post-implementation review captures:
- Did the change achieve its goal?
- Were there unintended impacts?
- Were the rollback steps valid?
- Lessons for future changes.

## 10. Records
- Change tickets retained for [3 years].
- CAB minutes retained for [3 years].

## 11. Related documents
- Configuration Management Procedure (A.8.9)
- Vulnerability Management Procedure (A.8.8)
- Information Security Incident Management Procedure (A.5.24)
`
  }
];
