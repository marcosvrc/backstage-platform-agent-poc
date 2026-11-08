import { mockCredentials } from '@backstage/backend-test-utils';
import {
  catalogEntityDeletePermission,
  catalogEntityReadPermission,
  catalogLocationDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { PolicyQueryUser } from '@backstage/plugin-permission-node';
import { taskCreatePermission } from '@backstage/plugin-scaffolder-common/alpha';
import { agentGovernanceReadPermission } from '@internal/backstage-plugin-agent-backend';
import { AcmePermissionPolicy, PLATFORM_TEAM, RESTRICTED_LABEL } from './policy';

const userIn = (name: string, group: string): PolicyQueryUser => ({
  credentials: mockCredentials.user(`user:default/${name}`),
  info: {
    userEntityRef: `user:default/${name}`,
    ownershipEntityRefs: [`user:default/${name}`, group],
  },
});

const bruno = userIn('bruno.lima', 'group:default/checkout-team');
const ana = userIn('ana.souza', PLATFORM_TEAM);

describe('AcmePermissionPolicy', () => {
  const policy = new AcmePermissionPolicy();

  it('leitura: entidades restritas só para o dono, as demais para todos', async () => {
    const decision = await policy.handle({ permission: catalogEntityReadPermission }, bruno);
    expect(decision).toEqual({
      result: AuthorizeResult.CONDITIONAL,
      pluginId: 'catalog',
      resourceType: 'catalog-entity',
      conditions: {
        anyOf: [
          {
            not: {
              rule: 'HAS_LABEL',
              resourceType: 'catalog-entity',
              params: { label: RESTRICTED_LABEL, value: 'restricted' },
            },
          },
          {
            rule: 'IS_ENTITY_OWNER',
            resourceType: 'catalog-entity',
            params: { claims: bruno.info.ownershipEntityRefs },
          },
        ],
      },
    });
  });

  it('remover entidade: só o dono', async () => {
    const decision = await policy.handle({ permission: catalogEntityDeletePermission }, bruno);
    expect(decision).toMatchObject({
      result: AuthorizeResult.CONDITIONAL,
      conditions: { rule: 'IS_ENTITY_OWNER' },
    });
  });

  it('remover location: só o time de plataforma', async () => {
    const perm = { permission: catalogLocationDeletePermission };
    expect(await policy.handle(perm, bruno)).toEqual({ result: AuthorizeResult.DENY });
    expect(await policy.handle(perm, ana)).toEqual({ result: AuthorizeResult.ALLOW });
    expect(await policy.handle(perm)).toEqual({ result: AuthorizeResult.DENY });
  });

  it('painel de governança de IA: só o time de plataforma', async () => {
    const perm = { permission: agentGovernanceReadPermission };
    expect(await policy.handle(perm, bruno)).toEqual({ result: AuthorizeResult.DENY });
    expect(await policy.handle(perm, ana)).toEqual({ result: AuthorizeResult.ALLOW });
  });

  it('demais permissões (ex.: criar serviço pelo template) são permitidas', async () => {
    expect(await policy.handle({ permission: taskCreatePermission }, bruno)).toEqual({
      result: AuthorizeResult.ALLOW,
    });
  });
});
