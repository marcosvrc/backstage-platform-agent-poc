#!/usr/bin/env node
// Diagnóstico do catálogo real no GitHub: confere o GitHub App, a instalação na
// organização e o que o portal vai importar (repositórios com catalog-info.yaml,
// tipos de entidade, donos e problemas que impedem a importação).
//
// Uso: node scripts/check-github.mjs [--limit 300]
// Lê github/.env e github/app-private-key.pem (os mesmos arquivos do start-portal.sh).
// Não altera nada no GitHub: só leitura.
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const YAML = createRequire(join(ROOT, 'portal', 'package.json'))('yaml');
const args = process.argv.slice(2);
const limitAt = args.indexOf('--limit');
const LIMIT = (limitAt >= 0 && Number(args[limitAt + 1])) || 300;

const ok = msg => console.log(`  ✔ ${msg}`);
const warn = msg => console.log(`  ! ${msg}`);
const fail = msg => console.log(`  ✘ ${msg}`);
const section = title => console.log(`\n${title}`);

// Credenciais: as mesmas do start-portal.sh
const envFile = join(ROOT, 'github', '.env');
const keyFile = join(ROOT, 'github', 'app-private-key.pem');
if (!existsSync(envFile) || !existsSync(keyFile)) {
  console.error('Crie github/.env (veja github/.env.example) e salve a chave do App em github/app-private-key.pem.');
  process.exit(2);
}
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter(l => /^[A-Z_]+=/.test(l))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const ORG = env.GITHUB_ORG;
const APP_ID = env.GITHUB_APP_ID;
const PRIVATE_KEY = readFileSync(keyFile, 'utf8');
if (!ORG || !APP_ID) {
  console.error('Preencha GITHUB_ORG e GITHUB_APP_ID em github/.env.');
  process.exit(2);
}

const b64url = s => Buffer.from(s).toString('base64url');
function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: APP_ID }),
  )}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(PRIVATE_KEY, 'base64url');
  return `${unsigned}.${signature}`;
}

let rateRemaining;
async function gh(path, { token, method = 'GET' } = {}) {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'backstage-portal-check',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    rateRemaining = res.headers.get('x-ratelimit-remaining') ?? rateRemaining;
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    const code = err?.cause?.code ?? err?.code;
    return { status: 0, ok: false, text: `${code ?? ''} ${err?.cause?.message ?? err.message}`, code };
  }
}
const why = r => r.json?.message ?? r.text.slice(0, 200);

// 1. App
section('1. GitHub App');
let jwt;
try {
  jwt = appJwt();
} catch (err) {
  fail(`chave privada inválida (${err.message}). Use o .pem baixado em Settings > Developer settings > GitHub Apps.`);
  process.exit(1);
}
const app = await gh('/app', { token: jwt });
if (!app.ok) {
  if (/CERT|certificate/i.test(app.text)) {
    fail(`certificado recusado (${app.code}). Atrás de proxy corporativo, rode com NODE_EXTRA_CA_CERTS=/caminho/ca.pem`);
  } else {
    fail(`App recusado (HTTP ${app.status}): ${why(app)}. Confira GITHUB_APP_ID e a chave privada.`);
  }
  process.exit(1);
}
ok(`App "${app.json.name}" (id ${app.json.id})`);
const perms = app.json.permissions ?? {};
for (const [perm, need] of [
  ['contents', 'read'],
  ['metadata', 'read'],
]) {
  if (perms[perm]) ok(`permissão ${perm}: ${perms[perm]}`);
  else fail(`falta a permissão ${perm}: ${need} (Repository permissions do App)`);
}
const extra = Object.entries(perms).filter(([p, l]) => !['contents', 'metadata'].includes(p) && l === 'write');
if (extra.length) warn(`o App tem escrita em: ${extra.map(([p]) => p).join(', ')} (o catálogo só precisa de leitura)`);

