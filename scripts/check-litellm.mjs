#!/usr/bin/env node
// Diagnóstico do LiteLLM para o Platform Agent: conectividade, certificado, chaves,
// modelos e quais recursos da Messages API a rota aceita. Ao final, sugere o bloco
// agent.gateway do app-config.
//
// Uso (as chaves vêm do ambiente, para não ficarem no histórico do shell):
//   read -rs LITELLM_API_KEY && export LITELLM_API_KEY      # virtual key do portal
//   export LITELLM_URL=https://litellm.empresa.com.br
//   export LITELLM_MODEL=claude-opus                        # nome do modelo no LiteLLM
//   export LITELLM_TEAM_KEYS="checkout-team=sk-...,platform-team=sk-..."   # opcional
//   node scripts/check-litellm.mjs [--route messages|passthrough] [--no-calls]
//
// Sem --no-calls, faz ~8 chamadas mínimas ao modelo (max_tokens 8): custo de centavos.
// Certificado de CA interna: export NODE_EXTRA_CA_CERTS=/caminho/ca-corporativa.pem

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

const URL_BASE = (process.env.LITELLM_URL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.LITELLM_API_KEY ?? '';
const MODEL = process.env.LITELLM_MODEL ?? 'claude-opus-5-5';
const ROUTE = opt('--route', 'messages');
const CALLS = !flag('--no-calls');
const TEAM_KEYS = Object.fromEntries(
  (process.env.LITELLM_TEAM_KEYS ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]),
);

if (!URL_BASE || !API_KEY || !['messages', 'passthrough'].includes(ROUTE)) {
  console.error('Defina LITELLM_URL e LITELLM_API_KEY (veja o topo do script). --route: messages | passthrough');
  process.exit(2);
}

const ok = msg => console.log(`  ✔ ${msg}`);
const warn = msg => console.log(`  ! ${msg}`);
const fail = msg => console.log(`  ✘ ${msg}`);
const section = title => console.log(`\n${title}`);
const short = text => String(text ?? '').replace(/\s+/g, ' ').slice(0, 220);

const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
]);

async function call(path, { key = API_KEY, method = 'GET', body, headers = {} } = {}) {
  try {
    const res = await fetch(`${URL_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, text, json };
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    return { status: 0, ok: false, text: `${code ?? ''} ${err?.cause?.message ?? err.message}`, code };
  }
}

const errorMessage = r =>
  short(r.json?.error?.message ?? r.json?.detail?.error ?? r.json?.detail ?? r.text);

const results = { features: {}, blockers: [], validTeams: [] };

// 1. Conectividade e certificado
section(`1. Conectividade (${URL_BASE})`);
const live = await call('/health/liveliness');
if (live.ok) {
  ok('LiteLLM respondeu');
} else if (TLS_CODES.has(live.code)) {
  fail(`certificado não confiável (${live.code})`);
  console.log(
    '    O LiteLLM usa uma CA interna. Exporte o certificado da CA e rode com:\n' +
      '    NODE_EXTRA_CA_CERTS=/caminho/ca-corporativa.pem node scripts/check-litellm.mjs\n' +
      '    O portal precisa da mesma variável (veja o README, seção LiteLLM corporativo).',
  );
  process.exit(1);
} else {
  fail(`sem resposta: ${short(live.text)} (HTTP ${live.status})`);
  process.exit(1);
}
if (process.env.NODE_EXTRA_CA_CERTS) ok(`CA extra em uso: ${process.env.NODE_EXTRA_CA_CERTS}`);
const ready = await call('/health/readiness');
if (ready.json?.litellm_version) ok(`versão do LiteLLM: ${ready.json.litellm_version}`);

// 2. Key do portal
section('2. Key do portal (LITELLM_API_KEY)');
const keyInfo = await call('/key/info');
if (!keyInfo.ok) {
  fail(`key recusada: ${errorMessage(keyInfo)} (HTTP ${keyInfo.status})`);
  process.exit(1);
}
const info = keyInfo.json?.info ?? {};
ok(`key válida${info.key_alias ? ` (${info.key_alias})` : ''}${info.team_id ? `, team ${info.team_id}` : ''}`);
if (typeof info.max_budget === 'number') ok(`orçamento da key: US$ ${info.max_budget} (gasto US$ ${Number(info.spend ?? 0).toFixed(4)})`);
if (Array.isArray(info.models) && info.models.length) ok(`modelos liberados para a key: ${info.models.join(', ')}`);

// 3. Modelos
section('3. Modelos');
const models = await call('/v1/models');
const ids = (models.json?.data ?? []).map(m => m.id);
if (ids.length) ok(`disponíveis: ${ids.join(', ')}`);
if (ROUTE === 'messages') {
  if (ids.includes(MODEL)) ok(`modelo ${MODEL} encontrado`);
  else {
    fail(`modelo ${MODEL} não está na lista (defina LITELLM_MODEL com um dos nomes acima)`);
    results.blockers.push('modelo');
  }
}

// 4. Recursos da Messages API
const messagesPath = ROUTE === 'messages' ? '/v1/messages' : '/anthropic/v1/messages';
section(`4. Messages API (${messagesPath}, modelo ${MODEL})`);
const base = { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'Responda só: ok' }] };
const anthropicHeaders = { 'anthropic-version': '2023-06-01' };
const probe = async (label, body, headers = {}) => {
  const r = await call(messagesPath, {
    method: 'POST',
    body: { ...base, ...body },
    headers: { ...anthropicHeaders, ...headers },
  });
  if (r.ok) ok(label);
  else fail(`${label}: ${errorMessage(r)} (HTTP ${r.status})`);
  return r.ok;
};

if (!CALLS) {
  warn('--no-calls: chamadas ao modelo puladas');
} else if (results.blockers.length === 0) {
  if (!(await probe('chamada básica', {}))) {
    results.blockers.push('chamada básica');
  } else {
    // Streaming: o agente sempre usa.
    const s = await fetch(`${URL_BASE}${messagesPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...anthropicHeaders },
      body: JSON.stringify({ ...base, stream: true }),
    }).catch(err => ({ ok: false, statusText: err.message }));
    const sText = s.ok ? await s.text() : '';
    if (s.ok && sText.includes('message_stop')) ok('streaming (SSE)');
    else {
      fail(`streaming: ${short(sText || s.statusText)}`);
      results.blockers.push('streaming');
    }
    const tool = {
      name: 'listar_servicos',
      description: 'Lista serviços',
      input_schema: { type: 'object', properties: {} },
    };
    if (!(await probe('tools', { tools: [tool] }))) results.blockers.push('tools');
    results.features.eagerToolStreaming = await probe('tools com eager_input_streaming', {
      tools: [{ ...tool, eager_input_streaming: true }],
    });
    results.features.effort = await probe('output_config.effort', { output_config: { effort: 'low' } });
    results.features.promptCaching = await probe('cache_control', { cache_control: { type: 'ephemeral' } });
    results.features.serverSideFallback = await probe(
      'fallback no servidor (só API da Anthropic)',
      { fallbacks: 'default' },
      { 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    );
    results.sendMetadata = await probe('metadata + litellm_metadata (atribuição por usuário/time)', {
      metadata: { user_id: 'user:default/check-litellm' },
      litellm_metadata: { user: 'user:default/check-litellm', tags: ['app:backstage-agent', 'check:litellm'] },
    });
  }
}

