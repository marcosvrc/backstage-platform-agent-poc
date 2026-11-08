#!/usr/bin/env bash
# Sobe o Keycloak (SSO e diretório) e prepara o realm "acme" para o portal.
#
# Uso: ./scripts/setup-keycloak.sh
#
# 1. Gera keycloak/.env (admin do Keycloak, senha dos usuários de teste, segredos
#    dos clients e da sessão do login; não versionado)
# 2. Cria o banco "keycloak" no Postgres
# 3. Sobe o Keycloak (porta 8180) importando keycloak/realm-acme.json
# 4. Lê os segredos dos clients "backstage" (login) e "backstage-catalog" (diretório)
# 5. Define a senha dos usuários de teste (ana.souza, bruno.lima, carla.mendes, diego.rocha)
#
# Depois: ./scripts/start-portal.sh --keycloak
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/keycloak/.env"
URL="http://localhost:8180"
REALM="acme"
cd "$ROOT"

# 1. Segredos locais
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    echo "KC_BOOTSTRAP_ADMIN_USERNAME=admin"
    echo "KC_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 16)"
    echo "KEYCLOAK_DEV_USER_PASSWORD=$(openssl rand -base64 12 | tr -d '/+=')"
  } > "$ENV_FILE"
  echo "Criado keycloak/.env" >&2
fi
env_get() { grep "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }
env_set() { # grava/atualiza uma variável em keycloak/.env
  grep -v "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
  echo "$1=$2" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE" && chmod 600 "$ENV_FILE"
}

# 2. Banco do Keycloak
docker compose up -d --wait postgres >/dev/null
if ! docker compose exec -T postgres psql -U backstage -tAc "SELECT 1 FROM pg_database WHERE datname='keycloak'" | grep -q 1; then
  docker compose exec -T postgres createdb -U backstage keycloak
  echo "Criado o banco keycloak" >&2
fi

# 3. Keycloak
docker compose --profile keycloak up -d keycloak >/dev/null
printf 'Aguardando o Keycloak' >&2
for _ in $(seq 1 90); do
  curl -sf "$URL/realms/$REALM/.well-known/openid-configuration" >/dev/null 2>&1 && break
  printf '.' >&2; sleep 2
done
echo >&2
curl -sf "$URL/realms/$REALM/.well-known/openid-configuration" >/dev/null || {
  echo "O Keycloak não ficou pronto. Veja: docker compose logs keycloak" >&2
  exit 1
}

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=($1)(JSON.parse(s));if(v!==undefined)process.stdout.write(String(v))})"; }
TOKEN="$(curl -sf "$URL/realms/master/protocol/openid-connect/token" \
  -d grant_type=password -d client_id=admin-cli \
  --data-urlencode "username=$(env_get KC_BOOTSTRAP_ADMIN_USERNAME)" \
  --data-urlencode "password=$(env_get KC_BOOTSTRAP_ADMIN_PASSWORD)" | json 'd=>d.access_token')"
api() { curl -sf "$URL/admin/realms/$REALM$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "${@:2}"; }

# 4. Segredos dos clients (gerados pelo Keycloak na importação)
client_secret() {
  local id
  id="$(api "/clients?clientId=$1" | json 'd=>d[0]?.id')"
  local secret
  secret="$(api "/clients/$id/client-secret" | json 'd=>d.value')"
  if [ -z "$secret" ]; then
    secret="$(api "/clients/$id/client-secret" -X POST | json 'd=>d.value')"
  fi
  printf '%s' "$secret"
}
env_set KEYCLOAK_BACKSTAGE_CLIENT_SECRET "$(client_secret backstage)"
env_set KEYCLOAK_CATALOG_CLIENT_SECRET "$(client_secret backstage-catalog)"
# Segredo da sessão do auth-backend (usada pelo login OIDC). Mantém o existente.
[ -n "$(env_get BACKSTAGE_AUTH_SESSION_SECRET)" ] ||
  env_set BACKSTAGE_AUTH_SESSION_SECRET "$(openssl rand -hex 32)"
echo "Segredos dos clients gravados em keycloak/.env" >&2

# 5. Senha dos usuários de teste (a mesma para todos; só para desenvolvimento local)
PASSWORD="$(env_get KEYCLOAK_DEV_USER_PASSWORD)"
for user in ana.souza bruno.lima carla.mendes diego.rocha; do
  id="$(api "/users?username=$user&exact=true" | json 'd=>d[0]?.id')"
  api "/users/$id/reset-password" -X PUT \
    -d "{\"type\":\"password\",\"value\":\"$PASSWORD\",\"temporary\":false}" >/dev/null
done

echo
echo "Pronto. Keycloak em $URL (console: $URL/admin, usuário e senha em keycloak/.env)."
echo "Usuários de teste: ana.souza, bruno.lima, carla.mendes, diego.rocha"
echo "  senha: KEYCLOAK_DEV_USER_PASSWORD em keycloak/.env"
echo "Inicie o portal com: ./scripts/start-portal.sh --keycloak"