// 2. Instalação na organização
section(`2. Instalação na organização ${ORG}`);
const inst = await gh(`/orgs/${encodeURIComponent(ORG)}/installation`, { token: jwt });
if (!inst.ok) {
  fail(`o App não está instalado em ${ORG} (HTTP ${inst.status}): ${why(inst)}`);
  console.log(`    Instale em https://github.com/organizations/${ORG}/settings/installations ou pela página pública do App.`);
  process.exit(1);
}
ok(`instalado (${inst.json.repository_selection === 'all' ? 'todos os repositórios' : 'repositórios selecionados'})`);
const tokenRes = await gh(`/app/installations/${inst.json.id}/access_tokens`, { token: jwt, method: 'POST' });
if (!tokenRes.ok) {
  fail(`não foi possível obter o token da instalação (HTTP ${tokenRes.status}): ${why(tokenRes)}`);
  process.exit(1);
}
const token = tokenRes.json.token;

// 3. Repositórios
section('3. Repositórios visíveis para o App');
const repos = [];
for (let page = 1; repos.length < LIMIT; page++) {
  const r = await gh(`/installation/repositories?per_page=100&page=${page}`, { token });
  if (!r.ok) {
    fail(`falha ao listar (HTTP ${r.status}): ${why(r)}`);
    process.exit(1);
  }
  repos.push(...r.json.repositories);
  if (repos.length >= r.json.total_count || r.json.repositories.length === 0) break;
}
const candidates = repos.filter(r => !r.archived && !r.fork).slice(0, LIMIT);
ok(`${repos.length} repositórios; ${candidates.length} ativos (sem arquivados e forks) serão analisados`);
if (repos.length >= LIMIT) warn(`análise limitada a ${LIMIT} (use --limit para mudar)`);

// 4. catalog-info.yaml
section('4. catalog-info.yaml na raiz (o que o portal vai importar)');
const found = [];
const problems = [];
const queue = [...candidates];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      const r = await gh(`/repos/${repo.full_name}/contents/catalog-info.yaml`, { token });
      if (r.status === 404) continue;
      if (!r.ok) {
        problems.push(`${repo.name}: não foi possível ler (HTTP ${r.status})`);
        continue;
      }
      try {
        const docs = YAML.parseAllDocuments(Buffer.from(r.json.content, 'base64').toString('utf8'))
          .map(d => d.toJSON())
          .filter(Boolean);
        found.push({ repo: repo.name, docs });
      } catch (err) {
        problems.push(`${repo.name}: YAML inválido (${err.message.split('\n')[0]})`);
      }
    }
  }),
);
const kinds = {};
const owners = {};
for (const { repo, docs } of found) {
  for (const d of docs) {
    kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
    if (['User', 'Group'].includes(d.kind)) {
      problems.push(`${repo}: define ${d.kind} "${d.metadata?.name}" (bloqueado: pessoas e times vêm só do diretório)`);
    }
    if (!d.metadata?.name) problems.push(`${repo}: entidade ${d.kind ?? '?'} sem metadata.name`);
    const owner = d.spec?.owner;
    if (owner) owners[owner] = (owners[owner] ?? 0) + 1;
    else if (['Component', 'API', 'Resource', 'System'].includes(d.kind)) {
      problems.push(`${repo}: ${d.kind} "${d.metadata?.name}" sem spec.owner`);
    }
  }
}
const pct = candidates.length ? Math.round((100 * found.length) / candidates.length) : 0;
ok(`${found.length} de ${candidates.length} repositórios têm catalog-info.yaml (${pct}%)`);
if (Object.keys(kinds).length) {
  ok(`entidades: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
}
if (Object.keys(owners).length) {
  ok(`donos citados (${Object.keys(owners).length}):`);
  for (const [owner, n] of Object.entries(owners).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${owner} (${n})`);
  }
  console.log('    Cada dono precisa existir como Group no diretório (Keycloak) com o mesmo nome;');
  console.log('    senão a entidade entra sem dono, e a política de acesso e o orçamento não a associam a um time.');
}
if (problems.length) {
  warn(`${problems.length} problema(s):`);
  for (const p of problems.slice(0, 30)) console.log(`      ${p}`);
  if (problems.length > 30) console.log(`      ... e mais ${problems.length - 30}`);
}

section('Resultado');
if (found.length === 0) {
  warn('nenhum repositório com catalog-info.yaml: o catálogo real começa vazio (só os templates)');
} else {
  ok(`pronto: ./scripts/start-portal.sh --keycloak --github importa ${found.length} repositório(s)`);
}
if (rateRemaining) ok(`limite de API restante nesta hora: ${rateRemaining}`);
