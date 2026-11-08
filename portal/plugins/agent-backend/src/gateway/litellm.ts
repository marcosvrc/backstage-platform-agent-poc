import Anthropic from '@anthropic-ai/sdk';
import { createHmac } from 'node:crypto';
import type {
  CallerContext,
  GatewayBudgets,
  GatewayHealth,
  GatewayRequestExtras,
  ModelGateway,
  TeamBudgetStatus,
} from './types';

export interface LiteLLMGatewayOptions {
  /** URL do proxy, ex.: http://localhost:4000 */
  baseUrl: string;
  /** Virtual key do LiteLLM emitida para o portal (usada quando o pedido não tem time). */
  apiKey: string;
  /**
   * Chave com permissão de administração no LiteLLM. Habilita o orçamento por time:
   * o portal cria um team por Group do catálogo e uma virtual key por team.
   */
  adminKey?: string;
  /** Tags fixas adicionadas a todas as chamadas (ex.: app:backstage-agent). */
  tags?: string[];
  /** Envia `litellm_metadata` (usuário e tags). Desligue se o proxy rejeitar o campo. */
  sendMetadata?: boolean;
  /** Para testes. */
  fetch?: typeof fetch;
}

/** Marca os teams e keys criados pelo portal no LiteLLM. */
const SOURCE = 'backstage';

/**
 * LiteLLM Proxy, rota de pass-through da Anthropic (`/anthropic`).
 *
 * O pass-through repassa a Messages API nativa sem tradução, então o agente
 * mantém os recursos da Anthropic (effort, fallback, cache). O LiteLLM aplica a
 * virtual key (orçamento, limites) e registra o gasto por usuário e por tag.
 *
 * Com `adminKey`, cada time do catálogo vira um team no LiteLLM com orçamento
 * mensal, e o pedido usa a virtual key do time: o LiteLLM bloqueia (HTTP 429,
 * budget_exceeded) quando o time estoura o orçamento.
 */
export class LiteLLMGateway implements ModelGateway {
  readonly type = 'litellm';
  readonly budgets?: GatewayBudgets;
  #client?: Anthropic;
  readonly #baseUrl: string;
  readonly #teamKeys = new Map<string, Promise<string>>();

