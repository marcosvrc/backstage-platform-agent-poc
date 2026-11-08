import type Anthropic from '@anthropic-ai/sdk';
import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import type { ActionsService, ActionsServiceAction } from '@backstage/backend-plugin-api/alpha';
import { AgentEvent, runAgent } from './runAgent';
import { actionsToTools, toToolName } from './tools';

const action = (id: string, readOnly: boolean): ActionsServiceAction => ({
  id,
  pluginId: id.split(':')[0],
  name: id.split(':')[1],
  title: id,
  description: `desc ${id}`,
  schema: {
    input: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} },
    output: { type: 'object' },
  },
  attributes: { readOnly, destructive: !readOnly, idempotent: readOnly },
});

const ACTIONS = [
  action('catalog:get-catalog-entity', true),
  action('scaffolder:execute-template', false),
];

/** Cliente falso: devolve as respostas na ordem e registra as requisições. */
function fakeClient(responses: Array<Partial<Anthropic.Beta.BetaMessage>>) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: any) => {
          requests.push(structuredClone(params));
          const res = responses.shift()!;
          return {
            on: (_event: string, cb: (d: string) => void) => {
              for (const b of res.content ?? []) if (b.type === 'text') cb(b.text);
            },
            finalMessage: async () => res,
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

function setup(responses: Array<Partial<Anthropic.Beta.BetaMessage>>) {
  const { client, requests } = fakeClient(responses);
  const invoke = jest.fn(async ({ id }: { id: string }) => ({ output: { ok: id } }));
  const actionsService: ActionsService = {
    list: async () => ({ actions: ACTIONS }),
    invoke: invoke as any,
  };
  const events: AgentEvent[] = [];
  const base = {
    client,
    actionsService,
    credentials: mockCredentials.user(),
    logger: mockServices.logger.mock(),
    settings: { model: 'claude-opus-5-5', effort: 'medium' as const, maxIterations: 5, systemPrompt: 's' },
    emit: (e: AgentEvent) => events.push(e),
    signal: new AbortController().signal,
  };
  return { base, requests, invoke, events };
}

const toolUse = (id: string, name: string, input: object) =>
  ({ type: 'tool_use', id, name: toToolName(name), input }) as Anthropic.Beta.BetaToolUseBlock;

describe('tools', () => {
  it('converte ações em tools com nomes válidos e sem $schema', () => {
    const { tools, byName } = actionsToTools(ACTIONS);
    expect(tools.map(t => t.name)).toEqual([
      'catalog__get-catalog-entity',
      'scaffolder__execute-template',
    ]);
    expect(tools[0].input_schema).not.toHaveProperty('$schema');
    expect(tools[1].description).toContain('aprovação');
    expect(byName.get('catalog__get-catalog-entity')?.id).toBe('catalog:get-catalog-entity');
  });
});

describe('runAgent', () => {
  it('executa ações de leitura automaticamente e devolve o resultado ao modelo', async () => {
    const { base, requests, invoke, events } = setup([
      {
        stop_reason: 'tool_use',
        content: [toolUse('t1', 'catalog:get-catalog-entity', { name: 'payment-service' })],
      },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'É do payments-team.' } as any] },
    ]);

    await runAgent({ ...base, messages: [{ role: 'user', content: 'dono?' }] });

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'catalog:get-catalog-entity', input: { name: 'payment-service' } }),
    );
    // A segunda chamada ao modelo inclui o tool_result.
    const lastMsg = requests[1].messages.at(-1);
    expect(lastMsg.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(events.map(e => e.type)).toEqual(['tool_start', 'tool_end', 'text', 'done']);
  });

  it('pausa em ações de escrita até o usuário aprovar', async () => {
    const write = toolUse('w1', 'scaffolder:execute-template', { templateRef: 'template:default/java-service' });
    const { base, invoke, events } = setup([{ stop_reason: 'tool_use', content: [write] }]);

    await runAgent({ ...base, messages: [{ role: 'user', content: 'cria o serviço' }] });

    expect(invoke).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: 'approval_required', pending: [{ toolUseId: 'w1' }] });
    const done = events.at(-1) as Extract<AgentEvent, { type: 'done' }>;
    expect(done.messages.at(-1)?.role).toBe('assistant');
  });

  it('executa a ação aprovada ao retomar', async () => {
    const write = toolUse('w1', 'scaffolder:execute-template', {});
    const { base, invoke, requests } = setup([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Criado!' } as any] },
    ]);

    await runAgent({
      ...base,
      messages: [
        { role: 'user', content: 'cria' },
        { role: 'assistant', content: [write] },
      ],
      approvals: { w1: true },
    });

    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'scaffolder:execute-template' }));
    expect(requests[0].messages.at(-1).content[0]).toMatchObject({ tool_use_id: 'w1' });
    expect(requests[0].messages.at(-1).content[0].is_error).toBeUndefined();
  });

  it('não executa a ação recusada e informa o modelo', async () => {
    const write = toolUse('w1', 'scaffolder:execute-template', {});
    const { base, invoke, requests } = setup([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ok, cancelado.' } as any] },
    ]);

    await runAgent({
      ...base,
      messages: [
        { role: 'user', content: 'cria' },
        { role: 'assistant', content: [write] },
      ],
      approvals: { w1: false },
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(requests[0].messages.at(-1).content[0]).toMatchObject({ is_error: true });
  });
});

