import { CSSProperties, ReactNode, useCallback, useEffect, useState } from 'react';
import {
  discoveryApiRef,
  fetchApiRef,
  useApi,
} from '@backstage/frontend-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { Box, Button, Flex, Text } from '@backstage/ui';
import {
  RiCheckLine,
  RiCloseLine,
  RiLockLine,
  RiShieldCheckLine,
  RiTimeLine,
} from '@remixicon/react';
import {
  AuditItem,
  EvalRun,
  ForbiddenError,
  Overview,
  Policy,
  estimateCost,
  getGovernance,
} from '../../governanceApi';

type TabId = 'overview' | 'audit' | 'inventory' | 'policy' | 'quality';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'audit', label: 'Auditoria' },
  { id: 'inventory', label: 'Inventário' },
  { id: 'policy', label: 'Políticas' },
  { id: 'quality', label: 'Qualidade' },
];

const PERIODS = [7, 30, 90];

const s: Record<string, CSSProperties> = {
  page: {
    padding: 'var(--bui-space-6) var(--bui-space-6) var(--bui-space-10)',
    maxWidth: 1200,
    margin: '0 auto',
    color: 'var(--bui-fg-primary)',
  },
  tabs: {
    display: 'flex',
    gap: 'var(--bui-space-1)',
    borderBottom: '1px solid var(--bui-border-1)',
    margin: 'var(--bui-space-4) 0 var(--bui-space-5)',
    overflowX: 'auto',
  },
  tab: {
    padding: 'var(--bui-space-2) var(--bui-space-3)',
    border: 'none',
    borderBottom: '2px solid transparent',
    background: 'transparent',
    color: 'var(--bui-fg-secondary)',
    cursor: 'pointer',
    font: 'inherit',
    whiteSpace: 'nowrap',
  },
  tabActive: { color: 'var(--bui-fg-primary)', borderBottomColor: 'var(--bui-accent-bg)' },
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: 'var(--bui-space-3)',
    marginBottom: 'var(--bui-space-5)',
  },
  tile: {
    padding: 'var(--bui-space-4)',
    borderRadius: 'var(--bui-radius-3)',
    border: '1px solid var(--bui-border-1)',
    background: 'var(--bui-bg-neutral-1)',
  },
  tileValue: { fontSize: 28, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
  section: { marginBottom: 'var(--bui-space-6)' },
  card: {
    padding: 'var(--bui-space-4)',
    borderRadius: 'var(--bui-radius-3)',
    border: '1px solid var(--bui-border-1)',
    background: 'var(--bui-bg-neutral-1)',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: {
    textAlign: 'left',
    padding: 'var(--bui-space-2)',
    color: 'var(--bui-fg-secondary)',
    fontWeight: 500,
    borderBottom: '1px solid var(--bui-border-1)',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: 'var(--bui-space-2)',
    borderBottom: '1px solid var(--bui-border-1)',
    verticalAlign: 'top',
  },
  num: { textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '1px 8px',
    margin: '0 4px 4px 0',
    borderRadius: 999,
    fontSize: 12,
    background: 'var(--bui-bg-neutral-2)',
    color: 'var(--bui-fg-secondary)',
    whiteSpace: 'nowrap',
  },
  muted: { color: 'var(--bui-fg-secondary)' },
  scroll: { overflowX: 'auto' },
};

const fmt = (n: number) => n.toLocaleString('pt-BR');
const fmtTokens = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} mi`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} mil`;
  return fmt(n);
};
const fmtSec = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '–' : `${(ms / 1000).toFixed(1)} s`;
const actionKind = (a: { readOnly: boolean; destructive: boolean }) => {
  if (a.readOnly) return 'leitura';
  return a.destructive ? 'escrita (destrutiva)' : 'escrita';
};
const shortRef = (ref: string) => ref.replace(/^[a-z]+:(default\/)?/, '');
const totalInput = (t: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) =>
  t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;

