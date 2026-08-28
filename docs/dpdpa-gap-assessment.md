# DPDP Gap Assessment — Digital Personal Data Protection Act, 2023 + DPDP Rules, 2025

A current-state gap assessment against India's **Digital Personal Data Protection Act, 2023**
(Act No. 22 of 2023, assented 11 August 2023) read together with the **Digital Personal Data
Protection Rules, 2025** (G.S.R. 846(E), notified 13 November 2025).

Every requirement below is drawn **verbatim from the statutory text** — a section of the Act or a
rule/schedule of the Rules. Nothing is assumed. Where the Act says "*as may be prescribed*", the
corresponding DPDP Rules 2025 provision now supplies the detail, and that rule is cited. Where a
value is still left to a future Central Government notification (e.g. who is a Significant Data
Fiduciary), the item is marked **conditional** rather than guessed.

---

## How to use this document

1. Complete **Section 0 — Applicability screening** first. It determines whether the Act applies to
   you at all, and your role (Data Fiduciary / Data Processor / Consent Manager). Items in later
   sections are gated on these answers.
2. For each control, answer the **current-state diagnostic question** with documented facts, set the
   **Status**, and record **Findings / gap**, **Evidence reviewed**, and **Remediation (owner, target
   date)**.
3. Conditional sections (**§6 Significant Data Fiduciary**, **§2 Consent Manager**) apply only if the
   screening flags them — leave them `Not Applicable` otherwise, with the reason.
4. Roll the results up using **Section 9 — Scoring summary**.

### Status legend (matches the tool's gap-assessment vocabulary)

| Status | Meaning |
|---|---|
| `Implemented` | Requirement fully met; evidence on file. |
| `Partially Implemented` | Some elements in place; documented gaps remain. |
| `Work In Progress` | Remediation underway, not yet complete. |
| `Not Implemented` | Requirement not met. |
| `Not Applicable` | Requirement does not apply — **record the statutory reason**. |
| `Not Assessed` | Not yet reviewed (default). |

### A note on commencement — this is a readiness runway, not a live-enforcement checklist (Rules, rule 1)

The Rules commence in phases from the 13 November 2025 publication date:

- **On publication (13 Nov 2025):** rules 1, 2 and 17–21 (Board constitution, appeals machinery).
- **One year after (~13 Nov 2026):** rule 4 (Consent Manager registration & obligations).
- **Eighteen months after (~13 May 2027):** rules 3, 5–16, 22 and 23 — i.e. **notice, security
  safeguards, breach intimation, retention/erasure, DPO contact, children's data, Significant Data
  Fiduciary obligations, Data Principal rights and cross-border transfer**.

Treat the ~18-month horizon as the date the operational obligations below become enforceable, and use
this assessment to close gaps ahead of it. (Source: DPDP Rules 2025, rule 1(2)–(4).)

---

## Section 0 — Applicability & scope screening
*(Basis: Act §§2, 3, 4, 17. Screening only — not scored.)*

