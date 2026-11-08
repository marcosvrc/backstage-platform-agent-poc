import { TestDatabases, mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { createGateway } from '../gateway';
import { DirectAnthropicGateway } from '../gateway/direct';
import Anthropic from '@anthropic-ai/sdk';
import { LiteLLMGateway, liteLLMTeamId } from '../gateway/litellm';
import type { TeamBudgetStatus } from '../gateway';
import { BudgetService } from './budgets';
import { GovernanceStore } from './store';

/** LiteLLM falso: guarda teams e keys em memória e registra as chamadas. */
function fakeLiteLLM() {
  const teams = new Map<string, any>();
  const keys = new Map<string, any>();
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    switch (url.pathname) {
      case '/team/info': {
        const t = teams.get(url.searchParams.get('team_id')!);
        return t ? json(200, { team_info: t }) : json(404, { error: { message: 'Team not found' } });
      }
      case '/team/new':
        teams.set(body.team_id, { ...body, spend: 0 });
        return json(200, body);
      case '/team/update':
        Object.assign(teams.get(body.team_id), body);
        return json(200, {});
      case '/team/list':
        return json(200, [...teams.values()]);
      case '/key/info':
        return keys.has(url.searchParams.get('key')!)
          ? json(200, {})
          : json(404, { error: { message: 'Key not found' } });
      case '/key/generate':
        keys.set(body.key, body);
        return json(200, { key: body.key });
      default:
        return json(404, {});
    }
  }) as unknown as typeof fetch;
  return { teams, keys, calls, fetchImpl };
}

const caller = {
  userRef: 'user:default/bruno.lima',
  teams: ['group:default/checkout-team'],
  requestId: 'req-1',
};

describe('gateways', () => {
  it('direct: usa a Anthropic e envia só um id opaco do usuário', () => {
    const gw = new DirectAnthropicGateway({ apiKey: 'sk-test' });
    expect(gw.client().baseURL).toBe('https://api.anthropic.com');
    const { body } = gw.requestExtras(caller);
    const userId = (body?.metadata as { user_id: string }).user_id;
    expect(userId).toMatch(/^[0-9a-f]{32}$/);
    expect(userId).not.toContain('bruno');
    expect(body).not.toHaveProperty('litellm_metadata');
  });

  it('litellm: aponta para o pass-through /anthropic e atribui usuário, time e pedido', async () => {
    const gw = new LiteLLMGateway({
      baseUrl: 'http://localhost:4000/',
      apiKey: 'sk-virtual',
      tags: ['app:backstage-agent'],
    });
    expect(gw.client().baseURL).toBe('http://localhost:4000/anthropic');
    expect(gw.client().apiKey).toBe('sk-virtual');
    expect((await gw.requestExtras(caller)).body).toEqual({
      metadata: { user_id: 'user:default/bruno.lima' },
      litellm_metadata: {
        user: 'user:default/bruno.lima',
        tags: ['app:backstage-agent', 'team:checkout-team', 'request:req-1'],
      },
    });
  });

  it('litellm: sendMetadata=false não envia campos próprios do LiteLLM', async () => {
    const gw = new LiteLLMGateway({ baseUrl: 'http://x', apiKey: 'k', sendMetadata: false });
    expect((await gw.requestExtras(caller)).body).not.toHaveProperty('litellm_metadata');
    // Sem adminKey não há orçamento por time.
    expect(gw.budgets).toBeUndefined();
  });

  it('litellm com adminKey: cria team e key por time, e usa a key do time na chamada', async () => {
    const fake = fakeLiteLLM();
    const gw = new LiteLLMGateway({ baseUrl: 'http://x', apiKey: 'k', adminKey: 'admin', fetch: fake.fetchImpl });
    await gw.budgets!.ensureTeam('group:default/checkout-team', 50);
    expect(fake.teams.get('backstage-checkout-team')).toMatchObject({
      team_alias: 'group:default/checkout-team',
      max_budget: 50,
      budget_duration: '1mo',
    });
    // Idempotente; muda o orçamento quando a config muda.
    await gw.budgets!.ensureTeam('group:default/checkout-team', 50);
    expect(fake.calls.filter(c => c === 'POST /team/update')).toHaveLength(0);
    await gw.budgets!.ensureTeam('group:default/checkout-team', 80);
    expect(fake.teams.get('backstage-checkout-team').max_budget).toBe(80);

    const extras = await gw.requestExtras({ ...caller, billingTeam: 'group:default/checkout-team' });
    const key = extras.headers?.Authorization?.replace('Bearer ', '');
    expect(key).toMatch(/^sk-bs-[0-9a-f]{40}$/);
    expect(fake.keys.get(key!)).toMatchObject({ team_id: 'backstage-checkout-team' });
    // Mesma key em um novo processo (derivada da adminKey), sem gerar outra.
    const gw2 = new LiteLLMGateway({ baseUrl: 'http://x', apiKey: 'k', adminKey: 'admin', fetch: fake.fetchImpl });
    const again = await gw2.requestExtras({ ...caller, billingTeam: 'group:default/checkout-team' });
    expect(again.headers?.Authorization).toBe(`Bearer ${key}`);
    expect(fake.calls.filter(c => c === 'POST /key/generate')).toHaveLength(1);

    expect(await gw.budgets!.list()).toEqual([
      { teamRef: 'group:default/checkout-team', spendUsd: 0, maxBudgetUsd: 80, resetAt: undefined },
    ]);
  });

  it('litellm: reconhece o bloqueio por orçamento e gera ids de team válidos', () => {
    const gw = new LiteLLMGateway({ baseUrl: 'http://x', apiKey: 'k', adminKey: 'admin' });
    const budgetErr = Anthropic.APIError.generate(
      429,
      { error: { type: 'budget_exceeded', message: 'Budget has been exceeded!' } },
      undefined,
      new Headers(),
    );
    const rateErr = Anthropic.APIError.generate(
      429,
      { error: { type: 'rate_limit_error', message: 'slow down' } },
      undefined,
      new Headers(),
    );
    expect(gw.budgets!.isBudgetExceeded(budgetErr)).toBe(true);
    expect(gw.budgets!.isBudgetExceeded(rateErr)).toBe(false);
    expect(liteLLMTeamId('group:default/platform-team')).toBe('backstage-platform-team');
    expect(liteLLMTeamId('group:acme/Data Team')).toBe('backstage-acme-data-team');
  });

  it('createGateway escolhe pela config e falha com tipo desconhecido', () => {
    expect(createGateway(new ConfigReader({})).type).toBe('direct');
    expect(
      createGateway(
        new ConfigReader({ agent: { gateway: { type: 'litellm', baseUrl: 'http://x', apiKey: 'k' } } }),
      ).type,
    ).toBe('litellm');
    expect(() =>
      createGateway(new ConfigReader({ agent: { gateway: { type: 'kong' } } })),
    ).toThrow(/desconhecido.*direct, litellm/);
  });
});

