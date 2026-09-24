'use strict';
// ISO/IEC 42001:2023 template pack. Four groups, in the order a consultant
// works through an implementation: context and leadership, planning and the
// management-system cycle, the AI system lifecycle, then data, transparency,
// use and third parties. lib/iso42001-templates.js seeds them.

module.exports = [
  ...require('./policy-templates-iso42001-context'),
  ...require('./policy-templates-iso42001-planning'),
  ...require('./policy-templates-iso42001-lifecycle'),
  ...require('./policy-templates-iso42001-operations'),
];
