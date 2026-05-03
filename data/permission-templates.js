module.exports = [
  {
    name: 'PCI auditor (read-only + audit log)',
    description: 'External PCI assessor: can read everything, see activity log, but cannot edit.',
    permissions: [
      'entity.view','control.view','risk.view','asset.view','document.view',
      'audit_log.view','audit_log.export','workspace.export'
    ]
  },
  {
    name: 'Privacy officer / DPO',
    description: 'Data protection officer: view + manage privacy-related areas (DPIAs, supplier DPAs, incidents involving PII).',
    permissions: [
      'entity.view','entity.create','entity.update',
      'control.view','control.update',
      'risk.view','risk.create','risk.update',
      'asset.view','asset.update',
      'document.view','document.create','document.edit','document.submit_review','document.review','document.sign',
      'incident.manage','supplier.manage','training.manage',
      'audit_log.view','audit_log.export','comment.create','evidence.upload'
    ]
  },
  {
    name: 'Backup approver (temporary)',
    description: 'Pair with an expiry date for documents while primary approver is OOO.',
    permissions: [
      'document.view','document.review','document.approve','document.sign','comment.create'
    ]
  },
  {
    name: 'Internal auditor',
    description: 'Conducts internal audits: views everything, manages audit programme + findings, no edits to controls/policies.',
    permissions: [
      'entity.view','control.view','risk.view','asset.view','document.view',
      'audit.manage','nc.manage','task.manage','comment.create',
      'audit_log.view','audit_log.export','evidence.upload'
    ]
  },
  {
    name: 'Risk manager',
    description: 'Owns the risk register and methodology. Read access elsewhere.',
    permissions: [
      'entity.view','control.view',
      'risk.view','risk.create','risk.update','risk.delete','risk.methodology',
      'asset.view','document.view',
      'audit_log.view','comment.create'
    ]
  },
  {
    name: 'Asset / CMDB owner',
    description: 'Maintains the asset inventory; cannot touch risks or policies.',
    permissions: [
      'entity.view','asset.view','asset.create','asset.update','asset.delete',
      'control.view','document.view','comment.create','evidence.upload'
    ]
  }
];
