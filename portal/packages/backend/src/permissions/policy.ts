import { createBackendModule } from '@backstage/backend-plugin-api';
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
export const PLATFORM_TEAM = 'group:default/platform-team';

/**
 * Política da POC (hipótese H3: o agente respeita as permissões do usuário).
 *
 * 1. Entidades com a label `acme.example/data-classification: restricted` só são
 *    visíveis para o time dono.
 * 2. Remover entidades do catálogo: só o time dono.
 * 3. Remover locations (ação `catalog:unregister-entity`): só o time de plataforma.
 * 4. O resto é permitido.
 *
 * O agente age com as credenciais do usuário, então essas regras valem igualmente
 * para o portal, para o chat e para o MCP.
 */
export class AcmePermissionPolicy implements PermissionPolicy {
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

    if (isPermission(request.permission, catalogLocationDeletePermission)) {
      return {
        result: ownership.includes(PLATFORM_TEAM) ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
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
      deps: { policy: policyExtensionPoint },
      async init({ policy }) {
        policy.setPolicy(new AcmePermissionPolicy());
      },
    });
  },
});
