import Anthropic from '@anthropic-ai/sdk';
import { LiteLLMGateway, liteLLMTeamId } from './LiteLLMGateway';

const caller = {
  userRef: 'user:default/bruno.lima',
  teams: ['group:default/checkout-team'],
  requestId: 'req-1',
};

/** LiteLLM falso: guarda teams e keys em memória e registra as chamadas. */
function fakeLiteLLM() {
  const teams = new Map<string, any>();
  const keys = new Map<string, any>();
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    switch (url.pathname) {
      case '/team/info': {
        const t = teams.get(url.searchParams.get('team_id')!);
        return t
          ? json(200, { team_info: t })
          : json(404, { error: { message: 'Team not found' } });
      }
      case '/team/new':
        teams.set(body.team_id, { ...body, spend: 0 });
        return json(200, body);
      case '/team/update':
        Object.assign(teams.get(body.team_id), body);
        return json(200, {});
      case '/team/list':
        return json(200, [...teams.values()]);
      case '/key/info': {
        // Sem ?key=, a própria key do header (como o LiteLLM faz para keys sem admin).
        const key =
          url.searchParams.get('key') ??
          String(
            (init?.headers as Record<string, string>)?.Authorization,
          ).replace('Bearer ', '');
        const k = keys.get(key);
        return k
          ? json(200, { info: k })
          : json(404, { error: { message: 'Key not found' } });
      }
      case '/key/generate':
        keys.set(body.key, body);
        return json(200, { key: body.key });
      default:
        return json(404, {});
    }
  }) as unknown as typeof fetch;
  return { teams, keys, calls, fetchImpl };
}

