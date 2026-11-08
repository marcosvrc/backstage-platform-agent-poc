import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef, actionsServiceRef } from '@backstage/backend-plugin-api/alpha';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { registerPlatformActions } from './actions';
import { buildSystemPrompt } from './agent/prompt';
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
        actionsService,
        actionsRegistry,
        catalog,
        urlReader,
      }) {
        // Ações próprias da plataforma (conformidade e TechDocs), expostas também via MCP.
        registerPlatformActions({ actionsRegistry, catalog, urlReader });

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

        httpRouter.use(
          await createRouter({
            httpAuth,
            actionsService,
            logger,
            settings,
            anthropicApiKey: config.getOptionalString('agent.anthropicApiKey'),
          }),
        );
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
        logger.info(`Platform Agent pronto (modelo ${settings.model}, effort ${settings.effort})`);
      },
    });
  },
});
