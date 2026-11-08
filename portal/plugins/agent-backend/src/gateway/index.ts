import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type {
  AgentGatewaysExtensionPoint,
  ModelGateway,
  ModelGatewayFactory,
} from '@internal/backstage-plugin-agent-node';

export {
  ALL_FEATURES,
  type CallerContext,
  type GatewayBudgets,
  type GatewayHealth,
  type GatewayRequestExtras,
  type ModelFeatures,
  type ModelGateway,
  type TeamBudgetStatus,
} from '@internal/backstage-plugin-agent-node';

/**
 * Gateways registrados pelos módulos de conector (agentGatewaysExtensionPoint).
 * O plugin do agente não conhece nenhuma tecnologia: escolhe pelo `agent.gateway.type`.
 */
export class GatewayRegistry implements AgentGatewaysExtensionPoint {
  readonly #factories = new Map<string, ModelGatewayFactory>();

  addGateway(type: string, factory: ModelGatewayFactory): void {
    if (this.#factories.has(type)) {
      throw new Error(`Gateway "${type}" registrado por mais de um módulo`);
    }
    this.#factories.set(type, factory);
  }

  get types(): string[] {
    return [...this.#factories.keys()].sort();
  }

  create(config: Config, logger: LoggerService): ModelGateway {
    const type = config.getOptionalString('agent.gateway.type') ?? 'direct';
    const factory = this.#factories.get(type);
    if (!factory) {
      const available = this.types.join(', ') || 'nenhum';
      throw new Error(
        `agent.gateway.type "${type}" não tem conector instalado. Registrados: ${available}. ` +
          'Adicione o módulo correspondente no backend (ex.: @internal/backstage-plugin-agent-backend-module-litellm).',
      );
    }
    return factory({ config, logger });
  }
}
