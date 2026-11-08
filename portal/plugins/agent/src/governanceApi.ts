import type { DiscoveryApi, FetchApi } from '@backstage/frontend-plugin-api';

export interface Totals {
  requests: number;
  errors: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface Overview {
  days: number;
  totals: Totals & { users: number };
  latency: { p50Ms: number | null; p90Ms: number | null };
  byStatus: Record<string, number>;
  approvals: { approved: number; rejected: number; pending: number };
  byDay: Array<Totals & { day: string }>;
  byTeam: Array<Totals & { team: string; users: number }>;
  byUser: Array<Totals & { userRef: string }>;
  byModel: Array<Totals & { model: string }>;
  byAction: Array<{ actionId: string; calls: number; errors: number; readOnly: boolean }>;
}

export interface AuditItem {
  id: string;
  createdAt: string;
  userRef: string;
  teams: string[];
  kind: 'message' | 'resume';
  model: string;
  gateway: string;
  status: string;
  error?: string;
  latencyMs: number;
  outputTokens: number;
  inputTokens: number;
  promptPreview?: string;
  toolCalls: Array<{
    actionId: string;
    readOnly: boolean;
    approval: 'auto' | 'approved' | 'rejected' | 'pending';
    status: 'ok' | 'error' | 'not_executed';
    error?: string;
    latencyMs?: number;
  }>;
}

export type Pricing = Record<
  string,
  { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
>;

export interface Policy {
  model: { id: string; effort: string; maxIterations: number };
  gateway: {
    type: string;
    displayName: string;
    baseUrl?: string;
    health: { ok: boolean; detail?: string };
  };
  storePrompts: boolean;
  pricing: Pricing;
  actions: Array<{
    id: string;
    title: string;
    pluginId: string;
    readOnly: boolean;
    destructive: boolean;
    requiresApproval: boolean;
  }>;
}

export interface EvalRun {
  id: number;
  createdAt: string;
  userRef: string;
  model: string;
  gateway: string;
  total: number;
  passed: number;
  invalid: number;
  byHypothesis: Record<string, { pass: number; total: number }>;
  usage: Record<string, number>;
  latencyP50Ms?: number;
  latencyP90Ms?: number;
}

export interface Budgets {
  /** O gateway atual controla orçamento? */
  supported: boolean;
  enabled: boolean;
  monthlyUsd: number;
  overrides: Record<string, number>;
  thresholds: number[];
  notify: string[];
  /** Gasto do período atual, lido do gateway. */
  teams: Array<{
    teamRef: string;
    spendUsd: number;
    maxBudgetUsd?: number;
    resetAt?: string;
    ratio?: number;
  }>;
  alerts: Array<{
    createdAt: string;
    teamRef: string;
    period: string;
    threshold: number;
    spendUsd: number;
    maxBudgetUsd: number;
  }>;
  /** Preenchido quando o gateway não respondeu. */
  unavailable?: string;
}

/** Erro 403: o usuário não tem a permissão agent.governance.read. */
export class ForbiddenError extends Error {}

export async function getGovernance<T>(
  apis: { discoveryApi: DiscoveryApi; fetchApi: FetchApi },
  path: string,
): Promise<T> {
  const baseUrl = await apis.discoveryApi.getBaseUrl('agent');
  const res = await apis.fetchApi.fetch(`${baseUrl}/governance/${path}`);
  if (res.status === 403) throw new ForbiddenError('Acesso restrito ao time de plataforma');
  if (!res.ok) throw new Error(`Falha ao carregar ${path} (HTTP ${res.status})`);
  return (await res.json()) as T;
}

/** Custo estimado em USD a partir do preço por milhão de tokens (se configurado). */
export function estimateCost(
  byModel: Overview['byModel'],
  pricing: Pricing,
): number | undefined {
  let total = 0;
  let priced = false;
  for (const m of byModel) {
    const p = pricing[m.model];
    if (!p) continue;
    priced = true;
    total +=
      ((p.input ?? 0) * m.inputTokens +
        (p.output ?? 0) * m.outputTokens +
        (p.cacheRead ?? 0) * m.cacheReadTokens +
        (p.cacheWrite ?? 0) * m.cacheWriteTokens) /
      1_000_000;
  }
  return priced ? total : undefined;
}
