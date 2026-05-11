// Crisis communication templates - content distinct from technical runbooks.
// These are message bodies you send to specific audiences during an incident.

module.exports = [
  {
    name: 'Customer notice - confirmed data breach',
    audience: 'customers',
    channel: 'email',
    body: `Subject: Important security notice regarding your account

Dear {{customer_name}},

We are writing to inform you of a security incident that may have affected information related to your account.

What happened
On {{detected_at}}, we detected {{incident_summary}}. Following our incident response process we contained the incident on {{contained_at}}.

What information was involved
{{data_categories}}

What we are doing
- We have contained the incident and removed the attacker's access.
- We have engaged independent forensic experts to investigate.
- We have notified the relevant supervisory authorities.
- We are providing affected individuals with {{remediation_offer}}.

What you can do
- Change your password (https://{{password_reset_url}})
- Enable multi-factor authentication if you haven't already
- Be alert to suspicious emails referring to this incident

For more information
You can reach our security team at {{contact_email}}. We will publish updates at {{status_page}}.

We are deeply sorry for this and we take our responsibility for your data extremely seriously.

{{ciso_name}}
Chief Information Security Officer
{{company_name}}`
  },
  {
    name: 'Internal staff alert - phishing campaign in progress',
    audience: 'internal',
    channel: 'slack',
    body: `:warning: *Active phishing campaign - please read*

We have detected a coordinated phishing campaign targeting employees today.

*What it looks like*: {{lure_description}}

*If you have clicked or entered credentials*:
1. Do NOT close the tab - screenshot if you can
2. Disconnect the device from network
3. Contact #security-incidents immediately

*If you only received the email*:
- Do not click anything, do not reply
- Use the *Phish Alert* button to report it
- Forward the original to phishing@{{company_domain}}

*What we're doing*: blocking the sender domain at the gateway, resetting affected accounts, monitoring SSO + email logs.

Updates will be posted in this thread.`
  },
  {
    name: 'Regulator notification - GDPR Art. 33',
    audience: 'regulator',
    channel: 'email',
    body: `Subject: Personal data breach notification - {{company_name}}, {{detected_at}}

To: {{dpa_address}}

Pursuant to Article 33 GDPR, we hereby notify you of a personal data breach.

1. Nature of the breach
{{nature_description}}

2. Categories and approximate number of data subjects concerned
{{data_subjects_summary}}

3. Categories and approximate number of personal data records concerned
{{records_summary}}

4. Likely consequences of the breach
{{consequences}}

5. Measures taken or proposed
{{measures}}

6. Contact point
Data Protection Officer: {{dpo_name}} - {{dpo_email}} - {{dpo_phone}}

We will provide further information as soon as it becomes available.

Sincerely,
{{dpo_name}}
DPO, {{company_name}}`
  },
  {
    name: 'Status page - service degradation',
    audience: 'public',
    channel: 'status_page',
    body: `# Investigating - {{service_name}} degradation

*Posted {{posted_at}}*

We are currently investigating reports of {{symptom}} affecting {{affected_scope}}.

We will post the next update within 30 minutes.

---

*Updated {{updated_at}}* - Identified
We have identified the cause as {{root_cause_summary}}. A fix is being deployed; estimated time to resolution: {{eta}}.

---

*Updated {{resolved_at}}* - Resolved
The incident is resolved as of {{resolved_at}}. Total duration: {{duration}}. We will publish a post-incident review within 5 business days at {{pir_url}}.`
  },
  {
    name: 'Executive escalation - critical incident summary',
    audience: 'executives',
    channel: 'email',
    body: `Subject: [CONFIDENTIAL] {{severity}} security incident - exec briefing

To: CEO, CFO, GC, Board liaison

*Incident*: {{title}}
*Severity*: {{severity}}
*Detected*: {{detected_at}}
*Status*: {{status}}

## What we know
{{summary}}

## What we don't know yet
{{open_questions}}

## Business impact
{{business_impact}}

## Regulatory exposure
{{regulatory_exposure}}

## Decisions needed from you
{{decisions_needed}}

## Next update
{{next_update_time}} via {{next_update_channel}}

- {{ciso_name}}, CISO`
  }
];
