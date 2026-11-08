#!/usr/bin/env bash
# Inicia o portal com as configs certas.
#
# Uso: ./scripts/start-portal.sh [persona] [--sqlite]
#   persona   ana | bruno | diego  (login guest como essa pessoa; padrão: guest, do platform-team)
#   --sqlite  banco em memória, sem Docker
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
    *)
      PERSONA="$ROOT/personas/$arg.yaml"
      [ -f "$PERSONA" ] || { echo "Persona desconhecida: $arg (veja personas/)" >&2; exit 1; }
      ARGS+=(--config "$PERSONA")
      ;;
  esac
done

cd "$ROOT/portal"
echo "yarn start ${ARGS[*]}" >&2
exec yarn start "${ARGS[@]}"
