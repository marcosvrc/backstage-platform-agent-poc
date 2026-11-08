#!/usr/bin/env bash
# Inicia o portal com as configs certas.
#
# Uso: ./scripts/start-portal.sh [persona] [--sqlite]
#   persona   ana | bruno | diego  (login guest como essa pessoa; padrão: guest, do platform-team)
#   --sqlite  banco em memória, sem Docker
#   --keycloak  SSO e diretório pelo Keycloak (rode antes ./scripts/setup-keycloak.sh)
#
# O `--config` do backstage-cli SUBSTITUI o app-config.yaml, por isso este script
# sempre passa a lista completa: app-config.yaml + local + overrides.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARGS=(--config "$ROOT/portal/app-config.yaml")

[ -f "$ROOT/portal/app-config.local.yaml" ] && ARGS+=(--config "$ROOT/portal/app-config.local.yaml")

for arg in "$@"; do
  case "$arg" in
    --sqlite) ARGS+=(--config "$ROOT/app-config.sqlite.yaml") ;;
    --keycloak)
      [ -f "$ROOT/keycloak/.env" ] || { echo "Rode antes: ./scripts/setup-keycloak.sh" >&2; exit 1; }
      ARGS+=(--config "$ROOT/app-config.keycloak.yaml")
      # Só os segredos do portal; o resto de keycloak/.env é do container.
      # (sem `source <(...)`: o bash 3.2 do macOS não lê process substitution com source)
      KC_VARS="$(grep -E '^(KEYCLOAK_(BACKSTAGE|CATALOG)_CLIENT_SECRET|BACKSTAGE_AUTH_SESSION_SECRET)=' "$ROOT/keycloak/.env")"
      while IFS='=' read -r key value; do
        [ -n "$key" ] && export "$key=$value"
      done <<< "$KC_VARS"
      for required in KEYCLOAK_BACKSTAGE_CLIENT_SECRET KEYCLOAK_CATALOG_CLIENT_SECRET BACKSTAGE_AUTH_SESSION_SECRET; do
        [ -n "${!required:-}" ] || { echo "$required ausente em keycloak/.env. Rode ./scripts/setup-keycloak.sh" >&2; exit 1; }
      done
      ;;
    *)
      PERSONA="$ROOT/personas/$arg.yaml"
      [ -f "$PERSONA" ] || { echo "Persona desconhecida: $arg (veja personas/)" >&2; exit 1; }
      ARGS+=(--config "$PERSONA")
      ;;
  esac
done

# Node 22.12+ (o módulo do Keycloak carrega ESM via require, suportado a partir do 22.12).
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' || {
  echo "Node $NODE_VERSION é antigo demais: use 22.12+ (ex.: nvm install 22 && nvm use 22)." >&2
  exit 1
}

cd "$ROOT/portal"
echo "yarn start ${ARGS[*]}" >&2
exec yarn start "${ARGS[@]}"
