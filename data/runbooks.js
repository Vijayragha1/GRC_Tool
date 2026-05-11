module.exports = [
  {
    name: 'Ransomware response',
    category: 'malware',
    trigger_severity: 'critical',
    trigger_category: 'malware',
    steps: [
      { phase: 'detect',     title: 'Confirm ransomware indicators',         desc: 'File extensions changed, ransom note, encryption activity in logs.' },
      { phase: 'contain',    title: 'Isolate affected systems',              desc: 'Disconnect from network. Disable VPN/SSO sessions for affected users.' },
      { phase: 'contain',    title: 'Capture volatile evidence',             desc: 'Memory dump if feasible, suspicious processes, network connections.' },
      { phase: 'contain',    title: 'Preserve immutable backups',            desc: 'Verify last-known-good backup is offline / immutable. DO NOT power-cycle if possible.' },
      { phase: 'eradicate',  title: 'Identify entry vector',                 desc: 'Phishing email, exposed RDP, supply-chain, vulnerability exploit.' },
      { phase: 'eradicate',  title: 'Reimage affected hosts',                desc: 'Do not decrypt - restore from clean backup after verifying backup integrity.' },
      { phase: 'eradicate',  title: 'Rotate all credentials in scope',       desc: 'Service accounts, admin creds, API keys, certs that may have been exposed.' },
      { phase: 'recover',    title: 'Restore from verified clean backup',    desc: 'Stage in isolated network first, then promote.' },
      { phase: 'recover',    title: 'Monitor for re-infection',              desc: 'Heightened EDR alerting for 30 days minimum.' },
      { phase: 'communicate',title: 'Regulator notification (if required)',  desc: 'GDPR Art. 33: 72hrs to supervisory authority. NIS2: 24hr early-warning.' },
      { phase: 'communicate',title: 'Customer / partner notification',       desc: 'Per contractual obligations + GDPR Art. 34 if high risk to individuals.' },
      { phase: 'lessons',    title: 'Post-incident review',                  desc: 'Root cause, control failures, action items. Schedule within 14 days of recovery.' }
    ]
  },
  {
    name: 'Phishing - credentials compromised',
    category: 'phishing',
    trigger_severity: 'high',
    trigger_category: 'phishing',
    steps: [
      { phase: 'detect',    title: 'Confirm phishing report',           desc: 'Inspect headers, payload, victim count.' },
      { phase: 'contain',   title: 'Reset victim passwords + revoke MFA tokens', desc: 'Force re-enrol MFA. Invalidate sessions across SSO providers.' },
      { phase: 'contain',   title: 'Block sender domain at email gateway', desc: 'Quarantine identical messages org-wide.' },
      { phase: 'contain',   title: 'Audit OAuth grants on victim accounts', desc: 'Look for unauthorised app consents.' },
      { phase: 'eradicate', title: 'Search for lateral movement',       desc: 'Audit logins, mail-rule changes, file access from victim accounts.' },
      { phase: 'communicate', title: 'User awareness alert',            desc: 'Targeted reminder to identified recipients; org-wide if widespread.' },
      { phase: 'lessons',   title: 'Update phishing-simulation library', desc: 'Add lure pattern to next training cycle.' }
    ]
  },
  {
    name: 'Data breach - confidentiality',
    category: 'breach',
    trigger_severity: 'high',
    trigger_category: 'data_breach',
    steps: [
      { phase: 'detect',     title: 'Verify scope of data exposed',       desc: 'Categories, subjects affected, time window, attacker capability.' },
      { phase: 'contain',    title: 'Block exfil channel',                desc: 'Revoke API keys, close S3 bucket, restrict tokens, rotate certs.' },
      { phase: 'contain',    title: 'Preserve forensic evidence',         desc: 'Snapshot logs, capture file hashes, freeze affected accounts.' },
      { phase: 'eradicate',  title: 'Patch root cause',                   desc: 'Misconfiguration / vuln / insider threat - correct before re-opening service.' },
      { phase: 'communicate',title: 'GDPR Art. 33 supervisory notice',    desc: 'Within 72 hours of becoming aware. Document delay justification if missed.' },
      { phase: 'communicate',title: 'GDPR Art. 34 data-subject notice',   desc: 'Without undue delay if high risk to rights/freedoms.' },
      { phase: 'communicate',title: 'Customer notice + DPA partners',     desc: 'Per contractual obligations.' },
      { phase: 'recover',    title: 'Service restored with controls',     desc: 'Re-open with mitigations validated.' },
      { phase: 'lessons',    title: 'Update DPIAs and risk register',     desc: 'Reassess inherent risk; add controls.' }
    ]
  },
  {
    name: 'DDoS / availability',
    category: 'availability',
    trigger_severity: 'high',
    trigger_category: 'ddos',
    steps: [
      { phase: 'detect',  title: 'Confirm DDoS vs degradation',  desc: 'Distinguish from legitimate spike, cert expiry, bad deploy.' },
      { phase: 'contain', title: 'Engage upstream scrubbing',    desc: 'CDN / WAF rules tightened, rate limit, geo-blocks.' },
      { phase: 'contain', title: 'Scale capacity if cost-justified', desc: 'Be explicit about EUR/hr threshold before auto-scaling away the attack.' },
      { phase: 'communicate', title: 'Status page update',       desc: 'External-facing comms; commit to next update interval.' },
      { phase: 'recover', title: 'Drop mitigations cleanly',     desc: 'Watch for tail re-attack.' },
      { phase: 'lessons', title: 'Capacity + cost retrospective', desc: 'Was BCP capacity sufficient? Did costs spike beyond budget?' }
    ]
  },
  {
    name: 'Insider threat - suspected',
    category: 'insider',
    trigger_severity: 'high',
    trigger_category: 'insider',
    steps: [
      { phase: 'detect',  title: 'Engage HR + Legal IMMEDIATELY before any action', desc: 'Preserve due process. Do not tip off the suspect.' },
      { phase: 'contain', title: 'Silent monitoring',           desc: 'Heightened logging on subject accounts; no visible changes that would tip them off.' },
      { phase: 'eradicate', title: 'Coordinated revocation',    desc: 'When ready: revoke access simultaneously across all systems.' },
      { phase: 'communicate', title: 'Regulator if data subjects affected', desc: 'GDPR / sectoral requirements may apply.' },
      { phase: 'lessons', title: 'Review separation of duties + DLP coverage', desc: 'Which controls failed to detect / prevent?' }
    ]
  }
];
