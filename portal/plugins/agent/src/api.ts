import type { DiscoveryApi, FetchApi } from '@backstage/frontend-plugin-api';

/** Mensagem no formato da Messages API (opaca para o frontend). */
export type ApiMessage = { role: 'user' | 'assistant'; content: unknown };

export type PendingApproval = {
  toolUseId: string;
  action: string;
  title: string;
  input: unknown;
};

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; action: string; title: string; input: unknown }
  | { type: 'tool_end'; id: string; ok: boolean; error?: string }
  | { type: 'approval_required'; pending: PendingApproval[] }
  | { type: 'done'; messages: ApiMessage[] }
  | { type: 'error'; message: string };

/** Envia a conversa ao backend e repassa cada evento NDJSON recebido. */
export async function streamChat(opts: {
  discoveryApi: DiscoveryApi;
  fetchApi: FetchApi;
  messages: ApiMessage[];
  approvals?: Record<string, boolean>;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}): Promise<void> {
  const baseUrl = await opts.discoveryApi.getBaseUrl('agent');
  const response = await opts.fetchApi.fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: opts.messages, approvals: opts.approvals }),
    signal: opts.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Falha ao falar com o agente (HTTP ${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) opts.onEvent(JSON.parse(line) as AgentEvent);
      newline = buffer.indexOf('\n');
    }
  }
}
