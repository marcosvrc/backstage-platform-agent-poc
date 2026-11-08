import {
  createExtensionPoint,
  type LoggerService,
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type { ModelGateway } from './types';

/** Cria o gateway a partir da configuração do portal. */
export type ModelGatewayFactory = (options: {
  config: Config;
  logger: LoggerService;
}) => ModelGateway;

/** Onde os módulos de conector registram seus gateways. */
export interface AgentGatewaysExtensionPoint {
  /**
   * Registra um gateway. `type` é o valor usado em `agent.gateway.type`
   * (ex.: litellm, direct).
   */
  addGateway(type: string, factory: ModelGatewayFactory): void;
}

/**
 * Ponto de extensão do Platform Agent para conectores de modelo.
 *
 * Exemplo de módulo:
 *
 * ```ts
 * export default createBackendModule({
 *   pluginId: 'agent',
 *   moduleId: 'meu-gateway',
 *   register(reg) {
 *     reg.registerInit({
 *       deps: { gateways: agentGatewaysExtensionPoint },
 *       async init({ gateways }) {
 *         gateways.addGateway('meu-gateway', ({ config }) => new MeuGateway(config));
 *       },
 *     });
 *   },
 * });
 * ```
 *
 * @public
 */
export const agentGatewaysExtensionPoint =
  createExtensionPoint<AgentGatewaysExtensionPoint>({
    id: 'agent.gateways',
  });
