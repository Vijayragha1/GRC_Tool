'use strict';
// Shared pieces for the ISO/IEC 42001:2023 template pack.
//
// Each pack file exports an array of templates in the system-template shape
// (name, category, description, content) plus two fields the ISO 27001 pack
// does not carry: `tier` (mandatory | expected | recommended), set explicitly
// rather than inferred from the name, and `requirement_refs`, the ISO 42001
// catalogue ids (ai-clause-6.1.4, ai-annex-a-5-2) a document adopted from the
// template is linked to.
//
// Auto-substituted placeholders: {{client_name}} {{date}} {{firm_name}}
// {{document_owner}} {{approval_authority}} {{review_period}} {{industry}}.
// {{scope}} is deliberately not used: its fallback describes information
// assets, which is wrong for an AI management system. Templates refer to the
// AIMS Scope Statement instead. Bracketed [LIKE THIS] text is for the
// consultant or client to replace.

const STARTER_NOTE = `> **Starting point.** This is a starter template for {{client_name}}'s AI management system (AIMS) under ISO/IEC 42001:2023. Replace every bracketed placeholder, remove what does not apply, and describe what {{client_name}} actually does. Where the template suggests a frequency, threshold or retention period, the standard does not set it: agree the value with the owner before approval. The certification auditor will look for a version number, an approval date and the approver on the final document.\n\n---\n`;

const CONTROL_BLOCK = `**Document Owner:** {{document_owner}}
**Approved by:** {{approval_authority}}
**Version:** [1.0]
**Effective Date:** {{date}}
**Review Period:** {{review_period}}`;

module.exports = { STARTER_NOTE, CONTROL_BLOCK };
