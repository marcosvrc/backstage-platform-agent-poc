import { DatabaseService, resolvePackagePath } from '@backstage/backend-plugin-api';
import type { Knex } from 'knex';
import type { AgentUsage, RunSummary, ToolCallRecord } from '../agent/runAgent';

const MIGRATIONS_DIR = resolvePackagePath(
  '@internal/backstage-plugin-agent-backend',
  'migrations',
);

/** Limite de linhas lidas por consulta do painel (volume de POC). */
const MAX_ROWS = 50_000;

export interface RequestRecord {
  id: string;
  userRef: string;
  teams: string[];
  kind: 'message' | 'resume';
  model: string;
  gateway: string;
  status: RunSummary['status'] | 'error' | 'aborted' | 'budget_exceeded';
  error?: string;
  latencyMs: number;
  usage: AgentUsage;
  toolCalls: ToolCallRecord[];
  promptPreview?: string;
}

export interface EvalRunRecord {
  userRef: string;
  model: string;
  gateway: string;
  total: number;
  passed: number;
  invalid: number;
  byHypothesis: Record<string, { pass: number; total: number }>;
  usage: Partial<AgentUsage>;
  latencyP50Ms?: number;
  latencyP90Ms?: number;
  createdAt?: string;
}

type Totals = AgentUsage & { requests: number; errors: number };

