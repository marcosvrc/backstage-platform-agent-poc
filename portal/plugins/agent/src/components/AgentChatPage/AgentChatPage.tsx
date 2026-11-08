import { useEffect, useRef, useState } from 'react';
import { MarkdownContent } from '@backstage/core-components';
import {
  discoveryApiRef,
  fetchApiRef,
  identityApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import { Box, Button, Flex, Text, TextField } from '@backstage/ui';
import {
  RiAddLine,
  RiCheckLine,
  RiCloseLine,
  RiLoader4Line,
  RiSendPlane2Line,
  RiSparkling2Line,
  RiToolsLine,
} from '@remixicon/react';
import { ApiMessage, PendingApproval, streamChat } from '../../api';

type ToolStatus = 'running' | 'ok' | 'error';

type ChatItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; action: string; title: string; status: ToolStatus; error?: string }
  | { kind: 'approval'; pending: PendingApproval[]; decision?: 'approved' | 'rejected' }
  | { kind: 'error'; text: string };

const SUGGESTIONS = [
  'Quem é dono do payment-service e de quais recursos ele depende?',
  'Quais serviços do time checkout-team estão em produção?',
  'Quais componentes estão fora dos padrões da plataforma?',
  'Quero criar um novo serviço Java. O que preciso informar?',
];

const ACTION_LABELS: Record<string, string> = {
  'catalog:query-catalog-entities': 'Consultando o catálogo',
  'catalog:get-catalog-entity': 'Lendo entidade do catálogo',
  'catalog:get-catalog-model-description': 'Lendo o modelo do catálogo',
  'catalog:validate-entity': 'Validando entidade',
  'catalog:register-entity': 'Registrando entidade',
  'catalog:unregister-entity': 'Removendo entidade',
  'catalog:refresh-catalog-entity': 'Atualizando entidade',
  'scaffolder:execute-template': 'Executando template',
  'scaffolder:dry-run-template': 'Simulando template',
  'scaffolder:list-scaffolder-tasks': 'Listando tarefas do scaffolder',
  'scaffolder:list-scaffolder-actions': 'Listando ações do scaffolder',
  'scaffolder:get-scaffolder-task-logs': 'Lendo logs da tarefa',
  'auth:who-am-i': 'Identificando usuário',
  'agent:check-service-compliance': 'Verificando conformidade',
  'agent:search-techdocs': 'Buscando na documentação',
  'agent:read-techdocs-page': 'Lendo documentação',
};

const styles = {
  page: {
    height: '100%',
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column' as const,
    background: 'var(--bui-bg-app)',
  },
  scroll: { flex: 1, overflowY: 'auto' as const, padding: '24px 16px' },
  column: { maxWidth: 820, margin: '0 auto', width: '100%' },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '80%',
    background: 'var(--bui-accent-bg)',
    color: 'var(--bui-accent-fg)',
    padding: '10px 14px',
    borderRadius: 16,
    borderBottomRightRadius: 4,
    whiteSpace: 'pre-wrap' as const,
  },
  assistant: { alignSelf: 'stretch', color: 'var(--bui-fg-primary)' },
  toolChip: {
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 10px',
    borderRadius: 999,
    background: 'var(--bui-bg-neutral-2)',
    color: 'var(--bui-fg-secondary)',
    fontSize: 13,
  },
  approval: {
    alignSelf: 'stretch',
    border: '1px solid var(--bui-border-2)',
    background: 'var(--bui-bg-neutral-1)',
    borderRadius: 12,
    padding: 16,
  },
  pre: {
    margin: '8px 0 0',
    padding: 10,
    borderRadius: 8,
    background: 'var(--bui-bg-neutral-2)',
    fontSize: 12,
    overflowX: 'auto' as const,
    maxHeight: 240,
  },
  composer: {
    borderTop: '1px solid var(--bui-border-1)',
    background: 'var(--bui-bg-app)',
    padding: '12px 16px 16px',
  },
  suggestion: {
    textAlign: 'left' as const,
    padding: '12px 14px',
    borderRadius: 12,
    border: '1px solid var(--bui-border-1)',
    background: 'var(--bui-bg-neutral-1)',
    color: 'var(--bui-fg-primary)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 14,
  },
};

