import Anthropic from '@anthropic-ai/sdk';
import { createHmac } from 'node:crypto';
import {
  ALL_FEATURES,
  type CallerContext,
  type GatewayBudgets,
  type GatewayHealth,
  type GatewayRequestExtras,
  type ModelFeatures,
  type ModelGateway,
  type TeamBudgetStatus,
} from '@internal/backstage-plugin-agent-node';

export interface LiteLLMGatewayOptions {
  /** URL do proxy, ex.: http://localhost:4000 */
  baseUrl: string;
  /** Virtual key do LiteLLM emitida para o portal (usada quando o pedido não tem time). */
  apiKey: string;
  /**
   * Rota usada para falar com o modelo:
   * - passthrough (padrão): `/anthropic`, repassa a Messages API para a API da Anthropic.
   * - messages: `/v1/messages`, formato da Anthropic com roteamento pelo model_list do
   *   LiteLLM. Use quando o Claude vem do AWS Bedrock ou do Google Vertex AI.
   */
  route?: 'passthrough' | 'messages';
  /** Nome do modelo no LiteLLM (ex.: claude-opus). Padrão: agent.model. */
  model?: string;
  /** Liga/desliga recursos da Messages API. O padrão depende da rota. */
  features?: Partial<ModelFeatures>;
  /**
   * Orçamento gerenciado pelo portal: chave com permissão de administração no LiteLLM.
   * O portal cria um team por Group do catálogo e uma virtual key por team.
   */
  adminKey?: string;
  /**
   * Orçamento gerenciado pelo LiteLLM: virtual key de cada time, emitida pelos admins
   * do LiteLLM para o team correspondente. Chave: nome do Group (ex.: checkout-team)
   * ou entity ref. O portal usa a key do time na chamada e lê o gasto com ela.
   */
  teamKeys?: Record<string, string>;
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
 * LiteLLM Proxy.
 *
 * Rotas: pass-through da Anthropic (`/anthropic`, sem tradução) ou `/v1/messages`
 * (formato da Anthropic roteado pelo model_list: Bedrock, Vertex AI...). O LiteLLM
 * aplica a virtual key (orçamento, limites) e registra o gasto por usuário e por tag.
 *
 * Orçamento por time (o LiteLLM bloqueia com HTTP 429 budget_exceeded ao estourar):
 * - `adminKey` (managed): cada Group do catálogo vira um team criado pelo portal.
 * - `teamKeys` (external): os teams e orçamentos são dos admins do LiteLLM; o
 *   portal usa a key de cada time e só lê o gasto.
 */
export class LiteLLMGateway implements ModelGateway {
  readonly type = 'litellm';
  readonly budgets?: GatewayBudgets;
  #client?: Anthropic;
  readonly #baseUrl: string;
  readonly #teamKeys = new Map<string, Promise<string>>();

  constructor(private readonly opts: LiteLLMGatewayOptions) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const teamKeys = Object.entries(opts.teamKeys ?? {});
    if (opts.adminKey && teamKeys.length > 0) {
      throw new Error(
        'agent.gateway: use adminKey (o portal cria os teams) ou teamKeys (teams criados pelos admins do LiteLLM), não os dois.',
      );
    }
    if (opts.adminKey) {
      this.budgets = {
        mode: 'managed',
        ensureTeam: (teamRef, budget) => this.#ensureTeam(teamRef, budget),
        list: () => this.#listTeams(),
        isBudgetExceeded: isBudgetExceededError,
      };
    } else if (teamKeys.length > 0) {
      this.budgets = {
        mode: 'external',
        ensureTeam: async () => {},
        list: () => this.#listExternalTeams(),
        isBudgetExceeded: isBudgetExceededError,
      };
    }
  }