function useGovernance<T>(path: string) {
  const discoveryApi = useApi(discoveryApiRef);
  const fetchApi = useApi(fetchApiRef);
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({
    loading: true,
  });
  const load = useCallback(() => {
    setState(prev => ({ ...prev, loading: true }));
    getGovernance<T>({ discoveryApi, fetchApi }, path).then(
      data => setState({ data, loading: false }),
      error => setState({ error, loading: false }),
    );
  }, [discoveryApi, fetchApi, path]);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

export function GovernancePage() {
  const [tab, setTab] = useState<TabId>('overview');
  const [days, setDays] = useState(30);
  // Carrega a política primeiro: ela também confirma se o usuário tem acesso.
  const policy = useGovernance<Policy>('policy');

  if (policy.error instanceof ForbiddenError) {
    return (
      <div style={s.page}>
        <Flex direction="column" align="center" gap="3" style={{ marginTop: 80 }}>
          <RiLockLine size={40} color="var(--bui-fg-secondary)" />
          <Text variant="title-small">Acesso restrito</Text>
          <Text color="secondary">
            O painel de governança de IA é visível apenas para o time de plataforma.
          </Text>
        </Flex>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <Flex justify="between" align="end" style={{ flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Text as="h1" variant="title-medium">
            Governança de IA
          </Text>
          <Text color="secondary">
            Uso, custo, auditoria e políticas do Platform Agent e dos clientes MCP.
          </Text>
        </div>
        {policy.data && (
          <Flex gap="2" align="center" style={{ flexWrap: 'wrap' }}>
            <span style={s.chip}>Modelo: {policy.data.model.id}</span>
            <span style={s.chip}>
              {policy.data.gateway.health.ok ? (
                <RiCheckLine size={12} color="var(--bui-fg-positive)" />
              ) : (
                <RiCloseLine size={12} color="var(--bui-fg-negative)" />
              )}
              Gateway: {policy.data.gateway.type}
            </span>
          </Flex>
        )}
      </Flex>

      <div role="tablist" style={s.tabs}>
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            style={{ ...s.tab, ...(tab === t.id ? s.tabActive : {}) }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab days={days} setDays={setDays} policy={policy.data} />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'inventory' && <InventoryTab />}
      {tab === 'policy' && <PolicyTab policy={policy.data} error={policy.error} />}
      {tab === 'quality' && <QualityTab />}
    </div>
  );
}

function Loading({ error, loading }: { error?: Error; loading: boolean }) {
  if (error) return <Text color="danger">{error.message}</Text>;
  if (loading) return <Text color="secondary">Carregando…</Text>;
  return null;
}

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div style={s.tile}>
      <Text variant="body-small" color="secondary">
        {label}
      </Text>
      <div style={s.tileValue}>{value}</div>
      {hint && (
        <Text variant="body-small" color="secondary">
          {hint}
        </Text>
      )}
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section style={s.section}>
      <Flex justify="between" align="center" style={{ marginBottom: 8 }}>
        <Text as="h2" variant="title-x-small">
          {title}
        </Text>
        {aside}
      </Flex>
      {children}
    </section>
  );
}

function OverviewTab({
  days,
  setDays,
  policy,
}: {
  days: number;
  setDays: (d: number) => void;
  policy?: Policy;
}) {
  const { data, error, loading } = useGovernance<Overview>(`overview?days=${days}`);
  const cost = data && policy ? estimateCost(data.byModel, policy.pricing) : undefined;

  return (
    <>
      <Flex gap="2" style={{ marginBottom: 16 }} role="group" aria-label="Período">
        {PERIODS.map(p => (
          <Button
            key={p}
            size="small"
            variant={p === days ? 'primary' : 'secondary'}
            onPress={() => setDays(p)}
          >
            {p} dias
          </Button>
        ))}
      </Flex>
      {!data ? (
        <Loading error={error} loading={loading} />
      ) : (
        <>
          <div style={s.tiles}>
            <Tile label="Pedidos ao agente" value={fmt(data.totals.requests)} hint={`${fmt(data.totals.modelCalls)} chamadas ao modelo`} />
            <Tile label="Usuários ativos" value={fmt(data.totals.users)} hint={`${data.byTeam.length} times`} />
            <Tile
              label="Custo estimado"
              value={cost === undefined ? '–' : `US$ ${cost.toFixed(2)}`}
              hint={cost === undefined ? 'Configure agent.governance.pricing' : 'pelos preços configurados'}
            />
            <Tile
              label="Tokens"
              value={fmtTokens(data.totals.outputTokens)}
              hint={`saída · ${fmtTokens(totalInput(data.totals))} de entrada (${
                totalInput(data.totals)
                  ? Math.round((100 * data.totals.cacheReadTokens) / totalInput(data.totals))
                  : 0
              }% do cache)`}
            />
            <Tile label="Latência" value={fmtSec(data.latency.p50Ms)} hint={`p50 · p90 ${fmtSec(data.latency.p90Ms)}`} />
            <Tile
              label="Ações de escrita"
              value={fmt(data.approvals.approved + data.approvals.rejected + data.approvals.pending)}
              hint={`${data.approvals.approved} aprovadas · ${data.approvals.rejected} recusadas · ${data.approvals.pending} pendentes`}
            />
            <Tile
              label="Erros"
              value={data.totals.requests ? `${((100 * data.totals.errors) / data.totals.requests).toFixed(1)}%` : '–'}
              hint={`${fmt(data.totals.errors)} pedidos`}
            />
          </div>

          <Section title="Pedidos por dia">
            <div style={s.card}>
              <DailyBars days={data.byDay} />
            </div>
          </Section>

          <Section title="Por time">
            <UsageTable
              rows={data.byTeam.map(t => ({ key: t.team, label: shortRef(t.team), extra: `${t.users} usuário(s)`, ...t }))}
              policy={policy}
            />
          </Section>
          <Section title="Por usuário (top 20)">
            <UsageTable rows={data.byUser.map(u => ({ key: u.userRef, label: shortRef(u.userRef), ...u }))} policy={policy} />
          </Section>
          <Section title="Ações do Backstage usadas pelo agente">
            <div style={s.scroll}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>Ação</th>
                    <th style={s.th}>Tipo</th>
                    <th style={{ ...s.th, ...s.num }}>Execuções</th>
                    <th style={{ ...s.th, ...s.num }}>Erros</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAction.map(a => (
                    <tr key={a.actionId}>
                      <td style={s.td}>
                        <code>{a.actionId}</code>
                      </td>
                      <td style={s.td}>{a.readOnly ? 'leitura' : 'escrita (com aprovação)'}</td>
                      <td style={{ ...s.td, ...s.num }}>{fmt(a.calls)}</td>
                      <td style={{ ...s.td, ...s.num }}>{fmt(a.errors)}</td>
                    </tr>
                  ))}
                  {data.byAction.length === 0 && (
                    <tr>
                      <td style={s.td} colSpan={4}>
                        <Text color="secondary">Nenhuma ação no período.</Text>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </>
  );
}

function UsageTable({
  rows,
  policy,
}: {
  rows: Array<
    Overview['byTeam'][number] extends infer _T
      ? {
          key: string;
          label: string;
          extra?: string;
          requests: number;
          errors: number;
          modelCalls: number;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        }
      : never
  >;
  policy?: Policy;
}) {
  if (rows.length === 0) return <Text color="secondary">Sem uso no período.</Text>;
  // Custo por linha usa o preço do modelo configurado (o painel assume um modelo por agente).
  const price = policy ? policy.pricing[policy.model.id] : undefined;
  return (
    <div style={s.scroll}>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Nome</th>
            <th style={{ ...s.th, ...s.num }}>Pedidos</th>
            <th style={{ ...s.th, ...s.num }}>Tokens de saída</th>
            <th style={{ ...s.th, ...s.num }}>Tokens de entrada</th>
            {price && <th style={{ ...s.th, ...s.num }}>Custo estimado</th>}
            <th style={{ ...s.th, ...s.num }}>Erros</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key}>
              <td style={s.td}>
                {r.label}
                {r.extra && <span style={{ ...s.muted, marginLeft: 8, fontSize: 12 }}>{r.extra}</span>}
              </td>
              <td style={{ ...s.td, ...s.num }}>{fmt(r.requests)}</td>
              <td style={{ ...s.td, ...s.num }}>{fmtTokens(r.outputTokens)}</td>
              <td style={{ ...s.td, ...s.num }}>{fmtTokens(totalInput(r))}</td>
              {price && (
                <td style={{ ...s.td, ...s.num }}>
                  US$ {(estimateCost([{ model: policy!.model.id, ...r }], policy!.pricing) ?? 0).toFixed(2)}
                </td>
              )}
              <td style={{ ...s.td, ...s.num }}>{fmt(r.errors)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Barras de pedidos por dia: uma série, uma cor, com tooltip por barra e tabela alternativa. */
function DailyBars({ days }: { days: Overview['byDay'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map(d => d.requests));
  const height = 160;
  const labelIdx = new Set([0, Math.floor((days.length - 1) / 2), days.length - 1]);
  const dayLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            height,
            fontSize: 12,
            color: 'var(--bui-fg-secondary)',
            textAlign: 'right',
            minWidth: 24,
          }}
          aria-hidden
        >
          <span>{fmt(max)}</span>
          <span>0</span>
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 2,
              height,
              borderBottom: '1px solid var(--bui-border-2)',
            }}
            role="img"
            aria-label={`Pedidos por dia nos últimos ${days.length} dias; máximo de ${max} em um dia`}
          >
            {days.map((d, i) => (
              <div
                key={d.day}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{
                  flex: 1,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'flex-end',
                  cursor: 'default',
                }}
              >
                <div
                  style={{
                    width: '100%',
                    height: d.requests ? `${Math.max(2, (100 * d.requests) / max)}%` : 0,
                    background: 'var(--bui-accent-bg)',
                    opacity: hover === null || hover === i ? 1 : 0.55,
                    borderRadius: '4px 4px 0 0',
                  }}
                />
              </div>
            ))}
          </div>
          {hover !== null && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: `${(100 * (hover + 0.5)) / days.length}%`,
                transform: `translateX(${hover > days.length / 2 ? '-100%' : '0'})`,
                padding: '6px 10px',
                borderRadius: 'var(--bui-radius-2)',
                background: 'var(--bui-bg-neutral-3)',
                border: '1px solid var(--bui-border-2)',
                fontSize: 12,
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                zIndex: 1,
              }}
            >
              <strong>{dayLabel(days[hover].day)}</strong>
              <div>{fmt(days[hover].requests)} pedidos</div>
              <div style={s.muted}>{fmtTokens(days[hover].outputTokens)} tokens de saída</div>
            </div>
          )}
          <div style={{ display: 'flex', fontSize: 12, color: 'var(--bui-fg-secondary)', marginTop: 4 }}>
            {days.map((d, i) => (
              <span key={d.day} style={{ flex: 1, textAlign: 'center', overflow: 'visible', whiteSpace: 'nowrap' }}>
                {labelIdx.has(i) ? dayLabel(d.day) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ ...s.muted, cursor: 'pointer', fontSize: 13 }}>Ver como tabela</summary>
        <table style={{ ...s.table, marginTop: 8 }}>
          <thead>
            <tr>
              <th style={s.th}>Dia</th>
              <th style={{ ...s.th, ...s.num }}>Pedidos</th>
              <th style={{ ...s.th, ...s.num }}>Tokens de saída</th>
            </tr>
          </thead>
          <tbody>
            {days
              .filter(d => d.requests > 0)
              .map(d => (
                <tr key={d.day}>
                  <td style={s.td}>{dayLabel(d.day)}</td>
                  <td style={{ ...s.td, ...s.num }}>{fmt(d.requests)}</td>
                  <td style={{ ...s.td, ...s.num }}>{fmt(d.outputTokens)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

const STATUS_LABEL: Record<string, { label: string; ok: boolean }> = {
  ok: { label: 'concluído', ok: true },
  awaiting_approval: { label: 'aguardando aprovação', ok: true },
  refused: { label: 'recusado pelo modelo', ok: false },
  max_iterations: { label: 'limite de iterações', ok: false },
  error: { label: 'erro', ok: false },
  aborted: { label: 'cancelado', ok: false },
};

const APPROVAL_LABEL: Record<string, string> = {
  auto: 'leitura',
  approved: 'aprovada',
  rejected: 'recusada',
  pending: 'aguardando',
};

function StatusBadge({ status }: { status: string }) {
  const info = STATUS_LABEL[status] ?? { label: status, ok: false };
  return (
    <span style={s.chip}>
      {info.ok ? (
        <RiCheckLine size={12} color="var(--bui-fg-positive)" />
      ) : (
        <RiCloseLine size={12} color="var(--bui-fg-negative)" />
      )}
      {info.label}
    </span>
  );
}

function AuditTab() {
  const [onlyWrites, setOnlyWrites] = useState(false);
  const { data, error, loading, reload } = useGovernance<{ items: AuditItem[] }>(
    `audit?limit=100${onlyWrites ? '&writes=true' : ''}`,
  );
  return (
    <>
      <Flex gap="2" style={{ marginBottom: 16 }} align="center">
        <Button size="small" variant={onlyWrites ? 'secondary' : 'primary'} onPress={() => setOnlyWrites(false)}>
          Todos os pedidos
        </Button>
        <Button size="small" variant={onlyWrites ? 'primary' : 'secondary'} onPress={() => setOnlyWrites(true)}>
          Só com ações de escrita
        </Button>
        <Button size="small" variant="tertiary" onPress={reload}>
          Atualizar
        </Button>
      </Flex>
      {!data ? (
        <Loading error={error} loading={loading} />
      ) : (
        <div style={s.scroll}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Quando</th>
                <th style={s.th}>Usuário</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Ações executadas</th>
                <th style={{ ...s.th, ...s.num }}>Tokens (saída)</th>
                <th style={{ ...s.th, ...s.num }}>Latência</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(item => (
                <tr key={item.id}>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                    {new Date(item.createdAt).toLocaleString('pt-BR')}
                    {item.kind === 'resume' && <div style={{ ...s.muted, fontSize: 12 }}>após aprovação</div>}
                  </td>
                  <td style={s.td}>
                    {shortRef(item.userRef)}
                    <div style={{ ...s.muted, fontSize: 12 }}>{item.teams.map(shortRef).join(', ')}</div>
                  </td>
                  <td style={s.td}>
                    <StatusBadge status={item.status} />
                    {item.error && <div style={{ ...s.muted, fontSize: 12, maxWidth: 260 }}>{item.error}</div>}
                  </td>
                  <td style={s.td}>
                    {item.promptPreview && (
                      <div style={{ ...s.muted, fontSize: 12, marginBottom: 4 }}>“{item.promptPreview}”</div>
                    )}
                    {item.toolCalls.length === 0 && <span style={s.muted}>–</span>}
                    {item.toolCalls.map((t, i) => (
                      <span key={i} style={s.chip} title={t.error}>
                        {!t.readOnly && <RiShieldCheckLine size={12} />}
                        {t.actionId}
                        {!t.readOnly && ` · ${APPROVAL_LABEL[t.approval]}`}
                        {t.status === 'error' && ' · erro'}
                      </span>
                    ))}
                  </td>
                  <td style={{ ...s.td, ...s.num }}>{fmt(item.outputTokens)}</td>
                  <td style={{ ...s.td, ...s.num }}>{fmtSec(item.latencyMs)}</td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <td style={s.td} colSpan={6}>
                    <Text color="secondary">Nenhum pedido registrado.</Text>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const AI_TYPES: Record<string, string> = {
  'ai-model': 'Modelo',
  'ai-gateway': 'Gateway',
  'ai-agent': 'Agente',
  mcp: 'Servidor MCP',
};
const ann = (e: Entity, key: string) => e.metadata.annotations?.[`acme.example/${key}`];

function InventoryTab() {
  const catalogApi = useApi(catalogApiRef);
  const [state, setState] = useState<{ items?: Entity[]; error?: Error }>({});
  useEffect(() => {
    catalogApi
      .getEntities({
        filter: [
          { kind: 'resource', 'spec.type': ['ai-model', 'ai-gateway'] },
          { kind: 'component', 'spec.type': 'ai-agent' },
          { kind: 'api', 'spec.type': 'mcp' },
        ],
      })
      .then(
        r => setState({ items: r.items }),
        error => setState({ error }),
      );
  }, [catalogApi]);

  if (!state.items) return <Loading error={state.error} loading />;
  const order = Object.keys(AI_TYPES);
  const items = [...state.items].sort(
    (a, b) =>
      order.indexOf(String(a.spec?.type)) - order.indexOf(String(b.spec?.type)) ||
      a.metadata.name.localeCompare(b.metadata.name),
  );
  return (
    <>
      <Text color="secondary" style={{ display: 'block', marginBottom: 12 }}>
        Ativos de IA registrados no catálogo (catalog/ai/ai.yaml). Para registrar um novo, use um
        dos tipos <code>ai-model</code>, <code>ai-gateway</code>, <code>ai-agent</code> ou{' '}
        <code>mcp</code> e as annotations <code>acme.example/ai-*</code>.
      </Text>
      <div style={s.scroll}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Ativo</th>
              <th style={s.th}>Tipo</th>
              <th style={s.th}>Dono</th>
              <th style={s.th}>Risco</th>
              <th style={s.th}>Acesso a dados</th>
              <th style={s.th}>Aprovação humana</th>
            </tr>
          </thead>
          <tbody>
            {items.map(e => {
              const ref = stringifyEntityRef(e);
              const [kind, rest] = ref.split(':');
              const [ns, name] = rest.split('/');
              const owner = e.relations?.find(r => r.type === 'ownedBy')?.targetRef;
              return (
                <tr key={ref}>
                  <td style={s.td}>
                    <a href={`/catalog/${ns}/${kind}/${name}`}>{e.metadata.title ?? e.metadata.name}</a>
                    <div style={{ ...s.muted, fontSize: 12 }}>{e.metadata.description}</div>
                  </td>
                  <td style={s.td}>{AI_TYPES[String(e.spec?.type)] ?? String(e.spec?.type)}</td>
                  <td style={s.td}>{owner ? shortRef(owner) : <span style={s.muted}>sem dono</span>}</td>
                  <td style={s.td}>{ann(e, 'ai-risk-level') ?? <span style={s.muted}>não classificado</span>}</td>
                  <td style={s.td}>{ann(e, 'ai-data-access') ?? <span style={s.muted}>–</span>}</td>
                  <td style={s.td}>{ann(e, 'ai-human-approval') ?? <span style={s.muted}>–</span>}</td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td style={s.td} colSpan={6}>
                  <Text color="secondary">Nenhum ativo de IA no catálogo.</Text>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PolicyTab({ policy, error }: { policy?: Policy; error?: Error }) {
  if (!policy) return <Loading error={error} loading />;
  const writes = policy.actions.filter(a => a.requiresApproval);
  return (
    <>
      <div style={s.tiles}>
        <Tile label="Modelo" value={<span style={{ fontSize: 18 }}>{policy.model.id}</span>} hint={`effort ${policy.model.effort} · até ${policy.model.maxIterations} iterações`} />
        <Tile
          label="Gateway"
          value={<span style={{ fontSize: 18 }}>{policy.gateway.displayName}</span>}
          hint={
            <>
              {policy.gateway.health.ok ? 'saudável' : `indisponível: ${policy.gateway.health.detail ?? ''}`}
              {policy.gateway.baseUrl && ` · ${policy.gateway.baseUrl}`}
            </>
          }
        />
        <Tile
          label="Ações expostas"
          value={fmt(policy.actions.length)}
          hint={`${writes.length} exigem aprovação humana`}
        />
        <Tile
          label="Registro das perguntas"
          value={<span style={{ fontSize: 18 }}>{policy.storePrompts ? 'ligado' : 'desligado'}</span>}
          hint="agent.governance.storePrompts"
        />
      </div>

      <Section title="Regras">
        <div style={s.card}>
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
            <li>O agente age com as <strong>credenciais do usuário</strong>: vê e faz só o que ele pode.</li>
            <li>Ações de escrita só rodam depois de <strong>aprovação explícita</strong> no chat, e ficam no log de auditoria do Backstage (<code>agent-write-action</code>).</li>
            <li>Entidades com <code>acme.example/data-classification: restricted</code> só são visíveis para o time dono.</li>
            <li>Remover locations do catálogo e ver este painel: só o <strong>platform-team</strong>.</li>
            <li>Clientes MCP externos usam <strong>OAuth</strong> com a identidade do usuário. O token estático é só para desenvolvimento.</li>
            <li>
              Chamadas ao modelo passam pelo gateway <strong>{policy.gateway.type}</strong>, que guarda as chaves dos provedores e
              atribui o gasto por usuário e time.
            </li>
          </ul>
        </div>
      </Section>

      <Section title="Ações disponíveis para o agente">
        <div style={s.scroll}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Ação</th>
                <th style={s.th}>Descrição</th>
                <th style={s.th}>Tipo</th>
                <th style={s.th}>Aprovação</th>
              </tr>
            </thead>
            <tbody>
              {policy.actions.map(a => (
                <tr key={a.id}>
                  <td style={s.td}>
                    <code>{a.id}</code>
                  </td>
                  <td style={s.td}>{a.title}</td>
                  <td style={s.td}>{actionKind(a)}</td>
                  <td style={s.td}>
                    {a.requiresApproval ? (
                      <span style={s.chip}>
                        <RiShieldCheckLine size={12} /> exige aprovação
                      </span>
                    ) : (
                      <span style={s.muted}>automática</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

function QualityTab() {
  const { data, error, loading } = useGovernance<{ items: EvalRun[] }>('evals?limit=50');
  if (!data) return <Loading error={error} loading={loading} />;
  return (
    <>
      <Text color="secondary" style={{ display: 'block', marginBottom: 12 }}>
        Rodadas do conjunto de avaliação (<code>node evals/run.mjs</code>). Execuções que falharam por
        problema de infraestrutura (ex.: sem crédito na API) contam como inválidas e ficam fora da taxa.
      </Text>
      {data.items.length === 0 ? (
        <Box style={s.card}>
          <Flex gap="2" align="center">
            <RiTimeLine size={16} />
            <Text color="secondary">Nenhuma rodada publicada ainda. Rode os evals para ver o histórico aqui.</Text>
          </Flex>
        </Box>
      ) : (
        <div style={s.scroll}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Quando</th>
                <th style={{ ...s.th, ...s.num }}>Acerto</th>
                <th style={s.th}>Por hipótese</th>
                <th style={s.th}>Modelo · gateway</th>
                <th style={{ ...s.th, ...s.num }}>Latência p50 / p90</th>
                <th style={{ ...s.th, ...s.num }}>Tokens de saída</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map(run => {
                const valid = run.total - run.invalid;
                return (
                  <tr key={run.id}>
                    <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                      {new Date(run.createdAt).toLocaleString('pt-BR')}
                      <div style={{ ...s.muted, fontSize: 12 }}>{shortRef(run.userRef)}</div>
                    </td>
                    <td style={{ ...s.td, ...s.num }}>
                      <strong>{valid ? `${Math.round((100 * run.passed) / valid)}%` : '–'}</strong>
                      <div style={{ ...s.muted, fontSize: 12 }}>
                        {run.passed}/{valid}
                        {run.invalid > 0 && ` (+${run.invalid} inválidas)`}
                      </div>
                    </td>
                    <td style={s.td}>
                      {Object.entries(run.byHypothesis).map(([h, v]) => (
                        <span key={h} style={s.chip}>
                          {v.pass === v.total ? (
                            <RiCheckLine size={12} color="var(--bui-fg-positive)" />
                          ) : (
                            <RiCloseLine size={12} color="var(--bui-fg-negative)" />
                          )}
                          {h} {v.pass}/{v.total}
                        </span>
                      ))}
                    </td>
                    <td style={s.td}>
                      {run.model}
                      <div style={{ ...s.muted, fontSize: 12 }}>{run.gateway}</div>
                    </td>
                    <td style={{ ...s.td, ...s.num }}>
                      {fmtSec(run.latencyP50Ms)} / {fmtSec(run.latencyP90Ms)}
                    </td>
                    <td style={{ ...s.td, ...s.num }}>{fmtTokens(run.usage.outputTokens ?? 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
