import { createBackendModule } from '@backstage/backend-plugin-api';
import { agentGatewaysExtensionPoint } from '@internal/backstage-plugin-agent-node';
import { DirectAnthropicGateway } from './DirectAnthropicGateway';

/**
 * Conector direto para a API da Anthropic. Ativo com `agent.gateway.type: direct` (padrão).
 *
 * @public
 */
export const agentModuleAnthropic = createBackendModule({
  pluginId: 'agent',
  moduleId: 'anthropic',
  register(reg) {
    reg.registerInit({
      deps: { gateways: agentGatewaysExtensionPoint },
      async init({ gateways }) {
        gateways.addGateway(
          'direct',
          ({ config }) =>
            new DirectAnthropicGateway({
              apiKey: config.getOptionalString('agent.anthropicApiKey'),
            }),
        );
      },
    });
  },
});
