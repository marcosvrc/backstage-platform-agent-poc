#!/usr/bin/env bash
# Sobe o LiteLLM (gateway de IA) e aponta o Platform Agent para ele.
#
# Uso: ./scripts/setup-gateway.sh
#
# 1. Gera gateway/.env (master key, salt key e a chave da Anthropic; não versionado)
# 2. Cria o banco "litellm" no Postgres da POC
# 3. Sobe o container do LiteLLM (porta 4000)
# 4. Emite uma virtual key para o portal (key_alias backstage-agent)
# 5. Emite uma key de administração para o portal (usuário backstage-portal,
#    papel proxy_admin): o portal cria um team por time do catálogo, com orçamento
# 6. Grava agent.gateway em portal/app-config.local.yaml
#
# Depois, reinicie o portal: ./scripts/start-portal.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/gateway/.env"
LOCAL_CFG="$ROOT/portal/app-config.local.yaml"
URL="http://localhost:4000"
cd "$ROOT"

yaml_get() { # lê um valor do app-config.local.yaml (vazio se não existir)
  [ -f "$LOCAL_CFG" ] || return 0
  node -e '
    const Y = require(process.argv[1] + "/portal/node_modules/yaml");
    const d = Y.parse(require("fs").readFileSync(process.argv[2], "utf8")) ?? {};
    const v = process.argv[3].split(".").reduce((o, k) => o?.[k], d);
    if (v !== undefined && v !== null) process.stdout.write(String(v));
  ' "$ROOT" "$LOCAL_CFG" "$1"
}

# 1. Chave da Anthropic: ambiente ou agent.anthropicApiKey do app-config.local.yaml
ANTHROPIC_KEY="${ANTHROPIC_API_KEY:-$(yaml_get agent.anthropicApiKey)}"
if [ -z "$ANTHROPIC_KEY" ]; then
  echo "Defina ANTHROPIC_API_KEY (ou agent.anthropicApiKey em portal/app-config.local.yaml)." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 24)"
    echo "LITELLM_SALT_KEY=sk-$(openssl rand -hex 24)"
    echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY"
  } > "$ENV_FILE"
  echo "Criado gateway/.env" >&2
else
  # Mantém as chaves do LiteLLM e atualiza só a da Anthropic.
  grep -v '^ANTHROPIC_API_KEY=' "$ENV_FILE" > "$ENV_FILE.tmp"
  echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE" && chmod 600 "$ENV_FILE"
fi
MASTER_KEY="$(grep '^LITELLM_MASTER_KEY=' "$ENV_FILE" | cut -d= -f2-)"

# 2. Banco do LiteLLM
docker compose up -d --wait postgres >/dev/null
if ! docker compose exec -T postgres psql -U backstage -tAc "SELECT 1 FROM pg_database WHERE datname='litellm'" | grep -q 1; then
  docker compose exec -T postgres createdb -U backstage litellm
  echo "Criado o banco litellm" >&2
fi

# 3. LiteLLM
docker compose --profile gateway up -d litellm >/dev/null
printf 'Aguardando o LiteLLM' >&2
for _ in $(seq 1 90); do
  curl -sf "$URL/health/readiness" >/dev/null 2>&1 && break
  printf '.' >&2; sleep 2
done
echo >&2
curl -sf "$URL/health/readiness" >/dev/null || {
  echo "O LiteLLM não ficou pronto. Veja: docker compose logs litellm" >&2
  exit 1
}

# 4. Virtual key do portal (reaproveita se já estiver configurada e válida)
PORTAL_KEY="$(yaml_get agent.gateway.apiKey)"
if [ -n "$PORTAL_KEY" ] && curl -sf "$URL/key/info" -H "Authorization: Bearer $PORTAL_KEY" >/dev/null; then
  echo "Virtual key do portal já configurada." >&2
else
  PORTAL_KEY="$(curl -sf "$URL/key/generate" \
    -H "Authorization: Bearer $MASTER_KEY" -H 'Content-Type: application/json' \
    -d '{"key_alias":"backstage-agent","metadata":{"app":"backstage-platform-agent"}}' |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))')"
  echo "Emitida a virtual key do portal (backstage-agent)." >&2
fi

# 5. Key de administração do portal (orçamento por time). Não é a master key: pode ser revogada sozinha.
ADMIN_KEY="$(yaml_get agent.gateway.adminKey)"
if [ -n "$ADMIN_KEY" ] && curl -sf "$URL/team/list" -H "Authorization: Bearer $ADMIN_KEY" >/dev/null; then
  echo "Key de administração do portal já configurada." >&2
else
  admin_api() { curl -sf "$URL$1" -H "Authorization: Bearer $MASTER_KEY" -H 'Content-Type: application/json' "${@:2}"; }
  admin_api "/user/info?user_id=backstage-portal" >/dev/null 2>&1 ||
    admin_api /user/new -d '{"user_id":"backstage-portal","user_role":"proxy_admin","auto_create_key":false}' >/dev/null
  admin_api /key/delete -d '{"key_aliases":["backstage-admin"]}' >/dev/null 2>&1 || true
  ADMIN_KEY="$(admin_api /key/generate \
    -d '{"user_id":"backstage-portal","key_alias":"backstage-admin","metadata":{"app":"backstage-platform-agent","purpose":"team budgets"}}' |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))')"
  echo "Emitida a key de administração do portal (backstage-admin)." >&2
fi

# 6. app-config.local.yaml -> agent.gateway
node -e '
  const fs = require("fs");
  const Y = require(process.argv[1] + "/portal/node_modules/yaml");
  const file = process.argv[2];
  const doc = fs.existsSync(file) ? Y.parseDocument(fs.readFileSync(file, "utf8")) : new Y.Document({});
  doc.setIn(["agent", "gateway"], doc.createNode({
    type: "litellm",
    baseUrl: process.argv[3],
    apiKey: process.argv[4],
    adminKey: process.argv[5],
    tags: ["app:backstage-agent"],
  }));
  fs.writeFileSync(file, doc.toString(), { mode: 0o600 });
' "$ROOT" "$LOCAL_CFG" "$URL" "$PORTAL_KEY" "$ADMIN_KEY"

echo
echo "Pronto. LiteLLM em $URL (painel: $URL/ui, login com a LITELLM_MASTER_KEY de gateway/.env)."
echo "Reinicie o portal para usar o gateway: ./scripts/start-portal.sh"
