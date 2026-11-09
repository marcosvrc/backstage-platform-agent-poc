# Deploy do portal (Kubernetes + Helm)

## Visão geral

| Peça | Onde | Observação |
|---|---|---|
| Imagem | `ghcr.io/<dono>/<repo>`, publicada pelo workflow `.github/workflows/portal.yml` | Tags `sha-<commit>` e `latest` a cada push na `master` |
| Configuração base | `portal/app-config.yaml` + `portal/app-config.production.yaml`, dentro da imagem | Sem segredos nem URLs |
| Opções do ambiente | `values.yaml` do chart (`portal.*` e `appConfig`) | URLs, organização, modelo, recursos do LiteLLM |
| Segredos | Dois Secrets do Kubernetes, criados à parte | O chart só os referencia |
| Banco | Postgres da empresa | O Backstage cria um banco por plugin (o usuário precisa de `CREATEDB`) |
| SSO, diretório, gateway | Keycloak e LiteLLM da empresa | Por HTTPS; CA interna em `caBundle` |

## 1. Pré-requisitos

- **Postgres:** usuário com permissão `CREATEDB`, porque o Backstage cria um banco por plugin (`backstage_plugin_catalog`, `backstage_plugin_agent`...).
- **Keycloak (realm da empresa):**
  - client confidencial `backstage` (login), com redirect `https://<portal>/api/auth/oidc/handler/frame` e o papel `offline_access` no escopo;
  - client `backstage-catalog` (conta de serviço) com `query-groups`, `query-users` e `view-users` de `realm-management`. No Keycloak 26.8+, ele também precisa do escopo `kc-admin-api`.

  O `keycloak/realm-acme.json` serve de modelo.
- **GitHub App:** só leitura de conteúdo, instalado na organização. Veja "Catálogo real" no README principal e confira com `node scripts/check-github.mjs`.
- **LiteLLM:** a key do portal e, se houver orçamento por time, uma key por team. Confira com `node scripts/check-litellm.mjs`.

## 2. Segredos

O chart espera dois Secrets no namespace:

| Secret (padrão) | Tipo | Conteúdo |
|---|---|---|
| `backstage-portal-env` | variáveis de ambiente | `POSTGRES_PASSWORD`, `BACKSTAGE_AUTH_SESSION_SECRET`, `OIDC_CLIENT_SECRET`, `KEYCLOAK_CATALOG_CLIENT_SECRET`, `GITHUB_APP_CLIENT_SECRET`, `LITELLM_PORTAL_KEY` |
| `backstage-portal-files` | arquivos em `/etc/backstage/secrets` | `github-app-private-key.pem`, `litellm-team-keys.yaml` (`time: key` por linha; `{}` se não houver keys de time) |

Para criar a partir de arquivos locais, que não são versionados:

```bash
cp deploy/secrets.env.example deploy/secrets.env        # preencha
mkdir -p deploy/secret-files
cp ~/Downloads/<app>.private-key.pem deploy/secret-files/github-app-private-key.pem
echo '{}' > deploy/secret-files/litellm-team-keys.yaml  # ou "checkout-team: sk-..." por linha
deploy/create-secrets.sh backstage
```

Em produção, o ideal é o pipeline gerar os dois Secrets a partir do cofre da empresa, com as mesmas chaves. O chart não muda.

## 3. Valores do ambiente

Crie um `values-<ambiente>.yaml` só com o que muda:

```yaml
image:
  tag: sha-abc1234
portal:
  baseUrl: https://backstage.empresa.com.br
  platformTeam: group:default/plataforma
  postgres:
    host: postgres.empresa.internal
    user: backstage
  oidc:
    metadataUrl: https://sso.empresa.com.br/realms/empresa/.well-known/openid-configuration
  keycloak:
    baseUrl: https://sso.empresa.com.br
    realm: empresa
  github:
    org: empresa
    appId: "123456"
    appClientId: Iv23li...
  litellm:
    baseUrl: https://litellm.empresa.com.br
    model: claude-opus
appConfig:
  agent:
    gateway:
      features:          # resultado do scripts/check-litellm.mjs
        effort: true
        promptCaching: true
ingress:
  enabled: true
  className: nginx
  host: backstage.empresa.com.br
caBundle:
  configMapName: ca-empresa   # se o LiteLLM/Keycloak usam CA interna
```

## 4. Instalar

```bash
helm upgrade --install portal deploy/helm/backstage-portal -n backstage -f values-prod.yaml
kubectl -n backstage rollout status deploy/portal-backstage-portal
```

Para um registry privado (GHCR com pacote privado), crie um `docker-registry` Secret e informe em `imagePullSecrets`.

## O que conferir depois

- `/.backstage/health/v1/readiness` responde 200.
- No log: `Committed N Keycloak users`, `github-provider:empresa` sem erro e `Platform Agent pronto (... gateway litellm)`.
- No portal (logado como alguém do time de plataforma): a aba **Políticas** do painel de governança mostra o gateway saudável, e a aba **Orçamento** mostra os times.

## Limites desta primeira versão

- **TechDocs** é gerado e guardado no disco do pod (`publisher: local`). Por isso, mantenha 1 réplica, ou troque o publisher por `awsS3`, `googleGcs` ou `azureBlobStorage` (configuração em `appConfig.techdocs`).
- **Templates** criam repositórios com o GitHub App da organização. Para isso, o App precisa de `Administration`, `Contents` e `Workflows` com escrita.
- **Banco:** use `PGSSLMODE=verify-full` com a CA em `caBundle` quando o Postgres exigir TLS verificado.
