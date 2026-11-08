#!/usr/bin/env bash
# Verifica a política de permissões (H3) com o usuário logado no guest do portal em execução.
# Uso: ./scripts/check-permissions.sh   (com o portal iniciado por ./scripts/start-portal.sh <persona>)
#
# Não altera nada: a remoção usa um ID de location inexistente. Se a permissão for
# negada, a resposta é 403; se for permitida, é 404 (não encontrada).
set -euo pipefail
API="${BACKSTAGE_URL:-http://localhost:7007}/api"

TOKEN="$(curl -sf -X POST "$API/auth/guest/refresh" -H 'X-Requested-With: XMLHttpRequest' |
  python3 -c 'import sys,json; print(json.load(sys.stdin)["backstageIdentity"]["token"])')"
H=(-H "Authorization: Bearer $TOKEN")

status() { curl -s -o /dev/null -w '%{http_code}' "${H[@]}" "$@"; }

echo "Usuário: $(curl -sf -X POST "$API/auth/guest/refresh" -H 'X-Requested-With: XMLHttpRequest' |
  python3 -c 'import sys,json; i=json.load(sys.stdin)["backstageIdentity"]["identity"]; print(i["userEntityRef"], "| ownership:", ", ".join(i["ownershipEntityRefs"]))')"
echo

check() { printf '  %-58s %s\n' "$1" "$2"; }

echo "Leitura do catálogo"
check "orders-db (checkout-team, não restrito)" \
  "$(status "$API/catalog/entities/by-name/resource/default/orders-db")"
check "payments-db (payments-team, restrito)" \
  "$(status "$API/catalog/entities/by-name/resource/default/payments-db")"
COUNT="$(curl -s "${H[@]}" "$API/catalog/entities?filter=kind=resource" |
  python3 -c 'import sys,json; print(", ".join(sorted(e["metadata"]["name"] for e in json.load(sys.stdin))))')"
check "Resources visíveis" "$COUNT"

echo
echo "Remoção de location (catalog:unregister-entity)"
check "DELETE location inexistente (403 = negado, 404 = permitido)" \
  "$(status -X DELETE "$API/catalog/locations/00000000-0000-0000-0000-000000000000")"
