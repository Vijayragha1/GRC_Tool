// ISO 27001:2022 starter templates - People (A.6.x) and Physical (A.7.x).
// Each is a STARTER. Review and tailor to the client's practices / risk appetite.

const STARTER = `> **Starting point.** Aligned with ISO 27001:2022 and ISO 27002:2022 implementation guidance. Replace bracketed placeholders, adjust to {{client_name}}'s practices, and have the document owner confirm intervals/thresholds before approval.\n\n---\n`;

const HEADER = (kind) => `${STARTER}
**Document Owner:** {{document_owner}}
**Approved by:** {{approval_authority}}
**Effective Date:** {{date}}
**Review Period:** {{review_period}}
**Annex A reference:** ${kind}

`;

module.exports = [
// =============== A.6 - People ===============
  {
    name: 'Confidentiality and Non-Disclosure Agreement',
    category: 'form',
    description: 'NDA template for staff, contractors, and counterparties (A.6.6).',
    content: `# Confidentiality and Non-Disclosure Agreement

${HEADER('A.6.6')}

This Agreement is entered into on **{{date}}** between **{{client_name}}** ("Discloser") and the undersigned ("Recipient").

## 1. Confidential Information
"Confidential Information" means any non-public information disclosed by the Discloser, in any form, including but not limited to: business plans, customer data, source code, security architecture, vulnerabilities, incident details, contract terms, technical designs, employee information, and information marked or reasonably identifiable as confidential.

## 2. Obligations of the Recipient
The Recipient shall:
- Use Confidential Information only for the purpose of [PURPOSE].
- Apply at least the same standard of care to Confidential Information as it applies to its own confidential information, and no less than reasonable care.
- Limit access to those of its personnel with a documented need-to-know who are bound by equivalent confidentiality obligations.
- Not disclose, copy, reproduce, or distribute Confidential Information except to the extent strictly necessary for the Purpose.
- Comply with {{client_name}}'s information security policies while accessing or processing Confidential Information.

## 3. Exclusions
This Agreement does not apply to information that is:
- Already public through no breach of this Agreement;
- Independently developed without reference to the Confidential Information;
- Lawfully received from a third party without restriction;
- Required to be disclosed by law or court order, provided the Recipient gives prompt notice to allow {{client_name}} to seek protective remedies.

## 4. Return or destruction
On termination or earlier on request, the Recipient shall return or securely destroy all Confidential Information (including copies) and certify destruction in writing within [10] business days.

## 5. Security incidents
The Recipient shall notify {{client_name}}'s designated contact ([INCIDENT_CONTACT]) without undue delay and in any event within [24 hours] of becoming aware of any actual or suspected unauthorized access to, disclosure of, or loss of Confidential Information.

## 6. Term and survival
This Agreement is effective from the date of signature and survives for [3] years after termination of the engagement / employment.

## 7. Governing law
This Agreement is governed by the laws of [JURISDICTION].

## 8. Signatures

Recipient: __________________________  Date: __________

Name (printed): _______________________  Role: __________

Witness for {{client_name}}: __________________________  Date: __________
`
  },

  {
    name: 'Disciplinary Process Procedure',
    category: 'procedure',
    description: 'Process for handling employee violations of information security policy (A.6.4).',
    content: `# Disciplinary Process Procedure

${HEADER('A.6.4')}

## 1. Purpose
To define the formal process by which {{client_name}} responds to violations of information security policy, ensuring fairness, consistency, and proportionality.

## 2. Scope
Applies to all employees, contractors, and third-party personnel acting on behalf of {{client_name}} who breach information security policies.

## 3. Triggering events
The procedure is triggered by, but not limited to:
- Confirmed unauthorized access, disclosure, modification, or destruction of information.
- Repeated non-compliance with mandatory training, AUP, or access control requirements.
- Failure to report a known security incident in line with A.6.8.
- Sharing of credentials or bypassing of authentication mechanisms.
- Negligence resulting in materialised risk (e.g., loss of unencrypted device).

## 4. Process

### 4.1 Initial assessment
On receipt of a substantiated allegation:
1. The line manager and HR jointly review the facts.
2. The ISMS Manager assesses the security impact and recommends technical containment (e.g., access revocation pending review).
3. Legal counsel is consulted before any formal action is taken.

### 4.2 Investigation
Investigations are conducted in accordance with [JURISDICTION] employment law. The subject is informed of the allegation, given access to relevant evidence, and given a reasonable opportunity to respond.

### 4.3 Determination of severity
Severity is determined considering:
- Intent (accidental, negligent, deliberate);
- Impact on confidentiality / integrity / availability;
- Whether sensitive personal data was involved;
- Prior disciplinary record;
- Whether the individual self-reported promptly.

### 4.4 Outcomes
Possible outcomes range from:
- Informal coaching and additional training;
- Formal written warning (retained on file for [12 months]);
- Final written warning;
- Suspension pending further investigation;
- Termination of employment / engagement;
- Referral to law enforcement where criminal conduct is evident.

### 4.5 Communication
The outcome is communicated in writing to the subject, to HR, and (in summary form) to the ISMS Manager for trend analysis. The detailed record is retained by HR.

## 5. Records and trend review
HR retains disciplinary records for [statutory minimum + 3] years. The ISMS Manager reviews anonymized aggregate data at each Management Review to identify systemic issues that may warrant control improvements rather than individual sanction.

## 6. Right of appeal
Employees have the right to appeal the outcome to [APPEAL_AUTHORITY] within [10] working days of notification.

## 7. Related documents
- Acceptable Use Policy (A.5.10)
- Reporting Information Security Events Procedure (A.6.8)
- Termination & Change of Employment Procedure (A.6.5)
`
  },

  {
    name: 'Termination and Change of Employment Procedure',
    category: 'procedure',
    description: 'Offboarding security tasks for leavers and role-changers (A.6.5).',
    content: `# Termination and Change of Employment Procedure

${HEADER('A.6.5')}

## 1. Purpose
To ensure that information security obligations remain enforceable after a person leaves {{client_name}} or changes role, and that access is removed or adjusted promptly.

## 2. Scope
All employees, contractors, and third-party personnel whose engagement is ending or whose role within scope of the ISMS is changing.

## 3. Triggering events
- Resignation, retirement, or end of fixed-term contract.
- Termination (including disciplinary).
- Promotion, transfer, or role change requiring different access.
- Long-term leave of absence (e.g., sabbatical > [90 days]).

## 4. Pre-departure / change actions

### 4.1 HR initiates
HR notifies the ISMS Manager, line manager, and IT within [1] business day of the decision being final.

### 4.2 Knowledge transfer
The line manager identifies any unique knowledge or active records the leaver holds, and ensures handover is complete before the last day.

### 4.3 Access review
For role changes, the new role's required access is documented; the old role's access is identified for revocation.

## 5. Last-day / effective-date actions

### 5.1 Logical access
The following are revoked or adjusted on the last day:
- Single sign-on / directory account.
- Email and collaboration tools.
- VPN and remote access.
- Privileged accounts and emergency-access credentials.
- API keys, service accounts owned by the leaver, OAuth grants.
- Cloud platform / SaaS access provisioned to the individual.

For role changes: old access revoked, new access provisioned per least-privilege.

### 5.2 Physical access
Building access cards, keys, and any other physical tokens are returned and disabled.

### 5.3 Assets
{{client_name}} property is recovered and recorded:
- Laptop, mobile device, removable media, hardware tokens.
- Software licences and certificates.
- Documentation, intellectual property, customer data on personal stores (if any).

### 5.4 Mailbox and drive
Mailbox and personal drive content is preserved, transferred to the line manager, or archived per Records Control Procedure (A.5.33).

## 6. Post-departure actions

### 6.1 Confidentiality reminder
HR provides a written reminder of ongoing confidentiality, IP assignment, and non-solicitation obligations.

### 6.2 Verification
The ISMS Manager verifies - within [5] business days - that all access has been removed by sampling logs and querying directory and SaaS membership exports.

### 6.3 Audit trail
Records of access revocation, asset return, and confidentiality reminder are retained for [statutory minimum + 3] years.

## 7. Exceptional circumstances
Hostile terminations follow the additional protocol [REF_DOCUMENT] including same-day-with-witness revocation and HR-supervised property recovery.

## 8. Related documents
- Disciplinary Process Procedure (A.6.4)
- Confidentiality and Non-Disclosure Agreement (A.6.6)
- Access Control Policy (A.5.15)
- Asset Management Procedure
`
  },

  {
    name: 'Remote Working Policy',
    category: 'policy',
    description: 'Security expectations for staff working outside {{client_name}} premises (A.6.7).',
    content: `# Remote Working Policy

${HEADER('A.6.7')}

## 1. Purpose
To set the security expectations and minimum controls when {{client_name}} information is processed outside dedicated office premises.

## 2. Scope
Anyone accessing {{client_name}} systems or information from a remote location, including home, public spaces, hotels, client offices, or while travelling.

## 3. Authorisation
Remote working requires the line manager's authorisation, which considers:
- Sensitivity of information accessed.
- Suitability of the environment.
- Availability of supporting controls (encryption, MFA, EDR, conditional access).

Authorisation may be granted on a standing or occasional basis and must be reviewed at least [annually].

## 4. Device requirements

### 4.1 {{client_name}}-issued devices (preferred)
- Full-disk encryption enabled and verified.
- EDR / anti-malware installed, current, and reporting.
- Patches applied within the time windows defined in Vulnerability Management Procedure.
- Screen lock with [10] minute idle timeout.
- Removable storage restricted per Removable Media Procedure.

### 4.2 Personal devices (where permitted)
Personal device use must be specifically authorised. When permitted, the device must:
- Run a supported operating system version with current patches.
- Enrol in MDM / MAM with the {{client_name}} security profile.
- Be enrolled in the company directory; access is gated by conditional-access rules.
- Not retain {{client_name}} data outside managed containers.

### 4.3 Prohibited
- Saving {{client_name}} data to personal cloud accounts (Google Drive, Dropbox, iCloud).
- Forwarding {{client_name}} email to personal addresses.
- Allowing family / housemates to use the work device.

## 5. Network and environment
- Always-on VPN is required when accessing internal systems.
- Public Wi-Fi may be used only via VPN; admin operations are not permitted on public Wi-Fi.
- Privacy filters are recommended where bystanders may overlook screens (cafés, planes, trains).
- Sensitive conversations (customer data, incidents) must not be conducted in earshot of bystanders.

## 6. Data handling
- Information classification rules (A.5.12) apply equally remotely.
- "Restricted" information is processed only on {{client_name}}-issued devices, and printed only when essential - printed material is shredded same day.
- Removable media handling follows the Removable Media Procedure (A.7.10).

## 7. Loss or theft
If a device or data is lost or believed compromised, the user reports it within [4 hours] via the Reporting Information Security Events Procedure (A.6.8). The ISMS Manager will arrange remote wipe and credential reset.

## 8. Travel - high-risk locations
For travel to [LIST_OF_HIGH_RISK_JURISDICTIONS], the ISMS Manager may require:
- Use of clean / loaner devices that are wiped on return.
- Reduced access scope while abroad.
- Disabling biometric unlock at border crossings.

## 9. Compliance and monitoring
{{client_name}} reserves the right to monitor remote-access logs in accordance with applicable law and the Privacy & PII Protection Policy. Repeated breaches of this policy follow the Disciplinary Process Procedure.

## 10. Related documents
- Acceptable Use Policy (A.5.10)
- User Endpoint Devices Policy (A.8.1)
- Authentication Policy (A.8.5)
- Information Classification Policy (A.5.12)
`
  },

  {
    name: 'Reporting Information Security Events Procedure',
    category: 'procedure',
    description: 'How any worker can report a suspected security event (A.6.8).',
    content: `# Reporting Information Security Events Procedure

${HEADER('A.6.8')}

## 1. Purpose
To make it easy and safe for anyone associated with {{client_name}} to report a suspected information security event so that incidents are detected early and contained quickly.

## 2. What to report
Report any of the following without delay:
- Lost or stolen device, badge, or hardware token.
- Suspected phishing email, smishing text, or social-engineering call.
- Suspected malware infection.
- Account behaving unexpectedly (unfamiliar sign-in alerts, missing data, unauthorised changes).
- Information disclosed to the wrong person or made public unintentionally.
- Physical break-in, tailgating, or unidentified visitor in a secure area.
- A near-miss - even if no harm occurred - so we can learn.
- Any policy violation observed.

When in doubt, report. Better to over-report than miss something.

## 3. How to report

### 3.1 Primary channel
Email **{{client_name}}** Security at [SECURITY_EMAIL] or open a ticket at [TICKET_URL].

### 3.2 Out-of-hours / urgent
Call the on-call number at [ON_CALL_NUMBER]. Available 24×7.

### 3.3 Anonymous reporting
The whistleblowing channel at [WHISTLEBLOWER_URL] accepts anonymous reports in line with [APPLICABLE_LAW].

### 3.4 What to include
- What you observed.
- When (date / time / approximate).
- Where (system, location, account).
- What action you have already taken (if any).
- How you can be contacted (or "anonymous").

You are not expected to investigate yourself.

## 4. Acknowledgement
The Security team acknowledges every report within [4] business hours and assigns a tracking ID.

## 5. Triage and escalation
Reports are triaged within [24] hours and either:
- Closed as informational (with a note back to the reporter).
- Promoted to an incident under the Information Security Incident Management Procedure (A.5.24).

## 6. Non-retaliation
{{client_name}} prohibits retaliation against any person who reports a suspected security event in good faith. Suspected retaliation is itself a disciplinary matter (A.6.4).

## 7. Awareness
This procedure is included in onboarding and refreshed at least annually as part of A.6.3 awareness training. Posters with the channels above are displayed in [LOCATIONS].

## 8. Records
All reports - closed and promoted - are logged in the ISMS for [3] years to enable trend analysis at the Management Review.
`
  },

  {
    name: 'Terms of Employment - Security Clauses',
    category: 'form',
    description: 'Boilerplate security clauses for employment / engagement contracts (A.6.2).',
    content: `# Terms of Employment - Security Clauses

${HEADER('A.6.2')}

These clauses are intended to be inserted into {{client_name}}'s standard employment / contractor agreements. They formalise the security obligations every worker accepts as a condition of engagement.

---

## Information security obligations

The Employee acknowledges and agrees that:

**1. Compliance with policies.** They will comply with all of {{client_name}}'s information security policies, procedures, and operating standards as published from time to time, and will complete all mandatory awareness and role-specific training within the timeframes set by {{client_name}}.

**2. Confidentiality.** They will hold all Confidential Information (as defined in the Confidentiality Schedule) in strict confidence during and after their engagement, and will not use it for any purpose other than the performance of their duties.

**3. Acceptable use.** They will use {{client_name}}'s information systems and assets in accordance with the Acceptable Use Policy, and only for legitimate business purposes (with limited reasonable personal use as expressly permitted).

**4. Authentication.** They will protect their authentication credentials (passwords, hardware tokens, biometric registrations) and will not share them with any other person, including colleagues or supervisors. They will use multi-factor authentication where required.

**5. Reporting.** They will promptly report any suspected information security event, weakness, or violation through the channels published in the Reporting Information Security Events Procedure.

**6. Asset return.** On termination of engagement, they will return all {{client_name}} property and assist {{client_name}} in confirming that all data, credentials, and access have been recovered.

**7. Continuing obligations.** Confidentiality and information security obligations survive termination of engagement to the extent set out in the Confidentiality Schedule and applicable law.

**8. Background screening.** Where permitted by law and proportionate to the role, the Employee consents to background verification (right-to-work, identity, professional qualifications, criminal record where relevant).

**9. Consequences.** Breach of these obligations may result in disciplinary action up to and including termination of engagement, in accordance with the Disciplinary Process Procedure, and may also expose the Employee to civil or criminal liability.

**10. Acknowledgement.** The Employee acknowledges that they have been provided with a summary of the applicable policies (or means to access them) and understands the obligations above.

---

Signed by Employee: __________________________  Date: __________

Name (printed): _______________________________

Signed for {{client_name}}: __________________________ Date: __________

Name and role: _______________________________
`
  },

// =============== A.7 - Physical ===============
  {
    name: 'Physical Security Perimeter and Entry Control Policy',
    category: 'policy',
    description: 'Physical security perimeters and authorisation of entry (A.7.1–A.7.4).',
    content: `# Physical Security Perimeter and Entry Control Policy

${HEADER('A.7.1, A.7.2, A.7.3, A.7.4')}

## 1. Purpose
To define the physical perimeters that protect {{client_name}}'s information processing facilities and the rules for authorising and recording entry into secure areas.

## 2. Scope
All sites occupied by {{client_name}} where information is processed, stored, or transmitted, including offices, data centres, comms rooms, and any rented co-working space holding {{client_name}} information assets.

## 3. Security zones
Sites are divided into zones in increasing order of sensitivity. Each zone has progressively stronger entry controls.

| Zone | Examples | Access by | Entry control |
|------|----------|-----------|---------------|
| Public | Reception, café, waiting area | Anyone | Reception sign-in |
| General | Open-plan office | Staff + escorted visitors | Badge access |
| Restricted | Server room, network closet, HR room, exec area | Named personnel only | Badge + (optional) PIN / biometric |
| High-security | Production data centre, evidence storage | Documented authorisation list | Badge + biometric, dual control where required |

## 4. Perimeter controls

### 4.1 Buildings
Each occupied building must have:
- A clearly defined external perimeter (walls, doors, windows).
- Functioning intrusion detection on external doors after-hours.
- Unobstructed sightlines for staff at reception or via CCTV.
- Emergency exits that allow exit but prevent unauthorised entry from outside.

### 4.2 CCTV
CCTV monitors entry points to Restricted and High-security zones. Recordings are retained for [30] days, longer where local law or contracts require.

### 4.3 Reception
Reception is staffed during business hours. Outside business hours, the building is locked and entry is by badge with after-hours alerting.

## 5. Entry controls

### 5.1 Staff
Staff are issued a badge that grants access only to the zones they need. Access is reviewed in line with the Access Control Policy (A.5.18) and revoked on termination per A.6.5.

### 5.2 Visitors
- All visitors sign in and out at reception, presenting government ID.
- Each visitor receives a visibly distinct badge.
- Visitors in General and Restricted zones are escorted at all times by an authorising staff member.
- Visitors are not granted access to High-security zones except under documented exception.

### 5.3 Contractors and delivery
Routine contractors (cleaners, maintenance) operate under a separate badge profile with time-of-day restrictions. Deliveries are received in the loading bay and never granted entry beyond the public zone.

### 5.4 After-hours and weekend access
Out-of-hours access to Restricted and High-security zones generates an alert to the on-call security contact for review.

## 6. Records

The visitor log (paper or electronic) is retained for [12] months. Badge access logs are retained for [12] months. Review of the access logs is performed at least [quarterly] by [ROLE].

## 7. Tailgating and challenge culture
Staff are expected to challenge any person they do not recognise in Restricted or High-security zones. Tailgating (entering a controlled door behind another person without scanning) is a disciplinary matter under A.6.4.

## 8. Working in secure areas (A.7.6)
While inside Restricted or High-security zones:
- No personal recording devices, including phones, may be used unless specifically authorised.
- No unauthorised photography.
- No unattended equipment is left logged in.
- All visitors are escorted at all times.

## 9. Related documents
- Access Control Policy (A.5.15)
- Equipment Security Policy (A.7.8 etc.)
- Clear Desk and Clear Screen Policy (A.7.7)
- Visitor Log (form)
`
  },

  {
    name: 'Clear Desk and Clear Screen Policy',
    category: 'policy',
    description: 'Protecting unattended workstations and printed information (A.7.7).',
    content: `# Clear Desk and Clear Screen Policy

${HEADER('A.7.7')}

## 1. Purpose
To reduce the risk of unauthorised viewing or theft of {{client_name}} information when workspaces are unattended.

## 2. Scope
All workspaces used by {{client_name}} personnel, including offices, hot desks, home offices, customer sites, and meeting rooms.

## 3. Clear desk

When stepping away from a workspace, personnel:
- Lock paper documents containing Internal, Confidential, or Restricted information in a locked drawer, cabinet, or pedestal.
- Remove documents from printers, scanners, fax machines, and copiers - secure print release is required for all printers in zones above General.
- Place sensitive sticky notes, whiteboards, and flip charts inside their workspace and erase or remove them at the end of day.
- Leave only public information visibly on the desk.

End of day expectations:
- No Restricted / Confidential paper documents are left out.
- Removable storage (USB, external HDD) is locked away.
- Hardware tokens (YubiKey, smart card) accompany the user or are locked away.
- Whiteboards in shared / meeting rooms are erased.

## 4. Clear screen

When leaving a workstation unattended for any period:
- Lock the screen - manually (Win+L / Ctrl+Cmd+Q) or by automated idle lock.
- Idle screen lock is enforced after [10] minutes by central policy.
- Public displays (showing dashboards, schedules) must not show information classified above Internal.

## 5. Printers and multi-function devices
- All printers in zones above General use secure print release: documents are held until the user authenticates at the device.
- Print queues are cleared automatically after [24] hours.
- Faxed and scanned documents are collected immediately.

## 6. Confidentiality in shared spaces
- In hot-desking, co-working, customer, or hotel environments, privacy filters are recommended on screens.
- Sensitive conversations are conducted in private rooms or by phone - not in open areas.

## 7. Compliance
Spot-check audits are conducted by [ROLE] on a [quarterly] basis. Findings are recorded and addressed via the line manager. Repeated violations follow the Disciplinary Process Procedure.

## 8. Related documents
- Acceptable Use Policy (A.5.10)
- Information Classification Policy (A.5.12)
- Physical Security Perimeter and Entry Control Policy (A.7.1)
`
  },

  {
    name: 'Equipment Security Policy',
    category: 'policy',
    description: 'Protecting equipment in use, off premises, and in transit (A.7.8, A.7.9, A.7.11, A.7.13).',
    content: `# Equipment Security Policy

${HEADER('A.7.8, A.7.9, A.7.11, A.7.13')}

## 1. Purpose
To define the controls protecting {{client_name}} equipment that processes or stores information, whether on-premises, off-site, or in transit.

## 2. Scope
All equipment owned or operated by {{client_name}} containing {{client_name}} information, including but not limited to: servers, network devices, workstations, laptops, mobile devices, printers, removable storage, and ancillary equipment (UPS, KVM, monitors).

## 3. Siting and protection (A.7.8)

Equipment is placed to minimise unauthorised access and environmental risk:
- Critical infrastructure (servers, network) is housed in zones at or above Restricted.
- Workstations are positioned so screens are not visible from outside the controlled area.
- Equipment is protected from environmental threats: water (away from plumbing), fire (alarms, suppression), excessive heat, dust, and electromagnetic interference where relevant.
- Eating, drinking, and smoking are prohibited in proximity to information processing equipment.

## 4. Supporting utilities (A.7.11)
- Power continuity for critical equipment is provided by UPS sized for [30] minutes' graceful shutdown plus generator failover where SLA requires.
- HVAC and humidity controls are maintained per manufacturer specification with monthly service records.
- Cabling is protected against tampering and accidental damage; data and power cabling are separated to reduce interference.
- Maintenance schedules are documented and followed.

## 5. Off-premises equipment (A.7.9)
Equipment removed from {{client_name}} premises:
- Is recorded against the user in the Asset Register before removal.
- Has full-disk encryption verified prior to removal.
- Is not left unattended in public areas, vehicles (except in a secure boot, briefly), or unsecured accommodation.
- Travel to high-risk jurisdictions follows the Remote Working Policy (A.6.7).

## 6. Equipment in transit
- Shipping of equipment between {{client_name}} sites or to suppliers uses tracked, tamper-evident packaging.
- Decommissioned media follows the Secure Disposal and Reuse Procedure (A.7.14).
- Hand-carried equipment in transit is protected by the same custody requirements as off-premises use.

## 7. Equipment maintenance (A.7.13)
- Maintenance is performed only by authorised personnel.
- Where third-party engineers handle equipment containing Confidential or Restricted data, they are escorted and bound by NDA.
- Where data must be left on equipment for repair, it is encrypted; where possible, equipment is sanitised and re-built post-repair.
- Maintenance records (date, engineer, equipment, work performed) are retained for [3] years.

## 8. Loss or damage
Loss, theft, or unintended damage to equipment containing {{client_name}} information is reported within [4 hours] via the Reporting Information Security Events Procedure.

## 9. Related documents
- Asset Management Procedure
- Remote Working Policy (A.6.7)
- Secure Disposal and Reuse Procedure (A.7.14)
- Information Backup Policy (A.8.13)
`
  },

  {
    name: 'Removable Storage Media Procedure',
    category: 'procedure',
    description: 'Authorised use of USB drives, external disks, and other removable media (A.7.10).',
    content: `# Removable Storage Media Procedure

${HEADER('A.7.10')}

## 1. Purpose
To control the use of removable storage media so that information confidentiality, integrity, and availability are maintained.

## 2. Scope
All removable storage capable of storing data, including USB flash drives, USB / Thunderbolt disks, SD cards, optical media, tape, smart-card storage, and external SSDs.

## 3. Default posture
Removable media use is **disabled by default** on {{client_name}} workstations. Where business need is justified, the media-control policy issued by IT is adjusted on the specific endpoint via central management.

## 4. Authorised use

### 4.1 Approval
A request to enable removable media for a specific user / endpoint is submitted to the line manager and the ISMS Manager. The request states:
- Business purpose.
- Type of media (read-only, encrypted, manufacturer-provided).
- Information classifications that may be transferred.
- Duration of the exception.

### 4.2 Approved media
Only {{client_name}}-issued, hardware-encrypted removable drives may be used to transfer Confidential or Restricted information. Personal USB drives are prohibited for {{client_name}} information regardless of classification.

### 4.3 Encryption
All removable media containing Internal, Confidential, or Restricted information must be encrypted with a {{client_name}}-approved algorithm and key. Lost / forgotten passphrases follow the standard recovery process.

## 5. Day-to-day handling
- Media in use is kept under the user's direct supervision.
- When not in use, media is locked away (drawer, safe).
- When transferring media to a third party, custody is recorded via courier or in-person handover with signature.
- Media is scanned for malware on insertion via the central EDR.

## 6. Decommissioning
End-of-life media is sanitised per the Secure Disposal and Reuse Procedure (A.7.14):
- Magnetic media: cryptographic erase + degauss + physical destruction.
- SSD / flash: cryptographic erase + manufacturer secure-erase + physical destruction.
- Optical media: shredded.

A certificate of destruction is retained.

## 7. Loss or theft
Lost or stolen media is reported within [4 hours] via the Reporting Information Security Events Procedure. The ISMS Manager assesses whether a notifiable breach has occurred under applicable privacy law.

## 8. Records
The register of issued removable media is maintained by IT and reviewed [quarterly]. The register includes serial number, encryption status, owner, issue date, and current status.

## 9. Related documents
- Information Classification Policy (A.5.12)
- Secure Disposal and Reuse Procedure (A.7.14)
- Acceptable Use Policy (A.5.10)
`
  },

  {
    name: 'Secure Disposal and Reuse Procedure',
    category: 'procedure',
    description: 'Sanitisation of equipment and media before disposal or reuse (A.7.14).',
    content: `# Secure Disposal and Reuse Procedure

${HEADER('A.7.14')}

## 1. Purpose
To ensure that {{client_name}} information cannot be recovered from equipment or media that is disposed of, transferred, or reassigned.

## 2. Scope
All equipment and media that has at any point stored {{client_name}} information at Internal classification or above, including: laptops, desktops, servers, network appliances, mobile devices, removable media, storage arrays, copiers, multi-function devices, decommissioned VMs, and printed material.

## 3. Sanitisation methods

| Media type | Method (in order of preference) |
|------------|--------------------------------|
| HDD (magnetic) | Crypto-erase → multi-pass overwrite (NIST SP 800-88 Clear) → physical shred for high-classification |
| SSD / flash / hybrid | Crypto-erase → manufacturer secure-erase (Purge) → physical shred |
| Tape | Crypto-erase → degauss → physical shred |
| Mobile device | Factory reset under MDM with verified wipe → for high-classification, physical destruction |
| Optical media | Shred / cross-cut |
| Paper | Cross-cut shred (P-4 minimum) → bin in locked confidential-waste container |
| Multi-function device internal disk | Crypto-erase per manufacturer guide before disposal |
| Cloud storage | Confirm provider's written sanitisation guarantee + revoke all access keys |

## 4. Process

### 4.1 Identification
End-of-life equipment is logged in the Asset Register with status "pending_sanitisation".

### 4.2 Sanitisation
Sanitisation is performed by [IT_OPS_TEAM] using approved tooling. Each item is sanitised once and verified. The serial number, method, date, and operator are recorded.

### 4.3 Verification
For Confidential and Restricted equipment, verification is performed by a second person ("dual-control"). Verification includes:
- Sample read attempts on overwritten sectors.
- Confirmation of the manufacturer's secure-erase status flag.
- Visual inspection for shredding.

### 4.4 Certificate of destruction
A certificate is generated for every Confidential or Restricted item, listing serial number, method, operator, witness, and date. Certificates are retained for [7] years.

### 4.5 Third-party disposal
Where sanitisation or destruction is outsourced, the supplier is approved per A.5.19 and provides:
- A signed contract with information security clauses.
- A certificate of destruction per item or per batch.
- Right of audit.

## 5. Reuse
Equipment to be reassigned within {{client_name}}:
- Is sanitised to the same standard as for disposal.
- Is re-imaged from a baseline build (per Configuration Management).
- Is recorded against the new owner in the Asset Register.

## 6. Records
The sanitisation log and certificates are retained for [7] years. The log is reviewed annually by the ISMS Manager.

## 7. Related documents
- Asset Management Procedure
- Information Classification Policy (A.5.12)
- Equipment Security Policy (A.7.8)
`
  }
];
