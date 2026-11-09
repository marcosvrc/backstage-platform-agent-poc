#!/usr/bin/env bash
# Inicia o portal com as configs certas.
#
# Uso: ./scripts/start-portal.sh [persona] [--sqlite] [--keycloak] [--github]
#   persona     ana | bruno | diego  (login guest como essa pessoa; padrão: guest, do platform-team)
#   --sqlite    banco em memória, sem Docker
#   --keycloak  SSO e diretório pelo Keycloak (rode antes ./scripts/setup-keycloak.sh)
#   --github    catálogo real: catalog-info.yaml dos repositórios da organização no GitHub
#               (credenciais em github/.env e github/app-private-key.pem; veja o README)
#
# Cenário real: ./scripts/start-portal.sh --keycloak --github
#
# O `--config` do backstage-cli SUBSTITUI o app-config.yaml, por isso este script
# sempre passa a lista completa: app-config.yaml + local + overrides.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARGS=(--config "$ROOT/portal/app-config.yaml")
KEYCLOAK=0
GITHUB=0

[ -f "$ROOT/portal/app-config.local.yaml" ] && ARGS+=(--config "$ROOT/portal/app-config.local.yaml")

# Exporta só as variáveis pedidas de um arquivo .env e confere se vieram preenchidas.
# (sem `source <(...)`: o bash 3.2 do macOS não lê process substitution com source)
load_env() {
  local file="$1" hint="$2"
  shift 2
  local pattern
  pattern="^($(IFS='|'; echo "$*"))="
  local vars
  vars="$(grep -E "$pattern" "$file" || true)"
  while IFS='=' read -r key value; do
    [ -n "$key" ] && export "$key=$value"
  done <<< "$vars"
  for required in "$@"; do
    [ -n "${!required:-}" ] || { echo "$required ausente em ${file#"$ROOT"/}. $hint" >&2; exit 1; }
  done
}

for arg in "$@"; do
  case "$arg" in
    --sqlite) ARGS+=(--config "$ROOT/app-config.sqlite.yaml") ;;
    --keycloak)
      KEYCLOAK=1
      [ -f "$ROOT/keycloak/.env" ] || { echo "Rode antes: ./scripts/setup-keycloak.sh" >&2; exit 1; }
      ARGS+=(--config "$ROOT/app-config.keycloak.yaml")
      # Só os segredos do portal; o resto de keycloak/.env é do container.
      load_env "$ROOT/keycloak/.env" "Rode ./scripts/setup-keycloak.sh" \
        KEYCLOAK_BACKSTAGE_CLIENT_SECRET KEYCLOAK_CATALOG_CLIENT_SECRET BACKSTAGE_AUTH_SESSION_SECRET
      ;;
    --github)
      GITHUB=1
      [ -f "$ROOT/github/.env" ] || { echo "Crie github/.env (veja github/.env.example)" >&2; exit 1; }
      [ -f "$ROOT/github/app-private-key.pem" ] || {
        echo "Salve a chave privada do GitHub App em github/app-private-key.pem" >&2
        exit 1
      }
      ARGS+=(--config "$ROOT/app-config.github.yaml")
      load_env "$ROOT/github/.env" "Veja github/.env.example" \
        GITHUB_ORG GITHUB_APP_ID GITHUB_APP_CLIENT_ID GITHUB_APP_CLIENT_SECRET
      GITHUB_APP_PRIVATE_KEY="$(cat "$ROOT/github/app-private-key.pem")"
      export GITHUB_APP_PRIVATE_KEY
      ;;
    *)
      PERSONA="$ROOT/personas/$arg.yaml"
      [ -f "$PERSONA" ] || { echo "Persona desconhecida: $arg (veja personas/)" >&2; exit 1; }
      ARGS+=(--config "$PERSONA")
      ;;
  esac
done

# Fontes do catálogo deste modo. Listas na config substituem a anterior (não somam),
# então a lista inteira é montada aqui, num arquivo gerado.
#   templates (golden paths) .......... sempre
#   catálogo fictício da Acme ......... só sem --github (o catálogo real vem do GitHub)
#   catálogo da plataforma (IA) ....... sempre (dentro do fictício ou sozinho)
#   times e pessoas (org.yaml) ........ só sem --keycloak (com ele, vêm do diretório)
#   usuário guest (guest.yaml) ........ sempre (evals e scripts locais)
GENERATED="$ROOT/.portal/app-config.catalog-locations.yaml"
mkdir -p "$(dirname "$GENERATED")"
location() { # caminho [tipos permitidos além das regras globais]
  echo "    - type: file"
  echo "      target: $ROOT/$1"
  if [ -n "${2:-}" ]; then
    echo "      rules:"
    echo "        - allow: [$2]"
  fi
}
{
  echo "# Gerado por scripts/start-portal.sh: não edite (é refeito a cada início)."
  echo "catalog:"
  echo "  locations:"
  location templates/all.yaml
  # Catálogo fictício (inclui o da plataforma) ou, no modo real, só o da plataforma.
  if [ "$GITHUB" -eq 1 ]; then location catalog/platform/all.yaml; else location catalog/all.yaml; fi
  [ "$KEYCLOAK" -eq 1 ] || location catalog/org/org.yaml "Group, User"
  location catalog/org/guest.yaml "User"
} > "$GENERATED"
ARGS+=(--config "$GENERATED")

# Node 22.12+ (o módulo do Keycloak carrega ESM via require, suportado a partir do 22.12).
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' || {
  echo "Node $NODE_VERSION é antigo demais: use 22.12+ (ex.: nvm install 22 && nvm use 22)." >&2
  exit 1
}

cd "$ROOT/portal"
echo "yarn start ${ARGS[*]}" >&2
exec yarn start "${ARGS[@]}"
