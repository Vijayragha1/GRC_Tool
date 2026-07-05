'use strict';
// Firm risk library seeding: ships the curated starter set into a firm's own
// library on first visit. Used by routes/risks.js (clone flows) and the firm
// library pages.

const { db } = require('../db');

function seedFirmRiskLibraryIfEmpty(firmId) {
  const c = db.prepare('SELECT COUNT(*) c FROM firm_risk_library WHERE firm_id=?').get(firmId).c;
  if (c > 0) return 0;
  const SHIPPED = require('../data/risk-library');
  const ins = db.prepare(`INSERT INTO firm_risk_library
    (firm_id, title, description, threat, vulnerability, suggested_likelihood, suggested_impact, suggested_controls, domain)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const r of SHIPPED) {
      ins.run(firmId, r.title, r.description || null, r.threat || null, r.vulnerability || null,
        3, 3, (r.suggested_controls || []).join(','), r.domain || null);
    }
  });
  tx();
  return SHIPPED.length;
}

module.exports = { seedFirmRiskLibraryIfEmpty };
