// Healthcare sector overlay. Merges into the firm risk library when a
// workspace's `sector` field is set to "Healthcare". The overlay adds risks,
// recommended Annex A control emphasis, and additional mandatory documented
// information specific to PHI / patient-data handling and HIPAA-adjacent
// concerns.
//
// Pattern (so other sectors can follow):
//   data/sector-overlays/<sector>.js exports:
//     - extraRisks       — risk-library entries to append (firm-library shape)
//     - controlEmphasis  — { iso_id: { priority, why } } to surface in SoA
//     - extraMandatoryDocs — additional rows for the "Mandatory documents" check
//     - notes            — short blurb the consultant sees on the workspace
//
// At workspace creation (or when sector changes), the overlay's extraRisks are
// cloned into the firm risk library if not already present, so the firm
// gradually accumulates sector-tailored content rather than starting blank.

const SECTOR = 'Healthcare';

const extraRisks = [
  { domain: 'Patient data', sector: SECTOR,
    title: 'Unauthorised disclosure of PHI via workforce error or device loss',
    description: 'Patient health information is exposed through an unencrypted laptop, lost mobile device, or staff sending records to the wrong recipient.',
    threat: 'Insider error / device theft',
    vulnerability: 'No device encryption; weak DLP; no PHI handling training',
    suggested_likelihood: 4, suggested_impact: 5,
    suggested_treatment: 'Mitigate via full-disk encryption + MDM enrolment of all clinical devices; mandatory PHI handling training; quarterly access reviews on EHR',
    suggested_controls: 'annex-a.5.10,annex-a.6.3,annex-a.7.10,annex-a.8.1,annex-a.8.24',
    tags: 'phi,hipaa,gdpr-art-9' },

  { domain: 'Patient data', sector: SECTOR,
    title: 'Ransomware encrypts EHR or PACS, halting clinical operations',
    description: 'A ransomware payload reaches the electronic health record or imaging archive and encrypts files, blocking clinical access and forcing diversion or paper-based fallback.',
    threat: 'External ransomware operator',
    vulnerability: 'Flat network; no segmentation; tested restore RPO > 24h; no immutable backups',
    suggested_likelihood: 3, suggested_impact: 5,
    suggested_treatment: 'Mitigate via network segmentation between clinical and admin networks; immutable offsite backups; quarterly tabletop exercise covering EHR outage',
    suggested_controls: 'annex-a.5.24,annex-a.5.29,annex-a.8.13,annex-a.8.16,annex-a.8.22',
    tags: 'phi,hipaa,clinical-continuity' },

  { domain: 'Suppliers', sector: SECTOR,
    title: 'Business Associate or processor breach exposes PHI',
    description: 'A third-party billing service, transcription vendor, or cloud EHR provider suffers a breach exposing data they hold on behalf of the organisation.',
    threat: 'External attacker; supplier security failure',
    vulnerability: 'No Business Associate Agreement (BAA); no supplier security review; tier-1 suppliers without SOC 2 / HITRUST attestation',
    suggested_likelihood: 3, suggested_impact: 5,
    suggested_treatment: 'Mitigate via BAA in every PHI-handling supplier contract; pre-onboarding security questionnaire; annual reassessment',
    suggested_controls: 'annex-a.5.19,annex-a.5.20,annex-a.5.22,annex-a.5.23',
    tags: 'phi,hipaa,baa,supplier' },

  { domain: 'Medical devices', sector: SECTOR,
    title: 'Connected medical device runs unpatched legacy OS',
    description: 'A medical device (infusion pump, imaging modality, monitor) connects to the network running an unsupported OS the vendor will not patch.',
    threat: 'External attacker exploits known CVE',
    vulnerability: 'No device inventory; no segmentation of medical IoT; vendor refuses patches',
    suggested_likelihood: 4, suggested_impact: 4,
    suggested_treatment: 'Mitigate via dedicated medical-device VLAN; compensating monitoring; vendor risk-acceptance log signed by clinical lead',
    suggested_controls: 'annex-a.5.9,annex-a.7.8,annex-a.8.8,annex-a.8.20',
    tags: 'iomt,medical-device,segmentation' },

  { domain: 'Compliance', sector: SECTOR,
    title: 'Failure to notify regulator within 60-day breach window (HIPAA)',
    description: 'A reportable breach is not notified to HHS / OCR or affected patients within the legally required window, triggering enforcement action.',
    threat: 'Process failure under pressure',
    vulnerability: 'No documented breach notification runbook; legal/privacy not on incident-response on-call rotation',
    suggested_likelihood: 2, suggested_impact: 5,
    suggested_treatment: 'Mitigate via written breach notification procedure with named legal owner; tabletop including 60-day clock; annual review',
    suggested_controls: 'annex-a.5.24,annex-a.5.25,annex-a.5.26,annex-a.5.34',
    tags: 'hipaa,gdpr,breach-notification' },
];

// Annex A controls that healthcare auditors and HIPAA Security Rule mappers
// scrutinise more heavily than the average SaaS engagement. Surfaced in SoA
// and gap assessment as "sector emphasis" callouts.
const controlEmphasis = {
  'annex-a.5.34': { priority: 'high', why: 'PHI / HIPAA Privacy Rule — privacy notices, patient access rights, minimum-necessary' },
  'annex-a.5.24': { priority: 'high', why: 'Breach notification under HIPAA + GDPR Art. 9 — 60-day window' },
  'annex-a.5.10': { priority: 'high', why: 'Acceptable use of PHI is the most-cited workforce-error finding' },
  'annex-a.6.3':  { priority: 'high', why: 'PHI-handling training is a HIPAA Security Rule requirement' },
  'annex-a.7.10': { priority: 'high', why: 'Storage media — PHI on lost devices is the #1 reportable breach category' },
  'annex-a.8.24': { priority: 'high', why: 'Encryption — HIPAA "addressable" specification but de facto required' },
  'annex-a.5.19': { priority: 'medium', why: 'BAAs in every supplier handling PHI' },
};

const extraMandatoryDocs = [
  { id: 'sector-baa-template', label: 'Business Associate Agreement template (HIPAA §164.504(e))' },
  { id: 'sector-breach-runbook', label: 'Breach notification runbook (HIPAA + GDPR Art. 33-34)' },
  { id: 'sector-phi-handling', label: 'PHI handling and minimum-necessary policy' },
];

const notes =
  'Healthcare overlay is active. Risk library, SoA emphasis, and mandatory ' +
  'documents have been augmented with PHI / HIPAA / connected-medical-device ' +
  'specifics. Auditors usually triangulate ISO 27001 with HIPAA Security Rule ' +
  'and (in the EU) GDPR Article 9 — make sure the BAA, breach runbook, and ' +
  'PHI handling policy are present.';

module.exports = {
  sector: SECTOR,
  extraRisks,
  controlEmphasis,
  extraMandatoryDocs,
  notes,
};