describe('GovernanceStore', () => {
  const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

  async function createStore() {
    const knex = await databases.init('SQLITE_3');
    return GovernanceStore.create(mockServices.database({ knex }));
  }

  const usage = (output: number) => ({
    modelCalls: 2,
    inputTokens: 10,
    outputTokens: output,
    cacheReadTokens: 1000,
    cacheWriteTokens: 100,
  });

  it('agrega uso por time, usuário, ação e aprovação', async () => {
    const store = await createStore();
    await store.recordRequest({
      id: 'a',
      userRef: 'user:default/bruno.lima',
      teams: ['group:default/checkout-team'],
      kind: 'message',
      model: 'claude-opus-5-5',
      gateway: 'litellm',
      status: 'awaiting_approval',
      latencyMs: 9000,
      usage: usage(500),
      toolCalls: [
        { toolUseId: 't1', actionId: 'catalog:get-catalog-entity', readOnly: true, approval: 'auto', status: 'ok', latencyMs: 30 },
        { toolUseId: 't2', actionId: 'scaffolder:execute-template', readOnly: false, approval: 'pending', status: 'not_executed' },
      ],
    });
    await store.recordRequest({
      id: 'b',
      userRef: 'user:default/bruno.lima',
      teams: ['group:default/checkout-team'],
      kind: 'resume',
      model: 'claude-opus-5-5',
      gateway: 'litellm',
      status: 'ok',
      latencyMs: 4000,
      usage: usage(300),
      toolCalls: [
        { toolUseId: 't2', actionId: 'scaffolder:execute-template', readOnly: false, approval: 'approved', status: 'ok', latencyMs: 900 },
      ],
    });
    await store.recordRequest({
      id: 'c',
      userRef: 'user:default/ana.souza',
      teams: ['group:default/platform-team'],
      kind: 'message',
      model: 'claude-opus-5-5',
      gateway: 'litellm',
      status: 'error',
      error: 'Erro da API (429)',
      latencyMs: 100,
      usage: usage(0),
      toolCalls: [],
    });

    const o = await store.overview(7);
    expect(o.totals).toMatchObject({ requests: 3, users: 2, errors: 1, outputTokens: 800 });
    expect(o.byTeam.map(t => [t.team, t.requests, t.users])).toEqual([
      ['group:default/checkout-team', 2, 1],
      ['group:default/platform-team', 1, 1],
    ]);
    expect(o.approvals).toEqual({ approved: 1, rejected: 0, pending: 1 });
    expect(o.byAction.find(a => a.actionId === 'scaffolder:execute-template')).toMatchObject({
      calls: 1,
      readOnly: false,
    });
    expect(o.byStatus).toEqual({ awaiting_approval: 1, ok: 1, error: 1 });
    expect(o.byDay).toHaveLength(7);
    expect(o.byDay.at(-1)?.requests).toBe(3);

    const writes = await store.audit({ limit: 10, onlyWrites: true });
    expect(writes.map(r => r.id).sort()).toEqual(['a', 'b']);
    expect(writes.find(r => r.id === 'b')?.toolCalls[0]).toMatchObject({ approval: 'approved' });
  });

  it('grava e lista rodadas de evals', async () => {
    const store = await createStore();
    await store.recordEvalRun({
      userRef: 'user:default/guest',
      model: 'claude-opus-5-5',
      gateway: 'direct',
      total: 45,
      passed: 42,
      invalid: 2,
      byHypothesis: { H1: { pass: 15, total: 15 } },
      usage: { outputTokens: 38000 },
      latencyP50Ms: 9300,
    });
    const [run] = await store.evalRuns(5);
    expect(run).toMatchObject({ total: 45, passed: 42, byHypothesis: { H1: { pass: 15, total: 15 } } });
  });

  it('grava cada alerta de orçamento uma única vez por período', async () => {
    const store = await createStore();
    const alert = { teamRef: 'group:default/checkout-team', period: '2026-12-01T00:00:00Z', threshold: 0.8, spendUsd: 41, maxBudgetUsd: 50 };
    expect(await store.recordBudgetAlert(alert)).toBe(true);
    expect(await store.recordBudgetAlert(alert)).toBe(false);
    expect(await store.recordBudgetAlert({ ...alert, threshold: 1 })).toBe(true);
    expect(await store.budgetAlerts()).toHaveLength(2);
  });
});