export function AgentChatPage() {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const identityApi = useApi(identityApiRef);

  const [displayName, setDisplayName] = useState<string>();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [history, setHistory] = useState<ApiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController>();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    identityApi
      .getProfileInfo()
      .then(p => setDisplayName(p.displayName?.split(' ')[0]))
      .catch(() => undefined);
    return () => abortRef.current?.abort();
  }, [identityApi]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items]);

  const run = async (messages: ApiMessage[], approvals?: Record<string, boolean>) => {
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await streamChat({
        discoveryApi,
        fetchApi,
        messages,
        approvals,
        signal: abort.signal,
        onEvent: event => {
          switch (event.type) {
            case 'text':
              setItems(prev => {
                const last = prev[prev.length - 1];
                if (last?.kind === 'assistant') {
                  return [...prev.slice(0, -1), { ...last, text: last.text + event.delta }];
                }
                return [...prev, { kind: 'assistant', text: event.delta }];
              });
              break;
            case 'tool_start':
              setItems(prev => [
                ...prev,
                {
                  kind: 'tool',
                  id: event.id,
                  action: event.action,
                  title: ACTION_LABELS[event.action] ?? event.title,
                  status: 'running',
                },
              ]);
              break;
            case 'tool_end':
              setItems(prev =>
                prev.map(i =>
                  i.kind === 'tool' && i.id === event.id
                    ? { ...i, status: event.ok ? 'ok' : 'error', error: event.error }
                    : i,
                ),
              );
              break;
            case 'approval_required':
              setItems(prev => [...prev, { kind: 'approval', pending: event.pending }]);
              break;
            case 'done':
              setHistory(event.messages);
              break;
            case 'error':
              setItems(prev => [...prev, { kind: 'error', text: event.message }]);
              break;
            default:
          }
        },
      });
    } catch (err) {
      if (!abort.signal.aborted) {
        setItems(prev => [
          ...prev,
          { kind: 'error', text: err instanceof Error ? err.message : String(err) },
        ]);
      }
    } finally {
      setBusy(false);
    }
  };

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput('');
    setItems(prev => [...prev, { kind: 'user', text: trimmed }]);
    run([...history, { role: 'user', content: trimmed }]);
  };

  const decide = (index: number, approved: boolean) => {
    const item = items[index];
    if (item?.kind !== 'approval' || item.decision || busy) return;
    setItems(prev =>
      prev.map((i, idx) =>
        idx === index ? { ...item, decision: approved ? 'approved' : 'rejected' } : i,
      ),
    );
    const approvals = Object.fromEntries(item.pending.map(p => [p.toolUseId, approved]));
    run(history, approvals);
  };

  const reset = () => {
    abortRef.current?.abort();
    setItems([]);
    setHistory([]);
    setInput('');
  };

  const empty = items.length === 0;

  return (
    <div style={styles.page}>
      <div style={styles.scroll}>
        <div style={styles.column}>
          {empty ? (
            <Flex direction="column" gap="6" style={{ paddingTop: '10vh' }}>
              <Flex direction="column" gap="2" align="center">
                <RiSparkling2Line size={40} color="var(--bui-fg-primary)" />
                <Text as="h1" variant="title-large" weight="bold">
                  {displayName ? `Olá, ${displayName}!` : 'Olá!'}
                </Text>
                <Text as="p" variant="body-large" color="secondary">
                  Sou o Platform Agent. Pergunte sobre serviços, times e APIs, ou peça
                  para criar um novo serviço.
                </Text>
              </Flex>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: 12,
                }}
              >
                {SUGGESTIONS.map(s => (
                  <button key={s} type="button" style={styles.suggestion} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </Flex>
          ) : (
            <Flex direction="column" gap="3">
              {items.map((item, index) => (
                <ChatItemView
                  key={index}
                  item={item}
                  busy={busy}
                  onDecide={approved => decide(index, approved)}
                />
              ))}
              {busy && items[items.length - 1]?.kind === 'user' && (
                <span style={styles.toolChip}>
                  <RiLoader4Line size={14} className="agent-spin" /> Pensando…
                </span>
              )}
              <div ref={bottomRef} />
            </Flex>
          )}
        </div>
      </div>

      <div style={styles.composer}>
        <div style={styles.column}>
          <form
            onSubmit={e => {
              e.preventDefault();
              send(input);
            }}
          >
            <Flex gap="2" align="end">
              <Box style={{ flex: 1 }}>
                <TextField
                  aria-label="Mensagem para o agente"
                  placeholder="Pergunte algo ou peça para criar um serviço…"
                  value={input}
                  onChange={setInput}
                  isDisabled={busy}
                />
              </Box>
              <Button
                type="submit"
                variant="primary"
                iconStart={<RiSendPlane2Line size={16} />}
                isDisabled={busy || !input.trim()}
              >
                Enviar
              </Button>
              {!empty && (
                <Button
                  variant="secondary"
                  iconStart={<RiAddLine size={16} />}
                  onPress={reset}
                >
                  Nova conversa
                </Button>
              )}
            </Flex>
          </form>
        </div>
      </div>
      <style>{`@keyframes agent-spin { to { transform: rotate(360deg); } } .agent-spin { animation: agent-spin 1s linear infinite; }`}</style>
    </div>
  );
}