  get #route() {
    return this.opts.route ?? 'passthrough';
  }

  describe() {
    return {
      type: this.type,
      displayName:
        this.#route === 'messages'
          ? 'LiteLLM Proxy (/v1/messages, roteado pelo model_list)'
          : 'LiteLLM Proxy (pass-through Anthropic)',
      baseUrl: this.opts.baseUrl,
    };
  }

  client(): Anthropic {
    return (this.#client ??= new Anthropic({
      apiKey: this.opts.apiKey,
      // O SDK acrescenta /v1/messages: na rota messages, a base é o próprio proxy.
      baseURL:
        this.#route === 'messages'
          ? this.#baseUrl
          : `${this.#baseUrl}/anthropic`,
    }));
  }

  model(logicalModel: string): string {
    return this.opts.model ?? logicalModel;
  }

  features(): ModelFeatures {
    // O fallback no servidor é da API da Anthropic; fora do pass-through, fica desligado.
    const defaults =
      this.#route === 'messages'
        ? { ...ALL_FEATURES, serverSideFallback: false }
        : ALL_FEATURES;
    const overrides = Object.entries(this.opts.features ?? {}).filter(
      ([, v]) => v !== undefined,
    );
    return { ...defaults, ...Object.fromEntries(overrides) };
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
    // O SDK envia a credencial em Authorization: Bearer; o LiteLLM lê esse header primeiro.
    if (this.budgets?.mode === 'managed' && caller.billingTeam) {
      return {
        body,
        headers: {
          Authorization: `Bearer ${await this.#teamKey(caller.billingTeam)}`,
        },
      };
    }
    const externalKey =
      caller.billingTeam && this.#externalKey(caller.billingTeam);
    if (externalKey) {
      return { body, headers: { Authorization: `Bearer ${externalKey}` } };
    }
    // Time sem key própria: usa a key do portal (sem orçamento do time, mas com a tag do time).
    return { body };
  }

  describeError(err: unknown): string | undefined {
    if (err instanceof Anthropic.AuthenticationError) {
      return 'O LiteLLM recusou a credencial do portal ou do time. Verifique agent.gateway.apiKey e agent.gateway.teamKeys (ou a adminKey).';
    }
    if (err instanceof Anthropic.NotFoundError && this.#route === 'messages') {
      return `O LiteLLM não encontrou o modelo "${
        this.opts.model ?? 'configurado'
      }". Confira agent.gateway.model com scripts/check-litellm.mjs.`;
    }
    return undefined;
  }

  async health(): Promise<GatewayHealth> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/health/liveliness`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok
        ? { ok: true }
        : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---------- Orçamento por time (API de administração do LiteLLM) ----------

  get #fetch() {
    return this.opts.fetch ?? fetch;
  }

  async #api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    key = this.opts.adminKey,
  ) {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
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
    const info = await this.#api(
      'GET',
      `/team/info?team_id=${encodeURIComponent(teamId)}`,
    );
    if (info.status === 404) {
      const created = await this.#api('POST', '/team/new', {
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
      const updated = await this.#api('POST', '/team/update', {
        team_id: teamId,
        max_budget: monthlyBudgetUsd,
        budget_duration: '1mo',
      });
      if (!updated.ok) throw adminError('atualizar o team', teamId, updated);
    }
  }

  async #listTeams(): Promise<TeamBudgetStatus[]> {
    const res = await this.#api('GET', '/team/list');
    if (!res.ok || !Array.isArray(res.json))
      throw adminError('listar os teams', '*', res);
    return (res.json as any[])
      .filter(
        t => t.metadata?.source === SOURCE && typeof t.team_alias === 'string',
      )
      .map(t => ({
        teamRef: t.team_alias,
        spendUsd: Number(t.spend ?? 0),
        maxBudgetUsd:
          typeof t.max_budget === 'number' ? t.max_budget : undefined,
        resetAt: t.budget_reset_at ?? undefined,
      }));
  }

  /** Key do time no modo external (por entity ref ou pelo nome do Group). */
  #externalKey(teamRef: string): string | undefined {
    const keys = this.opts.teamKeys ?? {};
    return keys[teamRef] ?? keys[teamRef.replace(/^group:(default\/)?/, '')];
  }

  /** Modo external: lê o gasto de cada time com a própria key (não precisa de admin). */
  async #listExternalTeams(): Promise<TeamBudgetStatus[]> {
    return Promise.all(
      Object.entries(this.opts.teamKeys ?? {}).map(async ([team, key]) => {
        const teamRef = team.includes(':') ? team : `group:default/${team}`;
        try {
          const keyInfo = await this.#api('GET', '/key/info', undefined, key);
          if (!keyInfo.ok) throw adminError('ler a key do time', team, keyInfo);
          const info = keyInfo.json?.info ?? {};
          // Orçamento do team (preferido) ou, se não houver, da própria key.
          if (info.team_id) {
            const teamInfo = await this.#api(
              'GET',
              `/team/info?team_id=${encodeURIComponent(info.team_id)}`,
              undefined,
              key,
            );
            const t = teamInfo.json?.team_info;
            if (teamInfo.ok && typeof t?.max_budget === 'number') {
              return {
                teamRef,
                spendUsd: Number(t.spend ?? 0),
                maxBudgetUsd: t.max_budget,
                resetAt: t.budget_reset_at ?? undefined,
              };
            }
          }
          return {
            teamRef,
            spendUsd: Number(info.spend ?? 0),
            maxBudgetUsd:
              typeof info.max_budget === 'number' ? info.max_budget : undefined,
            resetAt: info.budget_reset_at ?? undefined,
          };
        } catch (err) {
          return {
            teamRef,
            spendUsd: 0,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
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
    const key = `sk-bs-${createHmac('sha256', this.opts.adminKey!)
      .update(teamId)
      .digest('hex')
      .slice(0, 40)}`;
    const info = await this.#api(
      'GET',
      `/key/info?key=${encodeURIComponent(key)}`,
    );
    if (info.ok) return key;
    if (info.status !== 404)
      throw adminError('consultar a key do team', teamId, info);

    const alias = `backstage-agent:${teamId}`;
    const generate = () =>
      this.#api('POST', '/key/generate', {
        key,
        key_alias: alias,
        team_id: teamId,
        metadata: { source: SOURCE, team: teamRef },
      });
    let created = await generate();
    if (created.status === 400 && /alias/i.test(created.text)) {
      // Key antiga do mesmo time (ex.: adminKey trocada): substitui.
      await this.#api('POST', '/key/delete', { key_aliases: [alias] });
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
  return `backstage-${namespace}${m?.[2] ?? teamRef}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-');
}

/** O LiteLLM responde 429 com type budget_exceeded quando o orçamento estoura. */
export function isBudgetExceededError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError) || err.status !== 429) return false;
  const body = err.error as { error?: { type?: string } } | undefined;
  return (
    body?.error?.type === 'budget_exceeded' ||
    /budget has been exceeded|budget_exceeded/i.test(err.message)
  );
}

function adminError(
  what: string,
  teamId: string,
  res: { status: number; text: string },
) {
  return new Error(
    `LiteLLM: falha ao ${what} ${teamId} (HTTP ${res.status}): ${res.text.slice(
      0,
      200,
    )}`,
  );
}
