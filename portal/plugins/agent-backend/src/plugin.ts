import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef, actionsServiceRef } from '@backstage/backend-plugin-api/alpha';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { registerPlatformActions } from './actions';
import { buildSystemPrompt } from './agent/prompt';
import { createGateway } from './gateway';
import { GovernanceStore } from './governance/store';
import { agentPermissions } from './permissions';
import { createRouter } from './router';

/**
 * Platform Agent: chat com Claude que usa as ações do Backstage
 * (Actions Registry) em nome do usuário logado.
 *
 * @public
 */
export const agentPlugin = createBackendPlugin({
  pluginId: 'agent',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        userInfo: coreServices.userInfo,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        auditor: coreServices.auditor,
        database: coreServices.database,
        actionsService: actionsServiceRef,
        actionsRegistry: actionsRegistryServiceRef,
        catalog: catalogServiceRef,
        urlReader: coreServices.urlReader,
      },
      async init({
        config,
        logger,
        httpAuth,
        httpRouter,
        userInfo,
        permissions,
        permissionsRegistry,
        auditor,
        database,
        actionsService,
        actionsRegistry,
        catalog,
        urlReader,
      }) {
        // Ações próprias da plataforma (conformidade e TechDocs), expostas também via MCP.
        registerPlatformActions({ actionsRegistry, catalog, urlReader });
        permissionsRegistry.addPermissions(agentPermissions);

        const settings = {
          model: config.getOptionalString('agent.model') ?? 'claude-opus-5-5',
          effort: (config.getOptionalString('agent.effort') ?? 'medium') as
            | 'low'
            | 'medium'
            | 'high'
            | 'xhigh'
            | 'max',
          maxIterations: config.getOptionalNumber('agent.maxIterations') ?? 12,
          systemPrompt: buildSystemPrompt({
            appBaseUrl: config.getString('app.baseUrl'),
            organization: config.getOptionalString('organization.name') ?? 'empresa',
            defaultRepoOwner: config.getOptionalString('agent.defaultRepoOwner'),
          }),
        };
        const gateway = createGateway(config);
        const store = await GovernanceStore.create(database);

        const pricingConfig = config.getOptionalConfig('agent.governance.pricing');
        const pricing = Object.fromEntries(
          (pricingConfig?.keys() ?? []).map(model => {
            const c = pricingConfig!.getConfig(model);
            return [
              model,
              {
                input: c.getOptionalNumber('input'),
                output: c.getOptionalNumber('output'),
                cacheRead: c.getOptionalNumber('cacheRead'),
                cacheWrite: c.getOptionalNumber('cacheWrite'),
              },
            ];
          }),
        );

        httpRouter.use(
          await createRouter({
            httpAuth,
            userInfo,
            permissions,
            auditor,
            actionsService,
            logger,
            settings,
            gateway,
            store,
            governance: {
              storePrompts: config.getOptionalBoolean('agent.governance.storePrompts') ?? false,
              pricing,
            },
          }),
        );
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
        logger.info(
          `Platform Agent pronto (modelo ${settings.model}, effort ${settings.effort}, gateway ${gateway.type})`,
        );
      },
    });
  },
});
