import type Anthropic from '@anthropic-ai/sdk';

/** Quem está fazendo o pedido: usado para atribuir uso e custo no gateway. */
export interface CallerContext {
  /** Ex.: user:default/ana.souza */
  userRef: string;
  /** Times (Groups) do usuário, ex.: ['group:default/platform-team'] */
  teams: string[];
  /** ID do pedido no agente (o mesmo gravado na auditoria). */
  requestId: string;
}

/** Campos extras que o gateway quer em cada chamada ao modelo. */
export interface GatewayRequestExtras {
  /** Mesclado no corpo da Messages API. */
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface GatewayHealth {
  ok: boolean;
  detail?: string;
}

/**
 * Camada entre o agente e o provedor do modelo.
 *
 * O agente sempre fala a Messages API da Anthropic (SDK oficial). Um gateway
 * decide para onde a chamada vai (direto na Anthropic, LiteLLM, outro proxy),
 * com qual credencial, e como cada chamada é atribuída ao usuário e ao time.
 *
 * Para trocar de gateway: implemente esta interface em um arquivo novo e
 * registre-o em `GATEWAY_FACTORIES` (gateway/index.ts). Nada mais muda.
 */
export interface ModelGateway {
  /** Identificador do tipo, ex.: 'direct', 'litellm'. */
  readonly type: string;
  /** Descrição para o painel de governança (sem segredos). */
  describe(): { type: string; displayName: string; baseUrl?: string };
  /** Cliente do SDK já apontado para o destino certo. */
  client(): Anthropic;
  /** Atribuição (usuário, time, tags) para uma chamada. */
  requestExtras(caller: CallerContext): GatewayRequestExtras;
  /** Verificação de saúde para o painel. */
  health(): Promise<GatewayHealth>;
}
