'use strict';
const { clientWorkPolicy, actorContext } = require('./client-work-policy');
const rbac = require('./rbac');
module.exports = {
  actorContext,
  requestCapabilities: ({db,workspace,actor}) => {
    const context=actorContext(db,workspace,actor);
    const canCreate=context.active && context.firm && rbac.hasPermission(context.permissions,'client_portal.view') && rbac.hasPermission(context.permissions,'client_request.create');
    return {canCreate,context};
  },
  requestPolicy: options => clientWorkPolicy({ ...options, sourceType: 'request' }),
  clientWorkPolicy
};
