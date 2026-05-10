// Client intake / scoping questionnaire. The 25-question structure mirrors
// what Schellman, Tego, and the Advisera intake templates ask before Stage 1.
// Auditors expect the answers in clause 4.3 (scope), 4.1 (context), and 4.2
// (interested parties) — which is why each question is tagged with the clause
// it feeds.
//
// Sections are ordered the way you'd run a kickoff workshop: business
// context first, then scope, then organisation, then critical assets,
// then existing posture. A junior consultant can run the workshop by
// reading the questions out loud.

const SECTIONS = [
  {
    id: 'business-context',
    title: 'Business context',
    blurb: 'Who you are, what you do, why ISO 27001 matters now. Anchors clauses 4.1 and 4.2.',
    questions: [
      { id: 'org-name', text: 'Legal entity name (the certificate will read this exactly)', clause: '4.3', type: 'text', required: true },
      { id: 'trading-name', text: 'Trading or product name(s) — different from legal entity?', clause: '4.3', type: 'text' },
      { id: 'business-summary', text: 'In two sentences, what does your organisation do?', clause: '4.1', type: 'textarea', required: true },
      { id: 'cert-driver', text: 'What\'s driving certification? (customer contract, tender, regulator, internal mandate)', clause: '4.1', type: 'textarea', required: true,
        hint: 'Auditors ask this to gauge management commitment. "A customer required it by Q4" is a real answer.' },
      { id: 'cert-deadline', text: 'Hard deadline (if any) for the certificate?', clause: '4.1', type: 'date' },
    ]
  },
  {
    id: 'scope',
    title: 'ISMS scope',
    blurb: 'Products, services, locations, and systems in scope. This becomes clause 4.3 verbatim.',
    questions: [
      { id: 'products-in-scope', text: 'Which products / services are in scope?', clause: '4.3', type: 'textarea', required: true,
        hint: 'List by product name. Auditors will trace evidence back to these.' },
      { id: 'products-excluded', text: 'Anything explicitly NOT in scope (and why)?', clause: '4.3', type: 'textarea',
        hint: 'Exclusions need justification — "internal HR systems, no customer data" is fine, "we just don\'t want to" is not.' },
      { id: 'physical-locations', text: 'Physical locations in scope (offices, data centres, manufacturing)', clause: '4.3', type: 'textarea',
        hint: 'Include addresses if known.' },
      { id: 'remote-workers', text: 'How many employees work remotely / hybrid?', clause: '4.3', type: 'text',
        hint: 'Affects whether home-office is "in scope" for physical security.' },
      { id: 'cloud-providers', text: 'Cloud providers and services in scope (AWS, Azure, GCP, M365, Google Workspace, etc.)', clause: '4.3', type: 'textarea', required: true },
      { id: 'data-types', text: 'What types of data are processed? (PII, PCI, PHI, IP, internal, public)', clause: '4.3', type: 'textarea', required: true },
      { id: 'customer-geography', text: 'Where are your customers based? (UK, EU, US, APAC...)', clause: '4.3', type: 'textarea',
        hint: 'Drives applicable regulations — UK GDPR, GDPR, CCPA, PIPEDA, etc.' },
    ]
  },
  {
    id: 'organisation',
    title: 'Organisation',
    blurb: 'Headcount, structure, and the people who will own the ISMS.',
    questions: [
      { id: 'headcount-total', text: 'Total employees + contractors (in scope)', clause: '4.3', type: 'number', required: true },
      { id: 'isms-owner', text: 'ISMS owner (top-management sponsor, e.g., CISO, CTO, COO)', clause: '5.1', type: 'text', required: true,
        hint: 'Auditors interview this person. They must be able to talk about the ISMS without notes.' },
      { id: 'isms-coordinator', text: 'Day-to-day ISMS coordinator (the person doing the work)', clause: '5.3', type: 'text', required: true },
      { id: 'isac-frequency', text: 'How often does the ISMS steering / committee meet?', clause: '9.3', type: 'text',
        hint: 'Quarterly is the floor for most certifiers.' },
    ]
  },
  {
    id: 'interested-parties',
    title: 'Interested parties',
    blurb: 'Who can affect or be affected by the ISMS? Feeds clause 4.2 register directly.',
    questions: [
      { id: 'key-customers', text: 'Top 3-5 customers who care about your security posture (and what they ask for)', clause: '4.2', type: 'textarea', required: true,
        hint: 'Their security questionnaires + DPAs become evidence.' },
      { id: 'key-regulators', text: 'Regulators / supervisory authorities relevant to your business', clause: '4.2', type: 'textarea',
        hint: 'ICO (UK), supervisory authorities under GDPR, FCA, FDA, PCI SSC, etc.' },
      { id: 'key-suppliers', text: 'Critical suppliers / processors you depend on', clause: '4.2', type: 'textarea', required: true,
        hint: 'Anyone whose outage breaks your service or whose breach exposes your data.' },
    ]
  },
  {
    id: 'crown-jewels',
    title: 'Crown jewels',
    blurb: 'The 3-5 information assets that, if compromised, end the business. Drives the asset register and risk treatment.',
    questions: [
      { id: 'crown-jewel-1', text: 'Crown jewel #1 — the single most-sensitive information asset', clause: 'A.5.9', type: 'textarea', required: true },
      { id: 'crown-jewel-2', text: 'Crown jewel #2', clause: 'A.5.9', type: 'textarea' },
      { id: 'crown-jewel-3', text: 'Crown jewel #3', clause: 'A.5.9', type: 'textarea' },
    ]
  },
  {
    id: 'existing-posture',
    title: 'Existing posture',
    blurb: 'What\'s already in place. Saves time identifying real gaps vs paper gaps.',
    questions: [
      { id: 'existing-frameworks', text: 'Other frameworks or certifications you already hold or are pursuing (SOC 2, NIST CSF, Cyber Essentials Plus, HIPAA, PCI...)', clause: '4.1', type: 'textarea',
        hint: 'Existing controls map across — saves remediation effort.' },
      { id: 'existing-policies', text: 'Approximately how many security / privacy policies are already documented and signed off?', clause: '7.5', type: 'text' },
      { id: 'recent-incidents', text: 'Any security incidents or near-misses in the last 24 months we should know about?', clause: 'A.5.24', type: 'textarea',
        hint: 'Withholding hurts you — auditors find them anyway via the breach register.' },
    ]
  },
];

