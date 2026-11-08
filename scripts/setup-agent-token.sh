#!/usr/bin/env bash
# Gera o token estático que o agente usa para acessar o MCP do Backstage.
# Uso:  ./scripts/setup-agent-token.sh            (cria se não existir)
#       eval "$(./scripts/setup-agent-token.sh)"  (também exporta BACKSTAGE_MCP_TOKEN)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/portal/app-config.local.yaml"

if [ ! -f "$CFG" ]; then
  TOKEN="$(openssl rand -hex 24)"
  sed "s/<token-gerado>/$TOKEN/" "$ROOT/portal/app-config.local.example.yaml" \
    | sed '1,2c\
# Configuração local (NÃO versionada). Gerada por scripts/setup-agent-token.sh' > "$CFG"
  echo "# Criado $CFG - reinicie o 'yarn start' para aplicar." >&2
fi

TOKEN="$(awk '/token:/ {print $2; exit}' "$CFG")"
echo "export BACKSTAGE_MCP_TOKEN=$TOKEN"
