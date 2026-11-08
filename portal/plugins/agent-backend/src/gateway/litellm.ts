import Anthropic from '@anthropic-ai/sdk';
import type { CallerContext, GatewayHealth, GatewayRequestExtras, ModelGateway } from './types';

export interface LiteLLMGatewayOptions {
  /** URL do proxy, ex.: http://localhost:4000 */
  baseUrl: string;
  /** Virtual key do LiteLLM emitida para o portal. */
  apiKey: string;
  /** Tags fixas adicionadas a todas as chamadas (ex.: app:backstage-agent). */
  tags?: string[];
  /** Envia `litellm_metadata` (usuário e tags). Desligue se o proxy rejeitar o campo. */
  sendMetadata?: boolean;
}

/**
 * LiteLLM Proxy, rota de pass-through da Anthropic (`/anthropic`).
 *
 * O pass-through repassa a Messages API nativa sem tradução, então o agente
 * mantém os recursos da Anthropic (effort, fallback, cache). O LiteLLM aplica a
 * virtual key (orçamento, limites) e registra o gasto por usuário e por tag.
 */
export class LiteLLMGateway implements ModelGateway {
  readonly type = 'litellm';
  #client?: Anthropic;

  constructor(private readonly opts: LiteLLMGatewayOptions) {}

  describe() {
    return {
      type: this.type,
      displayName: 'LiteLLM Proxy (pass-through Anthropic)',
      baseUrl: this.opts.baseUrl,
    };
  }

  client(): Anthropic {
    return (this.#client ??= new Anthropic({
      apiKey: this.opts.apiKey,
      baseURL: `${this.opts.baseUrl.replace(/\/+$/, '')}/anthropic`,
    }));
  }

  requestExtras(caller: CallerContext): GatewayRequestExtras {
    const team = caller.teams[0]?.replace(/^group:(default\/)?/, '');
    const body: Record<string, unknown> = {
      // Campo nativo da Anthropic, também lido pelo LiteLLM para o gasto por usuário.
      metadata: { user_id: caller.userRef },
    };
    if (this.opts.sendMetadata !== false) {
      body.litellm_metadata = {
        user: caller.userRef,
        tags: [
          ...(this.opts.tags ?? []),
          ...(team ? [`team:${team}`] : []),
          `request:${caller.requestId}`,
        ],
      };
    }
    return { body };
  }

  async health(): Promise<GatewayHealth> {
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}/health/liveliness`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