| ID | Statutory basis | Question to resolve | Determination |
|---|---|---|---|
| AP-1 | §3(a) | Do you process **digital personal data** collected in digital form (or non-digital then digitised) **within India**? | |
| AP-2 | §3(b) | Do you process digital personal data **outside India** in connection with **offering goods or services to Data Principals in India**? (If yes to AP-1 or AP-2, the Act applies.) | |
| AP-3 | §3(c)(i) | Is any processing purely by an individual for **personal or domestic** purposes? (Excluded.) | |
| AP-4 | §3(c)(ii) | Is any data **made publicly available** by the Data Principal herself, or by a person under a legal obligation to publish it? (Excluded.) | |
| AP-5 | §2(i), §2(k) | For each processing activity, are you the **Data Fiduciary** (determine purpose & means), a **Data Processor** (process on another's behalf), or both? | |
| AP-6 | §4(1) | Is every processing activity for a **lawful purpose** (not expressly forbidden by law) and grounded in **either consent (§6) or a certain legitimate use (§7)**? Maintain a processing inventory mapping each activity to its ground. | |
| AP-7 | §17 | Does any processing fall under a **§17 exemption** (legal claims; courts/regulatory bodies; offence prevention/investigation; processing of non-India principals under a foreign contract; M&A/insolvency; loan-default financial assessment; State instrumentalities notified under §17(2)(a); research/archiving/statistical per Rules Second Schedule)? Scope these out **with the specific clause recorded**. | |
| AP-8 | §17(3) | Are you a **startup** or other class notified by the Central Government as exempt from §5, §8(3), §8(7), §10 and §11? (Conditional on notification.) | |

> Record the resulting **scope statement** (which entities, systems, processing activities and roles
> are in scope) before proceeding.

---

## Section 1 — Notice
*(Basis: Act §5; Rules rule 3.)*

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| N-1 | §5(1) | Every consent request is **accompanied or preceded by a notice** stating (i) the personal data and the purpose of processing, (ii) how to exercise rights under §6(4) and §13, and (iii) how to complain to the Board. | Is a compliant notice presented at or before every point consent is collected? | Not Assessed | | | |
| N-2 | rule 3(a) | The notice is **understandable independently** of any other information the Data Fiduciary makes available. | Is the notice a standalone, self-contained document (not buried in a longer T&C)? | Not Assessed | | | |
| N-3 | rule 3(b) | In clear, plain language the notice gives, **at minimum**, (i) an **itemised description** of the personal data, and (ii) the **specified purpose(s)** plus a specific description of the goods/services/uses enabled. | Does each notice itemise the exact data fields and tie them to specific purposes? | Not Assessed | | | |
| N-4 | rule 3(c) | The notice gives the **communication link** (website/app) and other means by which the principal may **withdraw consent** (ease comparable to giving it), **exercise her rights**, and **complain to the Board**. | Are working links/means for withdrawal, rights and Board complaints present in every notice? | Not Assessed | | | |
| N-5 | §5(2) | For consent **obtained before commencement**, a notice (data + purpose processed; how to exercise rights under §6(4)/§13; how to complain to the Board) is given **as soon as reasonably practicable**; processing may continue until consent is withdrawn. | Has a back-notice been issued (or planned) for all pre-existing consented data? | Not Assessed | | | |
| N-6 | §5(3) | The principal can **access the notice in English or any language in the Eighth Schedule** to the Constitution. | Is the notice available in English and the relevant Eighth-Schedule language(s)? | Not Assessed | | | |

---

## Section 2 — Consent (and Consent Manager)
*(Basis: Act §6; Rules rule 3, rule 4, First Schedule.)*

### 2A. Consent quality and lifecycle

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| C-1 | §6(1) | Consent is **free, specific, informed, unconditional and unambiguous**, given by a **clear affirmative action**, and **limited to the personal data necessary** for the specified purpose. | Is consent captured by affirmative action, unbundled, and limited to necessary data (no pre-ticked boxes, no bundling unnecessary data)? | Not Assessed | | | |
| C-2 | §6(2) | Any part of consent that **infringes the Act/Rules or other law is invalid** to that extent. | Are consent texts reviewed so no clause waives statutory rights (e.g. right to complain)? | Not Assessed | | | |
| C-3 | §6(3) | Consent requests are in **clear and plain language**, with a language option (English / Eighth Schedule), and include the **contact details of the DPO** (where applicable) or other authorised person for rights queries. | Do consent requests carry plain-language text, language choice, and a contact for rights queries? | Not Assessed | | | |
| C-4 | §6(4)–(5) | The principal can **withdraw consent at any time**, with **ease comparable to giving it**; withdrawal consequences are borne by the principal and do not affect the legality of prior processing. | Is there a withdrawal mechanism as easy as the opt-in? | Not Assessed | | | |
| C-5 | §6(6) | On withdrawal, the Data Fiduciary **ceases — and causes its processors to cease — processing within a reasonable time**, unless otherwise required/authorised by law. | On withdrawal, does processing (yours and your processors') actually stop within a reasonable time? | Not Assessed | | | |
| C-6 | §6(7) | The principal may **give/manage/review/withdraw consent through a Consent Manager**. | Is consent-via-Consent-Manager supported (or a documented decision not to, pending the ecosystem)? | Not Assessed | | | |
| C-7 | §6(10) | The Data Fiduciary must be able to **prove**, in a proceeding, that **notice was given and valid consent obtained**. | Are immutable, auditable consent + notice records retained per data subject and purpose? | Not Assessed | | | |

### 2B. Consent Manager obligations — **conditional: only if you are registering/acting as a Consent Manager**
*(Basis: Act §6(8)–(9); Rules rule 4 + First Schedule. Rule 4 commences ~13 Nov 2026.)*

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| CM-1 | §6(9); rule 4(1); 1st Sch. Part A | **Registered with the Board**; applicant is a **company incorporated in India** with **net worth ≥ ₹2 crore**, sound finances/management, and **independent certification** of an interoperable, standards-compliant consent platform. | Do you meet and evidence every Part A registration condition? | Not Assessed | | | |
| CM-2 | 1st Sch. Part B(2) | The consent/sharing mechanism is such that **contents are not readable** by the Consent Manager. | Is the platform architected so the CM cannot read the data it routes? | Not Assessed | | | |
| CM-3 | 1st Sch. Part B(3)–(4) | Maintain a **record of consents given/denied/withdrawn, notices, and sharing**; give the principal access and machine-readable copies; **retain ≥ 7 years**. | Are consent records kept, accessible, and retained for at least seven years? | Not Assessed | | | |
| CM-4 | 1st Sch. Part B(6)–(10) | **No sub-contracting**; act in a **fiduciary capacity**; **avoid conflicts of interest** with Data Fiduciaries (directors/KMP/ownership). | Are no-subcontracting and conflict-of-interest controls in place? | Not Assessed | | | |
| CM-5 | 1st Sch. Part B(7),(11),(12),(13) | Take **reasonable security safeguards**; **publish ownership/management transparency** info; maintain **audit mechanisms** reporting to the Board; **no change of control** without Board approval. | Are safeguards, transparency disclosures, audits and control-change approvals operating? | Not Assessed | | | |

---

## Section 3 — Lawful processing without consent: certain legitimate uses
*(Basis: Act §7; Rules rule 5 + Second Schedule for State uses.)*

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| LU-1 | §7(a) | For data the principal **voluntarily provided** for a specified purpose and has not objected to: process only for that purpose, and **cease when she indicates she no longer wants it**. | Where you rely on voluntary provision, is the purpose documented and an objection/stop path honoured? | Not Assessed | | | |
| LU-2 | §7(b); rule 5 + 2nd Sch. | **State subsidy/benefit/service/certificate/licence/permit** processing follows the **Second Schedule standards** (lawful, purpose-limited, accurate, secured, intimation + contact + rights link given). | If relying on §7(b), are the Second-Schedule standards met? | Not Assessed | | | |
| LU-3 | §7(c)–(e) | Processing for **State legal functions / sovereignty & security**, **legal disclosure obligations**, or **court judgments/orders** is confined to those grounds. | Are any of these grounds relied on, and documented per activity? | Not Assessed | | | |
| LU-4 | §7(f)–(h) | Processing for **medical emergency**, **epidemic/public-health measures**, or **disaster/breakdown of public order** is confined to those grounds. | Are emergency/public-health/disaster grounds relied on, and scoped? | Not Assessed | | | |
| LU-5 | §7(i) | **Employment-purpose** processing (or to safeguard the employer from loss/liability — e.g. trade-secret/IP confidentiality, services/benefits to an employee) is confined to that ground. | For employee data, is the §7(i) basis recorded and limited to employment purposes? | Not Assessed | | | |

> Every activity not on consent **must** map to a specific §7 clause. Record the clause per activity in
> the processing inventory (links back to AP-6).

---

## Section 4 — General obligations of a Data Fiduciary
*(Basis: Act §8; Rules rules 6, 7, 8, 9 + Third & Seventh Schedules.)*

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| DF-1 | §8(1) | The Data Fiduciary is **responsible for compliance for all processing by it or by a Data Processor on its behalf**, irrespective of any contrary agreement or the principal's failure of duties. | Is accountability for processor processing owned and evidenced (not contracted away)? | Not Assessed | | | |
| DF-2 | §8(2); rule 6(1)(f) | A Data Processor is engaged **only under a valid contract**, which **requires reasonable security safeguards**. | Is there a valid, safeguards-bearing contract with every processor? | Not Assessed | | | |
| DF-3 | §8(3) | Where data is used to **make a decision affecting the principal** or **disclosed to another Data Fiduciary**, ensure its **completeness, accuracy and consistency**. | Are accuracy controls applied before decisions/disclosures? | Not Assessed | | | |
| DF-4 | §8(4) | Implement **appropriate technical and organisational measures** to ensure effective observance of the Act/Rules. | Are TOMs designed, documented and operating across the data lifecycle? | Not Assessed | | | |
| DF-5 | §8(5); rule 6(1)(a)–(g) | Take **reasonable security safeguards** to prevent breach, including **at minimum**: (a) **encryption/obfuscation/masking/tokenisation**; (b) **access control** to computer resources; (c) **logging, monitoring and review** for unauthorised-access detection; (d) **backups** for continued processing; (e) **retain logs and personal data for 1 year** to enable detection/investigation; (f) **safeguards clauses in processor contracts**; (g) supporting **technical & organisational measures**. | Are all seven Rule-6 minimum safeguards in place and evidenced (incl. ≥1-year log retention)? | Not Assessed | | | |
| DF-6 | §8(6); rule 7(1) | On becoming aware of a breach, **intimate each affected Data Principal without delay** via her user account/registered channel, stating: nature/extent/timing, likely consequences to her, mitigation measures, safety steps she can take, and a contact. | Is there a tested process to notify affected principals without delay with all five content elements? | Not Assessed | | | |
| DF-7 | §8(6); rule 7(2) | Intimate the **Board without delay** (nature, extent, timing, location, likely impact) **and within 72 hours** (or a longer Board-allowed period) give: updated description, facts/circumstances/reasons, mitigation, findings on who caused it, recurrence-prevention measures, and a report on principal-intimations. | Is there a 72-hour Board-notification playbook with all six follow-up elements? | Not Assessed | | | |
| DF-8 | §8(7)(a) | **Erase personal data** on consent withdrawal, or when it is reasonable to assume the **specified purpose is no longer served** — whichever is earlier — unless retention is required by law. | Are deletion triggers (withdrawal / purpose-end) implemented with a legal-hold exception? | Not Assessed | | | |
| DF-9 | §8(7)(b) | **Cause your Data Processor to erase** any personal data you made available to it. | Do processor contracts/runbooks force downstream erasure on the same triggers? | Not Assessed | | | |
| DF-10 | §8(8); rule 8(1)–(2) + 3rd Sch. | Apply the **"no-longer-served" time period** for erasure. For the notified classes (e-commerce ≥2 cr users; online gaming ≥50 lakh users; social media ≥2 cr users) the period is **3 years** from the principal's last engagement (or Rules' commencement, whichever later). **Notify the principal ≥48 hours** before erasure. | If in a Third-Schedule class, is the 3-year clock + 48-hour pre-erasure notice implemented? (Else record N/A.) | Not Assessed | | | |
| DF-11 | rule 8(3) + 7th Sch. | **Retain personal data, traffic data and logs for ≥ 1 year** for the Seventh-Schedule purposes, then erase, unless another law requires longer. | Is the ≥1-year retention-then-erase rule applied to data/traffic/logs? | Not Assessed | | | |
| DF-12 | §8(9); rule 9 | **Prominently publish on website/app**, and **state in every rights-response**, the **business contact** of the DPO (if applicable) or a person who can answer the principal's processing questions. | Is the answerable-person contact published prominently and echoed in every rights response? | Not Assessed | | | |
| DF-13 | §8(10); rule 14(3) | Establish an **effective grievance-redressal mechanism**; **publish** it; respond within the **published period (not exceeding 90 days)** and maintain TOMs ensuring effectiveness. | Is a published grievance mechanism live with a defined SLA ≤90 days and effectiveness controls? | Not Assessed | | | |

---

## Section 5 — Children and persons with disability
*(Basis: Act §9; Rules rules 10, 11, 12 + Fourth Schedule.)*

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| CD-1 | §9(1); rule 10 | Before processing a **child's** (under-18) data, obtain **verifiable parental consent**: adopt TOMs and **due diligence** that the self-identified parent is an **identifiable adult** — via reliable details already held, voluntarily provided identity/age, a virtual token from an authorised entity, or a DigiLocker provider. | Is a verifiable-parental-consent + adult-verification flow implemented for child data? | Not Assessed | | | |
| CD-2 | §9(1); rule 11 | For a **person with disability with a lawful guardian**, obtain **verifiable guardian consent**, with **due diligence** that the guardian was appointed by a court / designated authority / local-level committee under the applicable guardianship law. | Is guardian-appointment verification implemented for this population? | Not Assessed | | | |
| CD-3 | §9(2) | Do **not** undertake processing **likely to cause a detrimental effect on a child's well-being**. | Is there a safeguard/assessment preventing detrimental-effect processing of children? | Not Assessed | | | |
| CD-4 | §9(3) | Do **not** undertake **tracking, behavioural monitoring of children, or targeted advertising directed at children**. | Are child tracking / behavioural monitoring / targeted ads disabled? | Not Assessed | | | |
| CD-5 | §9(4)–(5); rule 12 + 4th Sch. | Reliance on an **exemption** from §9(1)/(3) is confined to a notified **class** (e.g. clinical/mental-health/healthcare, educational institutions, crèches/child-care, school transport) or **purpose** (Part B), **within the stated conditions**. | If exempt processing is relied on, is the exact Fourth-Schedule class/purpose + condition documented? | Not Assessed | | | |

---

## Section 6 — Additional obligations of a Significant Data Fiduciary
*(Basis: Act §10; Rules rule 13. **Conditional — applies only if notified by the Central Government as an SDF** under §10(1).)*

> Screening (§10(1)): the Central Government notifies SDFs on factors including volume & sensitivity of
> data, risk to principals' rights, sovereignty/integrity, electoral democracy, State security and
> public order. **If you have not been notified, set this whole section to `Not Applicable`** and record
> that. If notified:

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| SDF-1 | §10(2)(a) | Appoint a **Data Protection Officer** who **represents the SDF**, is **based in India**, is **responsible to the Board of Directors/governing body**, and is the **point of contact for grievance redressal**. | Is a qualifying India-based DPO appointed and answerable to the board? | Not Assessed | | | |
| SDF-2 | §10(2)(b) | Appoint an **independent data auditor** to evaluate compliance with the Act. | Is an independent data auditor engaged? | Not Assessed | | | |
| SDF-3 | §10(2)(c); rule 13(1)–(2) | Undertake a **Data Protection Impact Assessment and audit once every 12 months**, and **furnish a report of significant observations to the Board**. | Is the annual DPIA + audit performed and the Board report filed? | Not Assessed | | | |
| SDF-4 | rule 13(3) | Exercise **due diligence** that **algorithmic software** used for hosting/display/upload/processing is **not likely to pose a risk to principals' rights**. | Is algorithmic-software risk due-diligence performed and documented? | Not Assessed | | | |
| SDF-5 | rule 13(4) | Ensure **personal data and traffic data specified by the Central Government are not transferred outside India** (data localisation of the specified categories). | Is localisation enforced for any Government-specified data categories? | Not Assessed | | | |

---

## Section 7 — Enabling the rights of Data Principals
*(Basis: Act §§11–14; Rules rule 14. These are Data-Fiduciary obligations to make the rights exercisable.)*

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| DP-1 | §11; rule 14(1)–(2) | On request, provide a **summary of the personal data processed and the processing activities**, the **identities of all fiduciaries/processors with whom it was shared** plus a description of that data, and any other prescribed information. **Publish the request means/identifiers.** | Can you fulfil an access request with all three elements, and are the request means published? | Not Assessed | | | |
| DP-2 | §12(1)–(2) | On request, **correct, complete and update** inaccurate/incomplete personal data. | Is there a working correction/completion/update workflow? | Not Assessed | | | |
| DP-3 | §12(3) | On an **erasure request**, erase the data **unless retention is necessary** for the specified purpose or by law. | Is an erasure workflow live with the lawful-retention exception? | Not Assessed | | | |
| DP-4 | §13; rule 14(3) | Provide **readily available grievance redressal**, **respond within the published period (≤90 days)**; the principal must exhaust this before approaching the Board. | Is the grievance channel readily available with a published ≤90-day response SLA? (Cross-refs DF-13.) | Not Assessed | | | |
| DP-5 | §14; rule 14(4) | Enable the principal to **nominate** one or more individuals to exercise her rights on death/incapacity. | Is a nomination facility provided per your terms of service? | Not Assessed | | | |

---

## Section 8 — Cross-border transfer
*(Basis: Act §16; Rules rule 15.)*

| ID | Statutory basis | Requirement | Current-state diagnostic question | Status | Findings / gap | Evidence reviewed | Remediation (owner, date) |
|---|---|---|---|---|---|---|---|
| CB-1 | §16(1) | Do **not transfer** personal data to any **country/territory the Central Government restricts by notification**. | Do transfer controls honour the Government's restricted-territory list (and stay current with it)? | Not Assessed | | | |
| CB-2 | §16(2) | Where **another Indian law imposes a higher protection / greater transfer restriction** (e.g. sectoral RBI/SEBI rules), the stricter rule prevails. | Are sector-specific stricter transfer rules layered on top of DPDP? | Not Assessed | | | |
| CB-3 | rule 15 | Meet any **requirements the Central Government specifies** for making personal data available to a **foreign State or its controlled entities/agencies**. | Are any such Government-specified requirements identified and met? | Not Assessed | | | |

---

## Section 9 — Scoring summary

| Domain | Items | Implemented | Partially | WIP | Not Implemented | Not Applicable | Not Assessed |
|---|---|---|---|---|---|---|---|
| 0. Applicability (screening) | 8 | — | — | — | — | — | — |
| 1. Notice | 6 | | | | | | |
| 2A. Consent | 7 | | | | | | |
| 2B. Consent Manager *(cond.)* | 5 | | | | | | |
| 3. Legitimate uses | 5 | | | | | | |
| 4. Data Fiduciary obligations | 13 | | | | | | |
| 5. Children / disability | 5 | | | | | | |
| 6. Significant Data Fiduciary *(cond.)* | 5 | | | | | | |
| 7. Data Principal rights | 5 | | | | | | |
| 8. Cross-border transfer | 3 | | | | | | |
| **Total (scored)** | **54** | | | | | | |

---

## Appendix A — Penalty exposure (for risk prioritisation)
*(Basis: Act, the Schedule [see §33(1)]. Informational — helps rank the gaps above by consequence.)*

| Breach | Maximum penalty |
|---|---|
| Failure to take reasonable security safeguards — §8(5) | up to **₹250 crore** |
| Failure to give breach intimation to Board / affected principals — §8(6) | up to **₹200 crore** |
| Breach of children's-data obligations — §9 | up to **₹200 crore** |
| Breach of Significant Data Fiduciary obligations — §10 | up to **₹150 crore** |
| Breach of Data Principal duties — §15 | up to **₹10,000** |
| Breach of any other provision of the Act/Rules | up to **₹50 crore** |

Penalty amount is set by the Board having regard to the nature/gravity/duration of the breach, the
data affected, repetition, gain/loss, mitigation, proportionality and impact (§33(2)).

---

## Appendix B — Data Principal duties (awareness)
*(Basis: Act §15. These bind the Data Principal, not the Fiduciary — reflected here so terms of service
and grievance handling can reference them.)*

A Data Principal shall: (a) comply with applicable laws when exercising her rights; (b) **not impersonate**
another person; (c) **not suppress material information** in any State-issued document/identifier/proof;
(d) **not register a false or frivolous grievance/complaint**; and (e) furnish **only verifiably authentic
information** when seeking correction or erasure.

---

## Sources

- **The Digital Personal Data Protection Act, 2023** (No. 22 of 2023), The Gazette of India,
  Extraordinary, Part II — Section 1, 11 August 2023. *(Provided by the user; verbatim text used for all
  §-cited requirements.)*
- **The Digital Personal Data Protection Rules, 2025**, G.S.R. 846(E), Ministry of Electronics and
  Information Technology, The Gazette of India, Extraordinary, Part II — Section 3(i), 13 November 2025.
  *(Provided by the user; verbatim text used for all rule/Schedule-cited detail.)*

*Prepared as a current-state gap-assessment worksheet. Every control traces to a cited statutory
provision; no thresholds, timelines or obligations have been inferred beyond the text of the Act and the
Rules. Items dependent on a future Central Government notification (Significant Data Fiduciary status,
restricted-territory list, startup/class exemptions) are marked conditional.*
