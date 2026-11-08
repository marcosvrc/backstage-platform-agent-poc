import type { Config } from '@backstage/config';
import { DirectAnthropicGateway } from './direct';
import { LiteLLMGateway } from './litellm';
import type { ModelGateway } from './types';

export type {
  CallerContext,
  GatewayBudgets,
  GatewayHealth,
  GatewayRequestExtras,
  ModelGateway,
  TeamBudgetStatus,
} from './types';

/**
 * Gateways disponíveis. Para adicionar outro (Kong, Portkey, Envoy...),
 * crie a classe implementando ModelGateway e registre aqui.
 */
const GATEWAY_FACTORIES: Record<string, (config: Config) => ModelGateway> = {
  direct: config =>
    new DirectAnthropicGateway({ apiKey: config.getOptionalString('agent.anthropicApiKey') }),
  litellm: config =>
    new LiteLLMGateway({
      baseUrl: config.getString('agent.gateway.baseUrl'),
      apiKey: config.getString('agent.gateway.apiKey'),
      adminKey: config.getOptionalString('agent.gateway.adminKey'),
      tags: config.getOptionalStringArray('agent.gateway.tags'),
      sendMetadata: config.getOptionalBoolean('agent.gateway.sendMetadata'),
    }),
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
