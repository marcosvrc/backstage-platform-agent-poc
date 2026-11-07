# Deploy

## Ambientes

| Ambiente | Cluster | Namespace | Aprovação |
|---|---|---|---|
| dev | `k8s-dev` | `<time>` | automática |
| staging | `k8s-stg` | `<time>` | automática após testes |
| production | `k8s-prd` | `<time>` | 1 aprovação do time dono |

## Deploy em staging

1. Faça merge na branch `main`.
2. O pipeline publica a imagem em `registry.acme.example/<servico>:<sha>`.
3. O Argo CD sincroniza automaticamente o ambiente `staging`.
4. Acompanhe em `https://argocd.acme.example/applications/<servico>-staging`.

## Rollback

Use `argocd app rollback <servico>-<ambiente>` ou reverta o commit na `main`.
