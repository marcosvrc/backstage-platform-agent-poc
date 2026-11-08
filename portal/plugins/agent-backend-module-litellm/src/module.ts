import { createBackendModule } from '@backstage/backend-plugin-api';
import { agentGatewaysExtensionPoint } from '@internal/backstage-plugin-agent-node';
import { LiteLLMGateway } from './LiteLLMGateway';

/**
 * Conector LiteLLM do Platform Agent. Ativo com `agent.gateway.type: litellm`.
 *
 * @public
 */
export const agentModuleLiteLLM = createBackendModule({
  pluginId: 'agent',
  moduleId: 'litellm',
  register(reg) {
    reg.registerInit({
      deps: { gateways: agentGatewaysExtensionPoint },
      async init({ gateways }) {
        gateways.addGateway('litellm', ({ config }) => {
          const route =
            config.getOptionalString('agent.gateway.route') ?? 'passthrough';
          if (route !== 'passthrough' && route !== 'messages') {
            throw new Error(
              `agent.gateway.route "${route}" inválida. Opções: passthrough, messages`,
            );
          }
          const features = config.getOptionalConfig('agent.gateway.features');
          const teamKeys = config.getOptionalConfig('agent.gateway.teamKeys');
          return new LiteLLMGateway({
            baseUrl: config.getString('agent.gateway.baseUrl'),
            apiKey: config.getString('agent.gateway.apiKey'),
            route,
            model: config.getOptionalString('agent.gateway.model'),
            features: features && {
              serverSideFallback:
                features.getOptionalBoolean('serverSideFallback'),
              effort: features.getOptionalBoolean('effort'),
              eagerToolStreaming:
                features.getOptionalBoolean('eagerToolStreaming'),
              promptCaching: features.getOptionalBoolean('promptCaching'),
            },
            adminKey: config.getOptionalString('agent.gateway.adminKey'),
            teamKeys:
              teamKeys &&
              Object.fromEntries(
                teamKeys.keys().map(team => [team, teamKeys.getString(team)]),
              ),
            tags: config.getOptionalStringArray('agent.gateway.tags'),
            sendMetadata: config.getOptionalBoolean(
              'agent.gateway.sendMetadata',
            ),
          });
        });
      },
    });
  },
});
