# Integrações e como trocá-las

O portal fala com cada tecnologia externa por um **ponto de troca** (uma interface ou um padrão aberto). A lógica do agente, a política de permissões e a governança enxergam só esse ponto, nunca a tecnologia. Trocar uma tecnologia significa trocar o conector e a configuração. O resto do código não muda.

Onde o próprio Backstage já tem um ponto de troca (banco de dados, auditoria, notificações, provedores de login), usamos o dele. Criamos conectores próprios só onde o código é nosso: o modelo de IA e o orçamento.

## Mapa

| Integração | Ponto de troca | Conector atual | Para trocar | Esforço |
|---|---|---|---|---|
| Modelo de IA (gateway) | `ModelGateway` + `agentGatewaysExtensionPoint` (`plugins/agent-node`) | `agent-backend-module-litellm` (LiteLLM) e `agent-backend-module-anthropic` (API direta) | Criar um módulo novo e mudar `agent.gateway.type` | Baixo a médio |
| Orçamento de IA por time | `GatewayBudgets`, recurso opcional do conector de modelo | LiteLLM (`adminKey` ou `teamKeys`) | Vem junto com o conector. Sem ele, o orçamento fica desligado e o resto funciona | Junto com o conector |
| Login (SSO) | OIDC, padrão aberto (provider `oidc` do auth-backend) | Keycloak (`app-config.keycloak.yaml`) | Só configuração: Entra ID, Okta, Google ou outro OIDC | Baixo |
| Diretório (pessoas e times) | Entity provider do catálogo (`User` e `Group`) | `catalog-backend-module-keycloak` | Trocar o módulo: `msgraph` (Entra ID), `ldap`, `gcp`, GitHub ou GitLab org | Baixo |
| Fonte do catálogo (serviços, APIs, sistemas) | Entity provider do catálogo + `catalog-info.yaml` (formato do Backstage) | `catalog-backend-module-github` com GitHub App (`app-config.github.yaml`) | Trocar o módulo: `gitlab`, `bitbucket-cloud`, `bitbucket-server`, `azure` (Azure DevOps). Os `catalog-info.yaml` não mudam | Baixo |
| Banco de dados | `coreServices.database` (knex) | Postgres (SQLite em teste) | Configuração (`backend.database`). O SQL do agente é portável | Baixo |
| Auditoria | `coreServices.auditor` | Log do backend | Implementar o serviço de auditoria para Splunk, Datadog, SIEM etc. | Médio |
| Alertas | Plugin de notificações (processors) | Sino do Backstage | Módulos prontos de e-mail e Slack, ou um processor próprio | Baixo |
| Ações do Backstage (MCP) | Actions Registry | Catálogo, Scaffolder e ações próprias | Ações novas entram pelo registro; o agente e o MCP passam a vê-las sozinhos | Baixo |

A regra que mantém isso funcionando: **a política de permissões, o orçamento e o painel só conhecem `User` e `Group` do catálogo e as interfaces acima**. Nenhum deles cita Keycloak, LiteLLM ou Postgres.

## Modelo de IA: criar um conector

1. Crie um pacote `plugins/agent-backend-module-<nome>` (role `backend-plugin-module`, pluginId `agent`). Use `agent-backend-module-anthropic` como modelo, que é o menor.
2. Implemente `ModelGateway` (de `@internal/backstage-plugin-agent-node`):

   | Método | Para quê |
   |---|---|
   | `client()` | Cliente do SDK da Anthropic apontado para o destino |
   | `model(logical)` | Nome do modelo no destino (ex.: alias no gateway) |
   | `features()` | Quais recursos da Messages API o destino aceita (fallback, effort, cache, tools em streaming) |
   | `requestExtras(caller)` | Atribuição (usuário, time, pedido) e credencial por chamada |
   | `health()` | Verificação de saúde para o painel |
   | `describe()` | Nome e URL para o painel (sem segredos) |
   | `describeError(err)` | Opcional: mensagem em português para erros do destino |
   | `budgets` | Opcional: orçamento por time (`managed` ou `external`) |

3. Registre o conector no ponto de extensão:

   ```ts
   export default createBackendModule({
     pluginId: 'agent',
     moduleId: 'meu-gateway',
     register(reg) {
       reg.registerInit({
         deps: { gateways: agentGatewaysExtensionPoint },
         async init({ gateways }) {
           gateways.addGateway('meu-gateway', ({ config }) => new MeuGateway(config));
         },
       });
     },
   });
   ```

