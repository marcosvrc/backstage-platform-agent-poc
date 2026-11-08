import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import {
  agentEvalsPublishPermission,
  agentGovernanceReadPermission,
} from '@internal/backstage-plugin-agent-backend';
import {
  catalogEntityDeletePermission,
  catalogEntityReadPermission,
  catalogLocationDeletePermission,
} from '@backstage/plugin-catalog-common/alpha';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';
import {
  AuthorizeResult,
  PolicyDecision,
  isPermission,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';

/** Label que marca entidades com dados sensíveis (ex.: bancos com dados de cartão). */
export const RESTRICTED_LABEL = 'acme.example/data-classification';
export const RESTRICTED_VALUE = 'restricted';
/** Padrão de `organization.platformTeam`. */
export const PLATFORM_TEAM = 'group:default/platform-team';

/**
 * Política da POC (hipótese H3: o agente respeita as permissões do usuário).
 *
 * 1. Entidades com a label `acme.example/data-classification: restricted` só são
 *    visíveis para o time dono.
 * 2. Remover entidades do catálogo: só o time dono.
 * 3. Remover locations (ação `catalog:unregister-entity`): só o time de plataforma.
 * 4. Painel de governança de IA e publicação de evals: só o time de plataforma.
 * 5. O resto é permitido.
 *
 * O agente age com as credenciais do usuário, então essas regras valem igualmente
 * para o portal, para o chat e para o MCP.
 */
export class AcmePermissionPolicy implements PermissionPolicy {
  constructor(private readonly platformTeam: string = PLATFORM_TEAM) {}

  async handle(request: PolicyQuery, user?: PolicyQueryUser): Promise<PolicyDecision> {
    const ownership = user?.info.ownershipEntityRefs ?? [];

    if (isPermission(request.permission, catalogEntityReadPermission)) {
      return createCatalogConditionalDecision(request.permission, {
        anyOf: [
          {
            not: catalogConditions.hasLabel({
              label: RESTRICTED_LABEL,
              value: RESTRICTED_VALUE,
            }),
          },
          catalogConditions.isEntityOwner({ claims: ownership }),
        ],
      });
    }

    if (isPermission(request.permission, catalogEntityDeletePermission)) {
      return createCatalogConditionalDecision(
        request.permission,
        catalogConditions.isEntityOwner({ claims: ownership }),
      );
    }

    if (
      isPermission(request.permission, catalogLocationDeletePermission) ||
      isPermission(request.permission, agentGovernanceReadPermission) ||
      isPermission(request.permission, agentEvalsPublishPermission)
    ) {
      return {
        result: ownership.includes(this.platformTeam) ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
      };
    }

    return { result: AuthorizeResult.ALLOW };
  }
}

export default createBackendModule({
  pluginId: 'permission',
  moduleId: 'acme-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint, config: coreServices.rootConfig },
      async init({ policy, config }) {
        // O time de plataforma vem da config (com SSO, é o grupo correspondente no diretório).
        policy.setPolicy(
          new AcmePermissionPolicy(
            config.getOptionalString('organization.platformTeam') ?? PLATFORM_TEAM,
          ),
        );
      },
    });
  },
});
