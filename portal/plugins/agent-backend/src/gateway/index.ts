import type { Config } from '@backstage/config';
import { DirectAnthropicGateway } from './direct';
import { LiteLLMGateway } from './litellm';
import type { ModelGateway } from './types';

export type {
  CallerContext,
  GatewayBudgets,
  GatewayHealth,
  GatewayRequestExtras,
  ModelFeatures,
  ModelGateway,
  TeamBudgetStatus,
} from './types';
export { ALL_FEATURES } from './types';

/**
 * Gateways disponíveis. Para adicionar outro (Kong, Portkey, Envoy...),
 * crie a classe implementando ModelGateway e registre aqui.
 */
const GATEWAY_FACTORIES: Record<string, (config: Config) => ModelGateway> = {
  direct: config =>
    new DirectAnthropicGateway({ apiKey: config.getOptionalString('agent.anthropicApiKey') }),
  litellm: config => {
    const route = config.getOptionalString('agent.gateway.route') ?? 'passthrough';
    if (route !== 'passthrough' && route !== 'messages') {
      throw new Error(`agent.gateway.route "${route}" inválida. Opções: passthrough, messages`);
    }
    const features = config.getOptionalConfig('agent.gateway.features');
    const teamKeys = config.getOptionalConfig('agent.gateway.teamKeys');
    return new LiteLLMGateway({
      baseUrl: config.getString('agent.gateway.baseUrl'),
      apiKey: config.getString('agent.gateway.apiKey'),
      route,
      model: config.getOptionalString('agent.gateway.model'),
      features: features && {
        serverSideFallback: features.getOptionalBoolean('serverSideFallback'),
        effort: features.getOptionalBoolean('effort'),
        eagerToolStreaming: features.getOptionalBoolean('eagerToolStreaming'),
        promptCaching: features.getOptionalBoolean('promptCaching'),
      },
      adminKey: config.getOptionalString('agent.gateway.adminKey'),
      teamKeys:
        teamKeys &&
        Object.fromEntries(teamKeys.keys().map(team => [team, teamKeys.getString(team)])),
      tags: config.getOptionalStringArray('agent.gateway.tags'),
      sendMetadata: config.getOptionalBoolean('agent.gateway.sendMetadata'),
    });
  },
};

export function createGateway(config: Config): ModelGateway {
  const type = config.getOptionalString('agent.gateway.type') ?? 'direct';
  const factory = GATEWAY_FACTORIES[type];
  if (!factory) {
    throw new Error(
      `agent.gateway.type "${type}" desconhecido. Opções: ${Object.keys(GATEWAY_FACTORIES).join(', ')}`,
    );
  }
  return factory(config);
}
