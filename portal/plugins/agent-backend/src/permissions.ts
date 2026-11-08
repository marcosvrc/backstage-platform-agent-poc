import { createPermission } from '@backstage/plugin-permission-common';

/** Ver o painel de governança de IA (uso, custos, auditoria, evals). */
export const agentGovernanceReadPermission = createPermission({
  name: 'agent.governance.read',
  attributes: { action: 'read' },
});

/** Publicar resultados de evals no painel. */
export const agentEvalsPublishPermission = createPermission({
  name: 'agent.evals.publish',
  attributes: { action: 'create' },
});

export const agentPermissions = [agentGovernanceReadPermission, agentEvalsPublishPermission];
