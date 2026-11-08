import { coreServices, createBackendPlugin } from '@backstage/backend-plugin-api';
import { actionsRegistryServiceRef, actionsServiceRef } from '@backstage/backend-plugin-api/alpha';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { notificationService } from '@backstage/plugin-notifications-node';
import { registerPlatformActions } from './actions';
import { buildSystemPrompt } from './agent/prompt';
import { agentGatewaysExtensionPoint } from '@internal/backstage-plugin-agent-node';
import { GatewayRegistry } from './gateway';
import { BudgetService } from './governance/budgets';
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
    // Conectores de modelo (Anthropic, LiteLLM...) chegam por módulos.
    const gateways = new GatewayRegistry();
    env.registerExtensionPoint(agentGatewaysExtensionPoint, gateways);

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
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        notifications: notificationService,
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
        scheduler,
        auth,
        notifications,
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
        const gateway = gateways.create(config, logger);
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

        // Orçamento por time: aplicado pelo gateway, sincronizado e alertado aqui.
        const budgetConfig = config.getOptionalConfig('agent.governance.budgets');
        const overridesConfig = budgetConfig?.getOptionalConfig('teams');
        const budgets = new BudgetService({
          budgets: gateway.budgets,
          settings: {
            enabled: budgetConfig?.getOptionalBoolean('enabled') ?? false,
            monthlyUsd: budgetConfig?.getOptionalNumber('monthlyUsd') ?? 50,
            teams: Object.fromEntries(
              (overridesConfig?.keys() ?? []).map(k => [k, overridesConfig!.getNumber(k)]),
            ),
            thresholds: (budgetConfig?.getOptional<number[]>('thresholds') ?? [0.8, 1]).map(Number),
            notify: budgetConfig?.getOptionalStringArray('notify') ?? [
              config.getOptionalString('organization.platformTeam') ??
                'group:default/platform-team',
            ],
          },
          store,
          catalog,
          auth,
          notifications,
          logger,
        });
        if (budgets.active) {
          await scheduler.scheduleTask({
            id: 'agent-budgets-sync',
            frequency: { minutes: 5 },
            timeout: { minutes: 2 },
            initialDelay: { seconds: 15 },
            fn: () => budgets.sync(),
          });
        } else if (budgetConfig?.getOptionalBoolean('enabled') && !gateway.budgets) {
          logger.warn(
            `agent.governance.budgets está ligado, mas o conector "${gateway.type}" não controla orçamento com a config atual (ex.: no LiteLLM, adminKey ou teamKeys).`,
          );
        }

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
            budgets,
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
