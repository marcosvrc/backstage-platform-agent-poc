#!/usr/bin/env node
// Runner do conjunto de avaliação do Platform Agent.
//
// Uso (com o portal rodando e ANTHROPIC_API_KEY definida no portal):
//   node evals/run.mjs [--url http://localhost:7007] [--filter h4] [--repeat 3] [--concurrency 3]
//
// Loga como o usuário do guest do portal (veja personas/), envia cada caso ao
// /api/agent/chat e avalia a resposta com checagens determinísticas (cases.yaml).
// Pedidos de aprovação são sempre recusados: nada é criado ou removido.
// Cada caso chama o modelo de verdade, então cada execução tem custo.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../portal/package.json'));
const YAML = require('yaml');

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.BACKSTAGE_URL ?? 'http://localhost:7007' },
    filter: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '3' },
  },
});
const API = `${args.url}/api`;
const MAX_APPROVAL_ROUNDS = 3;

const normalize = s =>
  String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

async function login() {
  const res = await fetch(`${API}/auth/guest/refresh`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (!res.ok) throw new Error(`Login guest falhou: ${res.status} ${await res.text()}`);
  const { backstageIdentity } = await res.json();
  return {
    token: backstageIdentity.token,
    userRef: backstageIdentity.identity.userEntityRef,
  };
}

/** Uma chamada ao /chat; devolve os eventos já agrupados. */
async function chat(token, messages, approvals) {
  const res = await fetch(`${API}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages, approvals }),
  });
  if (!res.ok) throw new Error(`/chat respondeu ${res.status}: ${await res.text()}`);
  const out = { text: '', tools: [], approvals: [], messages, usage: undefined, error: undefined };
  const lines = (await res.text()).split('\n').filter(Boolean);
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (ev.type === 'text') out.text += ev.delta;
    else if (ev.type === 'tool_start') out.tools.push({ action: ev.action, input: ev.input });
    else if (ev.type === 'tool_end' && !ev.ok) out.tools.at(-1).error = ev.error;
    else if (ev.type === 'approval_required') out.approvals.push(...ev.pending);
    else if (ev.type === 'done') ({ messages: out.messages, usage: out.usage } = ev);
    else if (ev.type === 'error') out.error = ev.message;
  }
  return out;
}

async function runCase(token, c) {
  const started = Date.now();
  const turns = c.turns ?? [c.prompt];
  const run = { tools: [], approvals: [], finalText: '', usage: emptyUsage(), errors: [] };
  let messages = [];

  outer: for (const turn of turns) {
    messages = [...messages, { role: 'user', content: turn }];
    run.finalText = '';
    let approvals;
    for (let round = 0; round <= MAX_APPROVAL_ROUNDS; round++) {
      const r = await chat(token, messages, approvals);
      run.finalText += r.text;
      run.tools.push(...r.tools);
      addUsage(run.usage, r.usage);
      if (r.error) {
        run.errors.push(r.error);
        break outer;
      }
      messages = r.messages;
      if (r.approvals.length === 0) break;
      run.approvals.push(...r.approvals);
      // O caso espera um pedido de aprovação: já temos o que avaliar.
      if (c.expect?.approval) break outer;
      approvals = Object.fromEntries(r.approvals.map(p => [p.toolUseId, false]));
    }
  }
  run.latencyMs = Date.now() - started;
  run.failures = grade(c.expect ?? {}, run);
  return run;
}

function grade(expect, run) {
  const failures = [];
  const text = normalize(run.finalText);
  const called = new Set(run.tools.map(t => t.action));

  if (run.errors.length) failures.push(`erro: ${run.errors.join('; ')}`);
  if (expect.tools_any && !expect.tools_any.some(t => called.has(t))) {
    failures.push(`nenhuma das ações chamada: ${expect.tools_any.join(', ')}`);
  }
  for (const t of expect.forbid_tools ?? []) {
    if (called.has(t)) failures.push(`ação proibida executada: ${t}`);
  }
  for (const s of expect.contains_all ?? []) {
    if (!text.includes(normalize(s))) failures.push(`faltou "${s}"`);
  }
  if (expect.contains_any && !expect.contains_any.some(s => text.includes(normalize(s)))) {
    failures.push(`nenhum de: ${expect.contains_any.map(s => `"${s}"`).join(', ')}`);
  }
  for (const s of expect.not_contains ?? []) {
    if (text.includes(normalize(s))) failures.push(`não devia conter "${s}"`);
  }
  if (expect.approval) {
    const req = run.approvals.find(a => a.action === expect.approval.action);
    if (!req) {
      failures.push(`não pediu aprovação para ${expect.approval.action}`);
    } else {
      const input = normalize(JSON.stringify(req.input));
      for (const s of expect.approval.input_contains ?? []) {
        if (!input.includes(normalize(s))) failures.push(`entrada da aprovação sem "${s}"`);
      }
    }
  }
  return failures;
}

const emptyUsage = () => ({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
function addUsage(total, u) {
  if (!u) return;
  for (const k of Object.keys(total)) total[k] += u[k] ?? 0;
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

async function main() {
  const { cases } = YAML.parse(fs.readFileSync(path.join(here, 'cases.yaml'), 'utf8'));
  // Mensagens com ": " sem aspas viram objetos no YAML; falha antes de gastar chamadas.
  for (const c of cases) {
    for (const t of c.turns ?? [c.prompt]) {
      if (typeof t !== 'string') throw new Error(`Caso ${c.id}: mensagem não é texto (use aspas no YAML)`);
    }
  }
  const { token, userRef } = await login();
  const persona = userRef.split('/').pop();
  const repeat = Number(args.repeat);

  const selected = cases.filter(
    c =>
      (!c.personas || c.personas.includes(persona)) &&
      (!args.filter || c.id.includes(args.filter) || c.hypothesis === args.filter),
  );
  const jobs = selected.flatMap(c => Array.from({ length: repeat }, (_, i) => ({ c, i })));
  console.log(`Usuário: ${userRef} | ${selected.length} casos x ${repeat} = ${jobs.length} execuções\n`);

  const results = await pool(jobs, Number(args.concurrency), async ({ c, i }) => {
    let run;
    try {
      run = await runCase(token, c);
    } catch (err) {
      run = { failures: [`exceção: ${err.message}`], tools: [], usage: emptyUsage(), latencyMs: 0 };
    }
    const ok = run.failures.length === 0;
    const label = repeat > 1 ? `${c.id}#${i + 1}` : c.id;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${(run.latencyMs / 1000).toFixed(1).padStart(5)}s  ` +
        `${String(run.usage.inputTokens + run.usage.outputTokens).padStart(7)} tok` +
        (ok ? '' : `\n      - ${run.failures.join('\n      - ')}`),
    );
    return { id: c.id, hypothesis: c.hypothesis, attempt: i + 1, ok, ...run };
  });

  // Resumo por hipótese
  const byHyp = {};
  for (const r of results) {
    byHyp[r.hypothesis] ??= { pass: 0, total: 0 };
    byHyp[r.hypothesis].total++;
    if (r.ok) byHyp[r.hypothesis].pass++;
  }
  const usage = emptyUsage();
  results.forEach(r => addUsage(usage, r.usage));
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const pct = p => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] / 1000;

  console.log('\nPor hipótese:');
  for (const [h, s] of Object.entries(byHyp)) console.log(`  ${h.padEnd(5)} ${s.pass}/${s.total}`);
  const passed = results.filter(r => r.ok).length;
  console.log(`\nTotal: ${passed}/${results.length} (${Math.round((100 * passed) / results.length)}%)`);
  console.log(`Latência: p50 ${pct(0.5).toFixed(1)}s | p90 ${pct(0.9).toFixed(1)}s`);
  console.log(
    `Tokens: ${usage.inputTokens} entrada + ${usage.outputTokens} saída ` +
      `(cache: ${usage.cacheReadTokens} lidos, ${usage.cacheWriteTokens} gravados) em ${usage.modelCalls} chamadas`,
  );

  const outDir = path.join(here, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(
    outDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${persona}.json`,
  );
  fs.writeFileSync(file, JSON.stringify({ userRef, byHyp, usage, results }, null, 2));
  console.log(`\nResultado completo: ${path.relative(process.cwd(), file)}`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch(err => {
  console.error(err.message);
  process.exit(2);
});