describe('runAgent: resumo para auditoria', () => {
  it('registra leitura automática, ação pendente e extras do gateway', async () => {
    const { base, requests } = setup([
      {
        stop_reason: 'tool_use',
        content: [toolUse('t1', 'catalog:get-catalog-entity', { name: 'x' })],
      },
      {
        stop_reason: 'tool_use',
        content: [toolUse('w1', 'scaffolder:execute-template', {})],
      },
    ]);
    const summary = await runAgent({
      ...base,
      messages: [{ role: 'user', content: 'cria' }],
      requestExtras: { body: { metadata: { user_id: 'u1' } }, headers: { 'x-test': '1' } },
    });
    expect(summary.status).toBe('awaiting_approval');
    expect(summary.usage.modelCalls).toBe(2);
    expect(summary.toolCalls).toEqual([
      expect.objectContaining({ actionId: 'catalog:get-catalog-entity', approval: 'auto', status: 'ok' }),
      expect.objectContaining({ actionId: 'scaffolder:execute-template', approval: 'pending', status: 'not_executed' }),
    ]);
    expect(requests[0].metadata).toEqual({ user_id: 'u1' });
  });

  it('envia só os recursos que o destino aceita (ex.: Bedrock via LiteLLM)', async () => {
    const all = setup([{ stop_reason: 'end_turn', content: [] }]);
    await runAgent({ ...all.base, messages: [{ role: 'user', content: 'oi' }] });
    expect(all.requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
    });
    expect(all.requests[0].tools[0].eager_input_streaming).toBe(true);

    const bedrock = setup([{ stop_reason: 'end_turn', content: [] }]);
    await runAgent({
      ...bedrock.base,
      messages: [{ role: 'user', content: 'oi' }],
      model: 'claude-opus',
      features: {
        serverSideFallback: false,
        effort: false,
        eagerToolStreaming: false,
        promptCaching: true,
      },
    });
    const req = bedrock.requests[0];
    expect(req.model).toBe('claude-opus');
    expect(req).not.toHaveProperty('betas');
    expect(req).not.toHaveProperty('fallbacks');
    expect(req).not.toHaveProperty('output_config');
    expect(req.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.tools[0]).not.toHaveProperty('eager_input_streaming');
  });

  it('registra aprovação e recusa ao retomar', async () => {
    const { base } = setup([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' } as any] }]);
    const summary = await runAgent({
      ...base,
      messages: [
        { role: 'user', content: 'cria e remove' },
        {
          role: 'assistant',
          content: [
            toolUse('w1', 'scaffolder:execute-template', {}),
            toolUse('w2', 'scaffolder:execute-template', {}),
          ],
        },
      ],
      approvals: { w1: true, w2: false },
    });
    expect(summary.toolCalls.map(t => [t.toolUseId, t.approval, t.status])).toEqual([
      ['w1', 'approved', 'ok'],
      ['w2', 'rejected', 'not_executed'],
    ]);
  });
});
