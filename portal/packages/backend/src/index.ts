/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// See https://backstage.io/docs/backend-system/building-backends/migrating#the-auth-plugin
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
// See https://backstage.io/docs/auth/guest/provider
// SSO corporativo (Keycloak) via OIDC. Configurado em app-config.keycloak.yaml.
backend.add(import('@backstage/plugin-auth-backend-module-oidc-provider'));

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));
// Catálogo real: catalog-info.yaml dos repositórios da organização (catalog.providers.github).
// Sem config, não faz nada.
backend.add(import('@backstage/plugin-catalog-backend-module-github'));
// Usuários e times vindos do Keycloak (catalog.providers.keycloakOrg). Sem config, não faz nada.
backend.add(
  import('@backstage-community/plugin-catalog-backend-module-keycloak'),
);

// permission plugin
backend.add(import('@backstage/plugin-permission-backend'));
// Política da POC: dados restritos só para o time dono, remoções controladas (H3).
backend.add(import('./permissions/policy'));

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin
backend.add(import('@backstage/plugin-kubernetes-backend'));

// user settings plugin
backend.add(import('@backstage/plugin-user-settings-backend'));

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// mcp actions plugin
backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.add(import('@internal/backstage-plugin-agent-backend'));
// Conectores de modelo do agente (agent.gateway.type escolhe qual usar).
backend.add(import('@internal/backstage-plugin-agent-backend-module-anthropic'));
backend.add(import('@internal/backstage-plugin-agent-backend-module-litellm'));
backend.start();
