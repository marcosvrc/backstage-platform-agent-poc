#!/usr/bin/env bash
# Cria (ou atualiza) os dois Secrets que o chart usa, a partir de arquivos locais.
#
# Uso: deploy/create-secrets.sh <namespace> [secrets.env] [pasta-de-arquivos]
#   secrets.env         padrão: deploy/secrets.env (modelo: deploy/secrets.env.example)
#   pasta-de-arquivos   padrão: deploy/secret-files, com:
#                         github-app-private-key.pem  (chave do GitHub App)
#                         litellm-team-keys.yaml      ("time: key" por linha; {} se ainda não houver)
#
# Os nomes seguem o values.yaml: backstage-portal-env e backstage-portal-files.
# Em produção, o ideal é o pipeline gerar esses Secrets a partir do cofre.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NS="${1:?Informe o namespace}"
ENV_FILE="${2:-$ROOT/deploy/secrets.env}"
FILES_DIR="${3:-$ROOT/deploy/secret-files}"
ENV_SECRET="${ENV_SECRET:-backstage-portal-env}"
FILES_SECRET="${FILES_SECRET:-backstage-portal-files}"

[ -f "$ENV_FILE" ] || { echo "Arquivo não encontrado: $ENV_FILE (veja deploy/secrets.env.example)" >&2; exit 1; }
for f in github-app-private-key.pem litellm-team-keys.yaml; do
  [ -f "$FILES_DIR/$f" ] || { echo "Falta $FILES_DIR/$f" >&2; exit 1; }
done
# Nenhuma variável obrigatória pode ficar vazia.
missing="$(grep -E '^[A-Z_]+=$' "$ENV_FILE" | cut -d= -f1 || true)"
[ -z "$missing" ] || { echo "Variáveis vazias em $ENV_FILE: $missing" >&2; exit 1; }

kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"
kubectl -n "$NS" create secret generic "$ENV_SECRET" --from-env-file="$ENV_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create secret generic "$FILES_SECRET" \
  --from-file=github-app-private-key.pem="$FILES_DIR/github-app-private-key.pem" \
  --from-file=litellm-team-keys.yaml="$FILES_DIR/litellm-team-keys.yaml" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "Secrets $ENV_SECRET e $FILES_SECRET prontos em $NS." >&2
