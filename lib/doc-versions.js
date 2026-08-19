'use strict';
// Document version + signature helpers, shared by routes/documents.js and the
// audit-pack builder in server.js. Extracted from server.js during slice 12.

const { db } = require('../db');
const enc = require('./encryption');

function snapshotDocVersion(docId, wsId, status, userId, summary) {
  const doc = db.prepare('SELECT * FROM generated_docs WHERE id=? AND workspace_id=?').get(docId, wsId);
  if (!doc) return null;
  const decryptedContent = enc.decryptIfNeeded(doc.content, wsId);
  const hash = enc.sha256(decryptedContent || '');
  const encryptedContent = enc.encryptIfNeeded(decryptedContent, wsId, true);

  const attempt = () => {
    return db.transaction(() => {
      const next = (db.prepare('SELECT MAX(version) AS v FROM doc_versions WHERE document_id=?').get(docId).v || 0) + 1;
      const id = db.prepare(`INSERT INTO doc_versions (workspace_id, document_id, version, name, content, content_hash, status, change_summary, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        wsId, docId, next, doc.name, encryptedContent,
        hash, status || 'draft', summary || null, userId
      ).lastInsertRowid;
      db.prepare(`UPDATE generated_docs SET current_version_id=?, version=? WHERE id=?`).run(id, next, docId);
      return { id, version: next, hash, content: decryptedContent };
    })();
  };

  try { return attempt(); }
  catch (e) {
    if (e && e.code && e.code.startsWith('SQLITE_CONSTRAINT')) {
      // Concurrent snapshot won the version=N slot. Re-read MAX and retry
      // once - almost always succeeds because the colliding transaction has
      // committed by now.
      try { return attempt(); }
      catch (e2) {
        const wrapped = new Error('Could not save document version - another consultant submitted at the same time. Refresh and try again.');
        wrapped.cause = e2; wrapped.code = 'DOC_VERSION_CONFLICT';
        throw wrapped;
      }
    }
    throw e;
  }
}

function listVersions(docId) {
  return db.prepare(`SELECT v.*, u.name AS author
    FROM doc_versions v LEFT JOIN users u ON u.id=v.created_by
    WHERE v.document_id=? ORDER BY v.version DESC`).all(docId);
}

function listApprovers(docId, versionId) {
  return db.prepare(`SELECT a.*, u.name AS user_name, u.email AS user_email
    FROM doc_approvers a INNER JOIN users u ON u.id=a.user_id
    WHERE a.document_id=? AND a.version_id=? ORDER BY a.sequence`).all(docId, versionId);
}

function listSignatures(docId, versionId) {
  return db.prepare(`SELECT s.* FROM doc_signatures s WHERE s.document_id=? AND s.version_id=? ORDER BY s.signed_at`).all(docId, versionId);
}

// Verify the integrity of every signature on a version. Returns a list of issues.
function verifyVersionSignatures(version, sigs, wsId) {
  const issues = [];
  for (const s of sigs) {
    if (s.content_hash !== version.content_hash) {
      issues.push(`Signature ${s.id} (${s.user_name}): content hash mismatch - version may have been altered after signing.`);
      continue;
    }
    const payload = `${s.document_id}|${s.version_id}|${s.user_id}|${s.content_hash}|${s.intent}|${s.signed_at}`;
    if (!enc.verifyHmac(payload, wsId, s.signature)) {
      issues.push(`Signature ${s.id} (${s.user_name}): HMAC verification failed - signature is not authentic.`);
    }
  }
  return issues;
}


module.exports = { snapshotDocVersion, listVersions, listApprovers, listSignatures, verifyVersionSignatures };