describe('LiteLLMGateway', () => {
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
    const gw = new LiteLLMGateway({
      baseUrl: 'http://x',
      apiKey: 'k',
      sendMetadata: false,
    });
    expect((await gw.requestExtras(caller)).body).not.toHaveProperty(
      'litellm_metadata',
    );
    // Sem adminKey não há orçamento por time.
    expect(gw.budgets).toBeUndefined();
  });

  it('litellm com adminKey: cria team e key por time, e usa a key do time na chamada', async () => {
    const fake = fakeLiteLLM();
    const gw = new LiteLLMGateway({
      baseUrl: 'http://x',
      apiKey: 'k',
      adminKey: 'admin',
      fetch: fake.fetchImpl,
    });
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

    const extras = await gw.requestExtras({
      ...caller,
      billingTeam: 'group:default/checkout-team',
    });
    const key = extras.headers?.Authorization?.replace('Bearer ', '');
    expect(key).toMatch(/^sk-bs-[0-9a-f]{40}$/);
    expect(fake.keys.get(key!)).toMatchObject({
      team_id: 'backstage-checkout-team',
    });
    // Mesma key em um novo processo (derivada da adminKey), sem gerar outra.
    const gw2 = new LiteLLMGateway({
      baseUrl: 'http://x',
      apiKey: 'k',
      adminKey: 'admin',
      fetch: fake.fetchImpl,
    });
    const again = await gw2.requestExtras({
      ...caller,
      billingTeam: 'group:default/checkout-team',
    });
    expect(again.headers?.Authorization).toBe(`Bearer ${key}`);
    expect(fake.calls.filter(c => c === 'POST /key/generate')).toHaveLength(1);

    expect(await gw.budgets!.list()).toEqual([
      {
        teamRef: 'group:default/checkout-team',
        spendUsd: 0,
        maxBudgetUsd: 80,
        resetAt: undefined,
      },
    ]);
  });

  it('litellm rota messages (Bedrock/Vertex): base do proxy, alias do modelo e sem fallback', () => {
    const gw = new LiteLLMGateway({
      baseUrl: 'https://llm.corp/',
      apiKey: 'k',
      route: 'messages',
      model: 'claude-opus',
    });
    expect(gw.client().baseURL).toBe('https://llm.corp');
    expect(gw.model('claude-opus-5-5')).toBe('claude-opus');
    expect(gw.features()).toEqual({
      serverSideFallback: false,
      effort: true,
      eagerToolStreaming: true,
      promptCaching: true,
    });
    const custom = new LiteLLMGateway({
      baseUrl: 'http://x',
      apiKey: 'k',
      route: 'messages',
      features: { effort: false, promptCaching: undefined },
    });
    expect(custom.features()).toMatchObject({
      effort: false,
      promptCaching: true,
    });
    // passthrough continua igual ao padrão.
    expect(
      new LiteLLMGateway({ baseUrl: 'http://x', apiKey: 'k' }).features()
        .serverSideFallback,
    ).toBe(true);
  });

  it('litellm com teamKeys: usa a key do time, lê o gasto com ela e não cria nada', async () => {
    const fake = fakeLiteLLM();
    fake.teams.set('corp-checkout', {
      team_id: 'corp-checkout',
      spend: 12.5,
      max_budget: 20,
      budget_reset_at: '2026-12-01T00:00:00Z',
    });
    fake.keys.set('sk-checkout', { team_id: 'corp-checkout', spend: 3 });
    fake.keys.set('sk-solta', { team_id: null, spend: 1, max_budget: 5 });
    const gw = new LiteLLMGateway({
      baseUrl: 'http://x',
      apiKey: 'sk-portal',
      teamKeys: {
        'checkout-team': 'sk-checkout',
        'group:default/payments-team': 'sk-solta',
        'data-team': 'sk-invalida',
      },
      fetch: fake.fetchImpl,
    });
    expect(gw.budgets?.mode).toBe('external');
    await gw.budgets!.ensureTeam('group:default/checkout-team', 50);
    expect(fake.calls.filter(c => c.startsWith('POST'))).toEqual([]);

    const checkout = await gw.requestExtras({
      ...caller,
      billingTeam: 'group:default/checkout-team',
    });
    expect(checkout.headers).toEqual({ Authorization: 'Bearer sk-checkout' });
    const semKey = await gw.requestExtras({
      ...caller,
      billingTeam: 'group:default/platform-team',
    });
    expect(semKey.headers).toBeUndefined();

    const list = await gw.budgets!.list();
    expect(list.find(t => t.teamRef === 'group:default/checkout-team')).toEqual(
      {
        teamRef: 'group:default/checkout-team',
        spendUsd: 12.5,
        maxBudgetUsd: 20,
        resetAt: '2026-12-01T00:00:00Z',
      },
    );
    // Key sem team: usa o orçamento da própria key.
    expect(
      list.find(t => t.teamRef === 'group:default/payments-team'),
    ).toMatchObject({ spendUsd: 1, maxBudgetUsd: 5 });
    expect(
      list.find(t => t.teamRef === 'group:default/data-team')?.error,
    ).toMatch(/HTTP 404/);
  });

  it('litellm: não aceita adminKey e teamKeys juntos', () => {
    expect(
      () =>
        new LiteLLMGateway({
          baseUrl: 'http://x',
          apiKey: 'k',
          adminKey: 'a',
          teamKeys: { t: 'k' },
        }),
    ).toThrow(/não os dois/);
  });

  it('litellm: reconhece o bloqueio por orçamento e gera ids de team válidos', () => {
    const gw = new LiteLLMGateway({
      baseUrl: 'http://x',
      apiKey: 'k',
      adminKey: 'admin',
    });
    const budgetErr = Anthropic.APIError.generate(
      429,
      {
        error: {
          type: 'budget_exceeded',
          message: 'Budget has been exceeded!',
        },
      },
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
    expect(liteLLMTeamId('group:default/platform-team')).toBe(
      'backstage-platform-team',
    );
    expect(liteLLMTeamId('group:acme/Data Team')).toBe(
      'backstage-acme-data-team',
    );
  });
});
