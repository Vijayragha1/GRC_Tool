'use strict';

// Internal evidence-library operations belong to the consulting firm. Client
// accounts upload only through the scoped client-portal request/deliverable
// routes, where assignment and visibility checks are enforced row by row.
function requireInternalEvidenceMutation(req, res, next) {
  if (!req.user || req.user.user_type !== 'firm') {
    return res.status(403).send('Forbidden');
  }
  return next();
}

module.exports = { requireInternalEvidenceMutation };
