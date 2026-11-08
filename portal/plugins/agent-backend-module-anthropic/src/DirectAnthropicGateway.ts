import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import {
  ALL_FEATURES,
  type CallerContext,
  type GatewayHealth,
  type GatewayRequestExtras,
  type ModelGateway,
} from '@internal/backstage-plugin-agent-node';

/**
 * Chamada direta à API da Anthropic, sem gateway.
 * A chave vem de `agent.anthropicApiKey` ou da variável ANTHROPIC_API_KEY.
 */
export class DirectAnthropicGateway implements ModelGateway {
  readonly type = 'direct';
  #client?: Anthropic;

  constructor(private readonly opts: { apiKey?: string }) {}

  describe() {
    return { type: this.type, displayName: 'Anthropic (direto, sem gateway)' };
  }

  client(): Anthropic {
    return (this.#client ??= new Anthropic(
      this.opts.apiKey ? { apiKey: this.opts.apiKey } : {},
    ));
  }

  model(logicalModel: string): string {
    return logicalModel;
  }

  features() {
    return ALL_FEATURES;
  }

  requestExtras(caller: CallerContext): GatewayRequestExtras {
    // A Anthropic recomenda um identificador opaco (sem dados pessoais).
    const userId = createHash('sha256')
      .update(caller.userRef)
      .digest('hex')
      .slice(0, 32);
    return { body: { metadata: { user_id: userId } } };
  }

  describeError(err: unknown): string | undefined {
    if (err instanceof Anthropic.AuthenticationError) {
      return 'Chave da Anthropic inválida. Verifique ANTHROPIC_API_KEY ou agent.anthropicApiKey.';
    }
    if (
      !(err instanceof Anthropic.APIError) &&
      err instanceof Error &&
      /api key|apiKey|authentication/i.test(err.message)
    ) {
      return 'Chave da API da Anthropic ausente. Defina ANTHROPIC_API_KEY antes de iniciar o portal.';
    }
    return undefined;
  }

  async health(): Promise<GatewayHealth> {
    const hasKey = Boolean(this.opts.apiKey || process.env.ANTHROPIC_API_KEY);
    return hasKey
      ? { ok: true }
      : { ok: false, detail: 'ANTHROPIC_API_KEY não definida' };
  }
}