// Flat list of question objects with section id attached, for storage + query.
function flatten() {
  const out = [];
  for (const sec of SECTIONS) {
    for (const q of sec.questions) {
      out.push({ ...q, section_id: sec.id });
    }
  }
  return out;
}

// Build the clause 4.3 scope statement from the answered intake. The format
// follows the BSI / Schellman convention: organisation, products, locations,
// data types, exclusions. Falls back to "[answer needed]" placeholders so
// the consultant can see what's missing.
function draftScopeStatement(answers) {
  const a = (id) => (answers[id] || '').trim();
  const placeholder = (id) => a(id) || `[${id} — not answered]`;
  const lines = [];
  lines.push(`The information security management system covers the operations of ${placeholder('org-name')}.`);
  lines.push('');
  lines.push(`In scope: ${placeholder('products-in-scope')}.`);
  if (a('physical-locations')) {
    lines.push('');
    lines.push(`Physical locations: ${a('physical-locations')}.`);
  }
  if (a('cloud-providers')) {
    lines.push('');
    lines.push(`Cloud providers and services in scope: ${a('cloud-providers')}.`);
  }
  if (a('data-types')) {
    lines.push('');
    lines.push(`Data processed: ${a('data-types')}.`);
  }
  if (a('headcount-total')) {
    lines.push('');
    lines.push(`Total in-scope headcount: ${a('headcount-total')}.`);
  }
  if (a('products-excluded')) {
    lines.push('');
    lines.push(`Out of scope: ${a('products-excluded')}.`);
  }
  return lines.join('\n');
}

module.exports = { SECTIONS, flatten, draftScopeStatement };