const emptyTotals = (): Totals => ({
  requests: 0,
  errors: 0,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export class GovernanceStore {
  private constructor(private readonly db: Knex) {}

  static async create(database: DatabaseService): Promise<GovernanceStore> {
    const db = await database.getClient();
    if (!database.migrations?.skip) {
      await db.migrate.latest({ directory: MIGRATIONS_DIR });
    }
    return new GovernanceStore(db);
  }

  async recordRequest(r: RequestRecord): Promise<void> {
    await this.db.transaction(async tx => {
      await tx('agent_requests').insert({
        id: r.id,
        user_ref: r.userRef,
        teams: JSON.stringify(r.teams),
        kind: r.kind,
        model: r.model,
        gateway: r.gateway,
        status: r.status,
        error: r.error ?? null,
        latency_ms: r.latencyMs,
        model_calls: r.usage.modelCalls,
        input_tokens: r.usage.inputTokens,
        output_tokens: r.usage.outputTokens,
        cache_read_tokens: r.usage.cacheReadTokens,
        cache_write_tokens: r.usage.cacheWriteTokens,
        prompt_preview: r.promptPreview ?? null,
      });
      if (r.toolCalls.length > 0) {
        await tx('agent_tool_calls').insert(
          r.toolCalls.map(t => ({
            request_id: r.id,
            tool_use_id: t.toolUseId,
            action_id: t.actionId,
            read_only: t.readOnly,
            approval: t.approval,
            status: t.status,
            error: t.error ?? null,
            latency_ms: t.latencyMs ?? null,
          })),
        );
      }
    });
  }

  async recordEvalRun(r: EvalRunRecord): Promise<void> {
    await this.db('agent_eval_runs').insert({
      user_ref: r.userRef,
      model: r.model,
      gateway: r.gateway,
      total: r.total,
      passed: r.passed,
      invalid: r.invalid,
      by_hypothesis: JSON.stringify(r.byHypothesis),
      usage: JSON.stringify(r.usage),
      latency_p50_ms: r.latencyP50Ms ?? null,
      latency_p90_ms: r.latencyP90Ms ?? null,
      ...(r.createdAt ? { created_at: new Date(r.createdAt) } : {}),
    });
  }

  /** Visão geral do período. Agregado em memória para funcionar igual no Postgres e no SQLite. */
  async overview(days: number) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await this.db('agent_requests')
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(MAX_ROWS);
    const tools = await this.db('agent_tool_calls')
      .where('created_at', '>=', since)
      .limit(MAX_ROWS);

    const totals = emptyTotals();
    const byDay = new Map<string, Totals>();
    const byTeam = new Map<string, Totals & { users: Set<string> }>();
    const byUser = new Map<string, Totals>();
    const byModel = new Map<string, Totals>();
    const byStatus: Record<string, number> = {};
    const users = new Set<string>();
    const latencies: number[] = [];

    for (const row of rows) {
      const add = (t: Totals) => {
        t.requests++;
        if (row.status === 'error') t.errors++;
        t.modelCalls += row.model_calls;
        t.inputTokens += row.input_tokens;
        t.outputTokens += row.output_tokens;
        t.cacheReadTokens += row.cache_read_tokens;
        t.cacheWriteTokens += row.cache_write_tokens;
      };
      add(totals);
      const day = new Date(row.created_at).toISOString().slice(0, 10);
      add(getOr(byDay, day, emptyTotals));
      add(getOr(byUser, row.user_ref, emptyTotals));
      add(getOr(byModel, row.model, emptyTotals));
      const teams: string[] = safeJson(row.teams, []);
      for (const team of teams.length ? teams : ['(sem time)']) {
        const t = getOr(byTeam, team, () => ({ ...emptyTotals(), users: new Set<string>() }));
        add(t);
        t.users.add(row.user_ref);
      }
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      users.add(row.user_ref);
      latencies.push(row.latency_ms);
    }

    const byAction = new Map<string, { calls: number; errors: number; readOnly: boolean }>();
    const approvals = { approved: 0, rejected: 0, pending: 0 };
    for (const t of tools) {
      const a = getOr(byAction, t.action_id, () => ({
        calls: 0,
        errors: 0,
        readOnly: Boolean(t.read_only),
      }));
      if (t.status !== 'not_executed') a.calls++;
      if (t.status === 'error') a.errors++;
      if (t.approval in approvals) approvals[t.approval as keyof typeof approvals]++;
    }

    latencies.sort((a, b) => a - b);
    const pct = (p: number) =>
      latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null;

    return {
      days,
      totals: { ...totals, users: users.size },
      latency: { p50Ms: pct(0.5), p90Ms: pct(0.9) },
      byStatus,
      approvals,
      byDay: fillDays(byDay, days),
      byTeam: [...byTeam.entries()]
        .map(([team, t]) => ({ team, ...t, users: t.users.size }))
        .sort((a, b) => b.requests - a.requests),
      byUser: [...byUser.entries()]
        .map(([userRef, t]) => ({ userRef, ...t }))
        .sort((a, b) => b.requests - a.requests)
        .slice(0, 20),
      byModel: [...byModel.entries()].map(([model, t]) => ({ model, ...t })),
      byAction: [...byAction.entries()]
        .map(([actionId, a]) => ({ actionId, ...a }))
        .sort((a, b) => b.calls - a.calls),
    };
  }

  /** Pedidos recentes com as ações executadas (trilha de auditoria). */
  async audit(opts: { limit: number; userRef?: string; onlyWrites?: boolean }) {
    let query = this.db('agent_requests').orderBy('created_at', 'desc').limit(opts.limit);
    if (opts.userRef) query = query.where('user_ref', opts.userRef);
    if (opts.onlyWrites) {
      query = query.whereIn(
        'id',
        this.db('agent_tool_calls').select('request_id').where('read_only', false),
      );
    }
    const requests = await query;
    const tools = requests.length
      ? await this.db('agent_tool_calls')
          .whereIn(
            'request_id',
            requests.map(r => r.id),
          )
          .orderBy('id')
      : [];
    return requests.map(r => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      userRef: r.user_ref,
      teams: safeJson<string[]>(r.teams, []),
      kind: r.kind,
      model: r.model,
      gateway: r.gateway,
      status: r.status,
      error: r.error ?? undefined,
      latencyMs: r.latency_ms,
      outputTokens: r.output_tokens,
      inputTokens: r.input_tokens + r.cache_read_tokens + r.cache_write_tokens,
      promptPreview: r.prompt_preview ?? undefined,
      toolCalls: tools
        .filter(t => t.request_id === r.id)
        .map(t => ({
          actionId: t.action_id,
          readOnly: Boolean(t.read_only),
          approval: t.approval,
          status: t.status,
          error: t.error ?? undefined,
          latencyMs: t.latency_ms ?? undefined,
        })),
    }));
  }

  /** Registra um alerta de orçamento. Retorna false se ele já tinha sido enviado. */
  async recordBudgetAlert(a: {
    teamRef: string;
    period: string;
    threshold: number;
    spendUsd: number;
    maxBudgetUsd: number;
  }): Promise<boolean> {
    const existing = await this.db('agent_budget_alerts')
      .where({ team_ref: a.teamRef, period: a.period, threshold: a.threshold })
      .first();
    if (existing) return false;
    await this.db('agent_budget_alerts')
      .insert({
        team_ref: a.teamRef,
        period: a.period,
        threshold: a.threshold,
        spend_usd: a.spendUsd,
        max_budget_usd: a.maxBudgetUsd,
      })
      .onConflict(['team_ref', 'period', 'threshold'])
      .ignore();
    return true;
  }

  async budgetAlerts(limit = 100) {
    const rows = await this.db('agent_budget_alerts').orderBy('created_at', 'desc').limit(limit);
    return rows.map(r => ({
      createdAt: new Date(r.created_at).toISOString(),
      teamRef: r.team_ref as string,
      period: r.period as string,
      threshold: Number(r.threshold),
      spendUsd: Number(r.spend_usd),
      maxBudgetUsd: Number(r.max_budget_usd),
    }));
  }

  async evalRuns(limit: number) {
    const rows = await this.db('agent_eval_runs').orderBy('created_at', 'desc').limit(limit);
    return rows.map(r => ({
      id: r.id,
      createdAt: new Date(r.created_at).toISOString(),
      userRef: r.user_ref,
      model: r.model,
      gateway: r.gateway,
      total: r.total,
      passed: r.passed,
      invalid: r.invalid,
      byHypothesis: safeJson(r.by_hypothesis, {}),
      usage: safeJson(r.usage, {}),
      latencyP50Ms: r.latency_p50_ms ?? undefined,
      latencyP90Ms: r.latency_p90_ms ?? undefined,
    }));
  }
}

function getOr<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (!v) map.set(key, (v = init()));
  return v;
}

function safeJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Série diária completa (dias sem uso aparecem com zero). */
function fillDays(byDay: Map<string, Totals>, days: number) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    out.push({ day, ...(byDay.get(day) ?? emptyTotals()) });
  }
  return out;
}