4. Declare as chaves de configuração do conector no `config.d.ts` do módulo.
5. No backend, rode `backend.add(import('<pacote>'))` e mude `agent.gateway.type: meu-gateway`.

O agente continua usando o formato da Messages API da Anthropic. Um conector para outro formato (por exemplo, OpenAI) teria de converter as mensagens e as tools. Isso é possível, mas é bem mais trabalho, e hoje não é o caso.

## Login: trocar o provedor de SSO

O login usa OIDC, então trocar o provedor é só configuração. Crie um `app-config.<provedor>.yaml` como o `app-config.keycloak.yaml`:

```yaml
app:
  signIn:
    providers: [oidc]
    oidc:
      title: Login corporativo
      message: Entre com sua conta da empresa
auth:
  session:
    secret: ${BACKSTAGE_AUTH_SESSION_SECRET}
  providers:
    oidc:
      production:
        metadataUrl: https://<provedor>/.well-known/openid-configuration
        clientId: ${OIDC_CLIENT_ID}
        clientSecret: ${OIDC_CLIENT_SECRET}
        signIn:
          resolvers:
            - resolver: emailMatchingUserEntityProfileEmail
```

O resolver liga o login ao `User` do catálogo pelo e-mail. Por isso, o diretório (abaixo) precisa trazer o e-mail de cada pessoa.

## Diretório: trocar a origem de pessoas e times

| Origem | Módulo do catálogo |
|---|---|
| Keycloak (atual) | `@backstage-community/plugin-catalog-backend-module-keycloak` |
| Entra ID / Azure AD | `@backstage/plugin-catalog-backend-module-msgraph` |
| LDAP / Active Directory | `@backstage/plugin-catalog-backend-module-ldap` |
| GitHub org | `@backstage/plugin-catalog-backend-module-github-org` |
| GitLab | `@backstage/plugin-catalog-backend-module-gitlab-org` |

Antes de trocar, garanta que:
- **Os times mantenham os mesmos nomes de `Group`**, ou ajuste `organization.platformTeam`, `agent.governance.budgets.teams` e `agent.gateway.teamKeys`.
- **Cada `User` tenha `spec.profile.email`**, que é usado pelo login.

## Fonte do catálogo: trocar o provedor de repositórios

O conteúdo do catálogo é o `catalog-info.yaml` de cada repositório, que é formato do Backstage e não depende do provedor. Trocar o GitHub por outro provedor significa trocar o módulo e a credencial em `integrations`:

| Provedor | Módulo do catálogo | Chave em `catalog.providers` |
|---|---|---|
| GitHub (atual) | `@backstage/plugin-catalog-backend-module-github` | `github` |
| GitLab | `@backstage/plugin-catalog-backend-module-gitlab` | `gitlab` |
| Bitbucket Cloud | `@backstage/plugin-catalog-backend-module-bitbucket-cloud` | `bitbucketCloud` |
| Bitbucket Server | `@backstage/plugin-catalog-backend-module-bitbucket-server` | `bitbucketServer` |
| Azure DevOps | `@backstage/plugin-catalog-backend-module-azure` | `azureDevOps` |

As regras valem para qualquer provedor: repositórios não criam `User` nem `Group` (`catalog.rules`), e cada `spec.owner` precisa existir no diretório.

## Banco de dados

O plugin do agente usa só o `coreServices.database` do Backstage. As migrações (`plugins/agent-backend/migrations`) e as consultas evitam recursos específicos de um banco, e os agregados do painel são calculados no Node, não no SQL. Trocar de banco é configuração de `backend.database`. Os testes rodam em SQLite e o portal em Postgres.

## Conectores de infraestrutura local

Os arquivos abaixo existem só para o ambiente de desenvolvimento. Cada um é específico de uma tecnologia, mas nenhum código do portal depende deles.

| Arquivo | Para quê |
|---|---|
| `docker-compose.yml` | Postgres, LiteLLM (profile `gateway`) e Keycloak (profile `keycloak`) |
| `scripts/setup-gateway.sh` | LiteLLM local com orçamento gerenciado pelo portal |
| `scripts/check-litellm.mjs` | Diagnóstico de um LiteLLM real (o da empresa) |
| `scripts/setup-keycloak.sh` + `keycloak/realm-acme.json` | Keycloak local com usuários de teste |
| `app-config.keycloak.yaml` | SSO e diretório pelo Keycloak (`./scripts/start-portal.sh --keycloak`) |
| `app-config.github.yaml` + `github/` | Catálogo real pelo GitHub App (`--github`) |
| `scripts/check-github.mjs` | Diagnóstico do GitHub App e do que será importado |