  constructor(private readonly opts: LiteLLMGatewayOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    if (opts.adminKey) {
      this.budgets = {
        ensureTeam: (teamRef, budget) => this.#ensureTeam(teamRef, budget),
        list: () => this.#listTeams(),
        isBudgetExceeded: isBudgetExceededError,
      };
    }
  }

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
      baseURL: `${this.#baseUrl}/anthropic`,
    }));
  }

  async requestExtras(caller: CallerContext): Promise<GatewayRequestExtras> {
    const billingTeam = caller.billingTeam ?? caller.teams[0];
    const teamName = billingTeam?.replace(/^group:(default\/)?/, '');
    const body: Record<string, unknown> = {
      // Campo nativo da Anthropic, também lido pelo LiteLLM para o gasto por usuário.
      metadata: { user_id: caller.userRef },
    };
    if (this.opts.sendMetadata !== false) {
      body.litellm_metadata = {
        user: caller.userRef,
        tags: [
          ...(this.opts.tags ?? []),
          ...(teamName ? [`team:${teamName}`] : []),
          `request:${caller.requestId}`,
        ],
      };
    }
    // Com orçamento por time, a chamada usa a virtual key do time (o LiteLLM cobra e bloqueia nela).
    if (this.budgets && caller.billingTeam) {
      // O SDK envia a credencial em Authorization: Bearer; o LiteLLM lê esse header primeiro.
      return { body, headers: { Authorization: `Bearer ${await this.#teamKey(caller.billingTeam)}` } };
    }
    return { body };
  }

  async health(): Promise<GatewayHealth> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/health/liveliness`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------- Orçamento por time (API de administração do LiteLLM) ----------

  get #fetch() {
    return this.opts.fetch ?? fetch;
  }

  async #admin(method: 'GET' | 'POST', path: string, body?: unknown) {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.adminKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, json, text };
  }

  async #ensureTeam(teamRef: string, monthlyBudgetUsd: number): Promise<void> {
    const teamId = liteLLMTeamId(teamRef);
    const info = await this.#admin('GET', `/team/info?team_id=${encodeURIComponent(teamId)}`);
    if (info.status === 404) {
      const created = await this.#admin('POST', '/team/new', {
        team_id: teamId,
        team_alias: teamRef,
        max_budget: monthlyBudgetUsd,
        budget_duration: '1mo',
        metadata: { source: SOURCE },
      });
      if (!created.ok) throw adminError('criar o team', teamId, created);
      return;
    }
    if (!info.ok) throw adminError('consultar o team', teamId, info);
    if (info.json?.team_info?.max_budget !== monthlyBudgetUsd) {
      const updated = await this.#admin('POST', '/team/update', {
        team_id: teamId,
        max_budget: monthlyBudgetUsd,
        budget_duration: '1mo',
      });
      if (!updated.ok) throw adminError('atualizar o team', teamId, updated);
    }
  }

  async #listTeams(): Promise<TeamBudgetStatus[]> {
    const res = await this.#admin('GET', '/team/list');
    if (!res.ok || !Array.isArray(res.json)) throw adminError('listar os teams', '*', res);
    return (res.json as any[])
      .filter(t => t.metadata?.source === SOURCE && typeof t.team_alias === 'string')
      .map(t => ({
        teamRef: t.team_alias,
        spendUsd: Number(t.spend ?? 0),
        maxBudgetUsd: typeof t.max_budget === 'number' ? t.max_budget : undefined,
        resetAt: t.budget_reset_at ?? undefined,
      }));
  }

  /**
   * Virtual key do time. O valor é derivado da adminKey (HMAC), então não
   * precisa ser guardado: após reiniciar, o portal chega na mesma key.
   */
  #teamKey(teamRef: string): Promise<string> {
    const teamId = liteLLMTeamId(teamRef);
    let pending = this.#teamKeys.get(teamId);
    if (!pending) {
      pending = this.#ensureTeamKey(teamRef, teamId);
      // Em caso de falha, tenta de novo no próximo pedido.
      pending.catch(() => this.#teamKeys.delete(teamId));
      this.#teamKeys.set(teamId, pending);
    }
    return pending;
  }

  async #ensureTeamKey(teamRef: string, teamId: string): Promise<string> {
    const key = `sk-bs-${createHmac('sha256', this.opts.adminKey!).update(teamId).digest('hex').slice(0, 40)}`;
    const info = await this.#admin('GET', `/key/info?key=${encodeURIComponent(key)}`);
    if (info.ok) return key;
    if (info.status !== 404) throw adminError('consultar a key do team', teamId, info);

    const alias = `backstage-agent:${teamId}`;
    const generate = () =>
      this.#admin('POST', '/key/generate', {
        key,
        key_alias: alias,
        team_id: teamId,
        metadata: { source: SOURCE, team: teamRef },
      });
    let created = await generate();
    if (created.status === 400 && /alias/i.test(created.text)) {
      // Key antiga do mesmo time (ex.: adminKey trocada): substitui.
      await this.#admin('POST', '/key/delete', { key_aliases: [alias] });
      created = await generate();
    }
    if (!created.ok) throw adminError('criar a key do team', teamId, created);
    return key;
  }
}

/** group:default/platform-team -> backstage-platform-team (sem / nem :, que quebram rotas do LiteLLM). */
export function liteLLMTeamId(teamRef: string): string {
  const m = /^(?:group:)?(?:([^/]+)\/)?(.+)$/.exec(teamRef);
  const namespace = m?.[1] && m[1] !== 'default' ? `${m[1]}-` : '';
  return `backstage-${namespace}${m?.[2] ?? teamRef}`.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
}

/** O LiteLLM responde 429 com type budget_exceeded quando o orçamento estoura. */
export function isBudgetExceededError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError) || err.status !== 429) return false;
  const body = err.error as { error?: { type?: string } } | undefined;
  return body?.error?.type === 'budget_exceeded' || /budget has been exceeded|budget_exceeded/i.test(err.message);
}

function adminError(what: string, teamId: string, res: { status: number; text: string }) {
  return new Error(`LiteLLM: falha ao ${what} ${teamId} (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
}