function ChatItemView(props: {
  item: ChatItem;
  busy: boolean;
  onDecide: (approved: boolean) => void;
}) {
  const { item, busy, onDecide } = props;
  switch (item.kind) {
    case 'user':
      return <div style={styles.userBubble}>{item.text}</div>;
    case 'assistant':
      return (
        <div style={styles.assistant}>
          <MarkdownContent content={item.text} linkTarget="_self" />
        </div>
      );
    case 'tool': {
      let icon = <RiLoader4Line size={14} className="agent-spin" />;
      if (item.status === 'ok') icon = <RiToolsLine size={14} />;
      if (item.status === 'error') icon = <RiCloseLine size={14} color="var(--bui-fg-negative)" />;
      return (
        <span style={styles.toolChip} title={item.error ?? item.action}>
          {icon} {item.title}
          {item.status === 'error' ? ' (falhou)' : ''}
        </span>
      );
    }
    case 'approval':
      return (
        <div style={styles.approval}>
          <Text as="p" weight="bold">
            O agente quer executar {item.pending.length === 1 ? 'uma ação' : 'ações'} que
            alteram a plataforma:
          </Text>
          {item.pending.map(p => (
            <div key={p.toolUseId} style={{ marginTop: 12 }}>
              <Text as="p" variant="body-medium">
                <strong>{ACTION_LABELS[p.action] ?? p.title}</strong> ({p.action})
              </Text>
              <pre style={styles.pre}>{JSON.stringify(p.input, null, 2)}</pre>
            </div>
          ))}
          <Flex gap="2" style={{ marginTop: 12 }}>
            {item.decision ? (
              <Text as="p" color="secondary">
                {item.decision === 'approved' ? 'Aprovado por você.' : 'Recusado por você.'}
              </Text>
            ) : (
              <>
                <Button
                  variant="primary"
                  iconStart={<RiCheckLine size={16} />}
                  isDisabled={busy}
                  onPress={() => onDecide(true)}
                >
                  Aprovar
                </Button>
                <Button
                  variant="secondary"
                  iconStart={<RiCloseLine size={16} />}
                  isDisabled={busy}
                  onPress={() => onDecide(false)}
                >
                  Recusar
                </Button>
              </>
            )}
          </Flex>
        </div>
      );
    case 'error':
      return (
        <div style={{ ...styles.approval, borderColor: 'var(--bui-negative-border)' }}>
          <Text as="p" color="danger">
            {item.text}
          </Text>
        </div>
      );
    default:
      return null;
  }
}