// 5. Keys dos times (modo external)
const teamEntries = Object.entries(TEAM_KEYS);
if (teamEntries.length) {
  section('5. Keys dos times (LITELLM_TEAM_KEYS)');
  for (const [team, key] of teamEntries) {
    const ki = await call('/key/info', { key });
    if (!ki.ok) {
      fail(`${team}: key recusada (${errorMessage(ki)}, HTTP ${ki.status})`);
      continue;
    }
    results.validTeams.push(team);
    const k = ki.json?.info ?? {};
    let budget = typeof k.max_budget === 'number' ? `orçamento da key US$ ${k.max_budget}` : '';
    if (k.team_id) {
      const ti = await call(`/team/info?team_id=${encodeURIComponent(k.team_id)}`, { key });
      const t = ti.json?.team_info;
      if (ti.ok && typeof t?.max_budget === 'number') {
        budget = `orçamento do team US$ ${t.max_budget}, gasto US$ ${Number(t.spend ?? 0).toFixed(2)}, renova ${t.budget_reset_at ?? '–'}`;
      } else if (!ti.ok) {
        warn(`${team}: a key não lê o team ${k.team_id} (HTTP ${ti.status}); o painel usará o orçamento da key`);
      }
    }
    if (budget) ok(`${team}: team ${k.team_id ?? '(nenhum)'}; ${budget}`);
    else warn(`${team}: team ${k.team_id ?? '(nenhum)'} sem orçamento definido (o LiteLLM não vai bloquear)`);
  }
}

// Resumo
section('Resultado');
if (results.blockers.length) {
  fail(`o agente não vai funcionar nesta rota: ${results.blockers.join(', ')}`);
  process.exit(1);
}
if (!CALLS) {
  warn('rode sem --no-calls para descobrir os recursos aceitos');
  process.exit(0);
}
ok('o agente funciona com esta rota. Bloco sugerido para o app-config:');
const f = results.features;
const yaml = [
  'agent:',
  '  gateway:',
  '    type: litellm',
  `    baseUrl: ${URL_BASE}`,
  '    apiKey: ${LITELLM_PORTAL_KEY}',
  `    route: ${ROUTE}`,
  ...(ROUTE === 'messages' ? [`    model: ${MODEL}`] : []),
  '    features:',
  `      serverSideFallback: ${f.serverSideFallback}`,
  `      effort: ${f.effort}`,
  `      eagerToolStreaming: ${f.eagerToolStreaming}`,
  `      promptCaching: ${f.promptCaching}`,
  ...(results.sendMetadata ? [] : ['    sendMetadata: false']),
  ...(results.validTeams.length
    ? ['    teamKeys:', ...results.validTeams.map(team => `      ${team}: \${LITELLM_KEY_${team.toUpperCase().replace(/[^A-Z0-9]/g, '_')}}`)]
    : []),
];
console.log(`\n${yaml.join('\n')}\n`);
if (!f.effort) warn('sem effort: o modelo usa o esforço padrão do provedor');
if (!f.promptCaching) warn('sem cache de prompt: cada chamada paga o prompt inteiro (custo maior)');
