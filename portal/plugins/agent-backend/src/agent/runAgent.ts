import Anthropic from '@anthropic-ai/sdk';
import type { BackstageCredentials, LoggerService } from '@backstage/backend-plugin-api';
import type { ActionsService, ActionsServiceAction } from '@backstage/backend-plugin-api/alpha';
import type { JsonObject } from '@backstage/types';
import { actionsToTools, requiresApproval } from './tools';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

/** Eventos enviados ao frontend (NDJSON, um por linha). */
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; action: string; title: string; input: unknown }
  | { type: 'tool_end'; id: string; ok: boolean; error?: string }
  | {
      type: 'approval_required';
      pending: Array<{ toolUseId: string; action: string; title: string; input: unknown }>;
    }
  | { type: 'done'; messages: MessageParam[]; usage: AgentUsage }
  | { type: 'error'; message: string };

export interface AgentSettings {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxIterations: number;
  systemPrompt: string;
}

/** Consumo acumulado de tokens no pedido (todas as chamadas ao modelo). */
export interface AgentUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const MAX_TOOL_OUTPUT_CHARS = 60_000;

export async function runAgent(opts: {
  client: Anthropic;
  actionsService: ActionsService;
  credentials: BackstageCredentials;
  logger: LoggerService;
  settings: AgentSettings;
  /** Histórico completo da conversa (mantido pelo frontend). */
  messages: MessageParam[];
  /** Decisões do usuário para ações de escrita pendentes: toolUseId -> aprovado? */
  approvals?: Record<string, boolean>;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { client, actionsService, credentials, logger, settings, emit, signal } = opts;
  const messages = [...opts.messages];
  const usage: AgentUsage = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  // As ações são listadas com as credenciais do usuário: o agente só enxerga
  // e executa o que o próprio usuário tem permissão para fazer.
  const { actions } = await actionsService.list({ credentials });
  const { tools, byName } = actionsToTools(actions);

  const executeTools = async (
    toolUses: ToolUseBlock[],
    approvals: Record<string, boolean>,
  ): Promise<ToolResultBlockParam[]> =>
    Promise.all(
      toolUses.map(async (toolUse): Promise<ToolResultBlockParam> => {
        const action = byName.get(toolUse.name);
        if (!action) {
          return errorResult(toolUse.id, `Ferramenta desconhecida: ${toolUse.name}`);
        }
        if (requiresApproval(action) && approvals[toolUse.id] !== true) {
          return errorResult(toolUse.id, 'O usuário NÃO aprovou esta ação. Ela não foi executada.');
        }
        if (!isJsonObject(toolUse.input)) {
          return errorResult(toolUse.id, 'Entrada inválida: era esperado um objeto JSON.');
        }
        emit({
          type: 'tool_start',
          id: toolUse.id,
          action: action.id,
          title: action.title,
          input: toolUse.input,
        });
        try {
          // O Actions Registry valida a entrada contra o schema da ação.
          const { output } = await actionsService.invoke({
            id: action.id,
            input: toolUse.input,
            credentials,
          });
          emit({ type: 'tool_end', id: toolUse.id, ok: true });
          return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: truncate(JSON.stringify(output)),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Ação ${action.id} falhou: ${message}`);
          emit({ type: 'tool_end', id: toolUse.id, ok: false, error: message });
          return errorResult(toolUse.id, message);
        }
      }),
    );

  // Retomada após aprovação: a última mensagem é do assistente, com tool_use pendentes.
  const last = messages.at(-1);
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const pending = last.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
    if (pending.length > 0) {
      messages.push({ role: 'user', content: await executeTools(pending, opts.approvals ?? {}) });
    }
  }

  let jsonRetries = 0;
  for (let iteration = 0; iteration < settings.maxIterations; iteration++) {
    const stream = client.beta.messages.stream(
      {
        model: settings.model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: settings.effort },
        cache_control: { type: 'ephemeral' },
        system: settings.systemPrompt,
        tools,
        messages,
      },
      { signal },
    );
    stream.on('text', delta => emit({ type: 'text', delta }));

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
      usage.modelCalls++;
      usage.inputTokens += message.usage?.input_tokens ?? 0;
      usage.outputTokens += message.usage?.output_tokens ?? 0;
      usage.cacheReadTokens += message.usage?.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += message.usage?.cache_creation_input_tokens ?? 0;
    } catch (err) {
      // Com eager_input_streaming, uma entrada de tool não parseável rejeita aqui.
      // Só esse caso é repetido; erros da API sobem.
      if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
      logger.warn('Entrada de ferramenta não parseável; repetindo o turno');
      continue;
    }

    if (message.stop_reason === 'refusal') {
      // Não anexa a resposta: ela pode conter um tool_use incompleto.
      emit({ type: 'text', delta: '\n\n_Não posso ajudar com esse pedido._' });
      break;
    }

    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason === 'pause_turn') continue;

    const toolUses = message.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) break;

    if (message.stop_reason === 'max_tokens') {
      throw new Error('A resposta do modelo foi truncada (max_tokens).');
    }

    // Ações de escrita: interrompe e pede aprovação ao usuário.
    const needApproval = toolUses
      .map(t => ({ toolUse: t, action: byName.get(t.name) }))
      .filter((x): x is { toolUse: ToolUseBlock; action: ActionsServiceAction } =>
        Boolean(x.action && requiresApproval(x.action)),
      );
    if (needApproval.length > 0) {
      emit({
        type: 'approval_required',
        pending: needApproval.map(({ toolUse, action }) => ({
          toolUseId: toolUse.id,
          action: action.id,
          title: action.title,
          input: toolUse.input,
        })),
      });
      emit({ type: 'done', messages, usage });
      return;
    }

    messages.push({ role: 'user', content: await executeTools(toolUses, {}) });
  }

  emit({ type: 'done', messages, usage });
}

function errorResult(toolUseId: string, message: string): ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: message };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...[saída truncada]`
    : text;
}
