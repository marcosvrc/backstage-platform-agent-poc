import { TestDatabases, mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { createGateway } from '../gateway';
import { DirectAnthropicGateway } from '../gateway/direct';
import { LiteLLMGateway } from '../gateway/litellm';
import { GovernanceStore } from './store';

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

  it('litellm: aponta para o pass-through /anthropic e atribui usuário, time e pedido', () => {
    const gw = new LiteLLMGateway({
      baseUrl: 'http://localhost:4000/',
      apiKey: 'sk-virtual',
      tags: ['app:backstage-agent'],
    });
    expect(gw.client().baseURL).toBe('http://localhost:4000/anthropic');
    expect(gw.client().apiKey).toBe('sk-virtual');
    expect(gw.requestExtras(caller).body).toEqual({
      metadata: { user_id: 'user:default/bruno.lima' },
      litellm_metadata: {
        user: 'user:default/bruno.lima',
        tags: ['app:backstage-agent', 'team:checkout-team', 'request:req-1'],
      },
    });
  });

  it('litellm: sendMetadata=false não envia campos próprios do LiteLLM', () => {
    const gw = new LiteLLMGateway({ baseUrl: 'http://x', apiKey: 'k', sendMetadata: false });
    expect(gw.requestExtras(caller).body).not.toHaveProperty('litellm_metadata');
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
});