describe('BudgetService', () => {
  const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

  async function setup(statuses: TeamBudgetStatus[]) {
    const knex = await databases.init('SQLITE_3');
    const store = await GovernanceStore.create(mockServices.database({ knex }));
    const ensureTeam = jest.fn(async () => {});
    const send = jest.fn(async () => {});
    const getEntities = jest.fn(async () => ({
      items: [{ kind: 'Group', metadata: { name: 'checkout-team', namespace: 'default' } }],
    }));
    const service = new BudgetService({
      budgets: { ensureTeam, list: async () => statuses, isBudgetExceeded: () => false },
      settings: {
        enabled: true,
        monthlyUsd: 50,
        teams: { 'platform-team': 200 },
        thresholds: [0.8, 1],
        notify: ['group:default/platform-team'],
      },
      store,
      catalog: { getEntities } as any,
      auth: mockServices.auth(),
      notifications: { send },
      logger: mockServices.logger.mock(),
    });
    return { service, ensureTeam, send };
  }

  const status = (spendUsd: number): TeamBudgetStatus => ({
    teamRef: 'group:default/checkout-team',
    spendUsd,
    maxBudgetUsd: 50,
    resetAt: '2026-12-01T00:00:00Z',
  });

  it('usa o orçamento padrão ou a exceção do time', async () => {
    const { service } = await setup([]);
    expect(service.budgetFor('group:default/checkout-team')).toBe(50);
    expect(service.budgetFor('group:default/platform-team')).toBe(200);
  });

  it('sincroniza os Groups do catálogo e alerta o time e a plataforma uma vez', async () => {
    const { service, ensureTeam, send } = await setup([status(42)]);
    await service.sync();
    expect(ensureTeam).toHaveBeenCalledWith('group:default/checkout-team', 50);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((c: any) => c[0].recipients.entityRef)).toEqual([
      'group:default/checkout-team',
      ['group:default/platform-team'],
    ]);
    expect((send.mock.calls[0] as any)[0].payload).toMatchObject({
      title: 'Orçamento de IA: checkout-team usou 84%',
      severity: 'high',
      scope: 'agent-budget:group:default/checkout-team:2026-12-01T00:00:00Z',
    });
    expect((send.mock.calls[1] as any)[0].payload.link).toBe('/governanca-ia');
    await service.sync();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('bloqueia antes da chamada quando o orçamento acabou e alerta como crítico', async () => {
    const { service, send } = await setup([status(50.2)]);
    expect(await service.prepare('group:default/checkout-team')).toMatchObject({ blocked: true });
    await service.checkAlerts([status(50.2)]);
    expect((send.mock.calls[0] as any)[0].payload).toMatchObject({
      title: 'Orçamento de IA esgotado: checkout-team',
      severity: 'critical',
    });
  });

  it('fica desligado sem gateway com orçamento', async () => {
    const knex = await databases.init('SQLITE_3');
    const service = new BudgetService({
      settings: { enabled: true, monthlyUsd: 50, teams: {}, thresholds: [1], notify: [] },
      store: await GovernanceStore.create(mockServices.database({ knex })),
      catalog: {} as any,
      auth: mockServices.auth(),
      notifications: { send: jest.fn() },
      logger: mockServices.logger.mock(),
    });
    expect(service.active).toBe(false);
    expect(await service.prepare('group:default/x')).toEqual({ blocked: false });
    expect(await service.report()).toMatchObject({ supported: false, teams: [] });
  });
});
