# backstage-platform-agent-poc

POC do Backstage como base de uma **ADP (Agentic Developer Platform)**: um agente de IA que ajuda desenvolvedores a usar a plataforma interna. Ele consulta o catálogo, cria serviços a partir de golden paths, responde com base no TechDocs e verifica se os serviços seguem os padrões.

O Backstage é a **fonte de verdade** e a **camada de ações** do agente. As ações registradas no Actions Registry ficam disponíveis como um servidor **MCP** (`@backstage/plugin-mcp-actions-backend`) em `http://localhost:7007/api/mcp-actions/v1`.

```
Agente (Claude Code / chat no portal)  ──MCP──►  Backstage
                                                  ├─ Software Catalog
                                                  ├─ Scaffolder (golden paths)
                                                  ├─ TechDocs
                                                  └─ Actions Registry + Permissions
```

## Hipóteses

| # | Hipótese |
|---|---|
| H1 | O agente responde corretamente sobre ownership, dependências e APIs usando o catálogo |
| H2 | O agente cria um serviço novo via template, ponta a ponta |
| H3 | O agente respeita as permissões do usuário |
| H4 | O agente responde dúvidas usando o TechDocs |

## Estrutura

```
.
├── portal/                  # app Backstage (create-app, Backstage 1.56)
├── catalog/                 # catálogo fictício da "Acme"
│   ├── all.yaml             # Location de entrada
│   ├── org/                 # Groups e Users (org.yaml: modo guest; guest.yaml: usuário de dev)
│   ├── systems/             # Domain e Systems
│   ├── apis/                # APIs (OpenAPI / AsyncAPI)
│   ├── resources/           # bancos e tópicos
│   └── components/          # serviços (+ TechDocs)
├── templates/               # golden paths do Scaffolder (Node e Java)
├── evals/                   # conjunto de avaliação do agente (casos + runner)
├── gateway/litellm/         # config do LiteLLM (gateway de IA)
├── keycloak/                # realm "acme" do Keycloak (SSO e diretório)
├── personas/                # logins de teste (ana, bruno, diego) para validar permissões
├── scripts/                 # start-portal, setup-keycloak, setup-gateway, setup-agent-token, check-permissions
├── docs/                    # relatório de go/no-go
├── docker-compose.yml       # Postgres, LiteLLM e Keycloak locais
├── app-config.keycloak.yaml # override: SSO e diretório pelo Keycloak
└── app-config.sqlite.yaml   # override para rodar sem Docker
```

### Catálogo fictício

- **Times:** `platform-team`, `checkout-team`, `payments-team`
- **Sistemas:** `checkout`, `payments`, `developer-platform`
- **Serviços:** `order-service`, `payment-service`, `inventory-service`, `cart-web`, `notification-worker`, `platform-handbook`

Alguns componentes estão **fora do padrão de propósito**, para testar o caso de uso de conformidade. As regras estão em `catalog/components/platform-handbook/docs/standards.md`.

- `inventory-service`: sem TechDocs, lifecycle `experimental`
- `notification-worker`: sem `description`, sem `system`, sem TechDocs, lifecycle `deprecated`

O `payments-db` tem a label `acme.example/data-classification: restricted`: só o `payments-team` consegue vê-lo (veja [Permissões](#permissões-h3)).

## Como rodar

Pré-requisitos: Node 22.12+ ou 24 (`nvm use` em `portal/`), Yarn (`corepack enable`) e Docker.

```bash
# 1. Postgres
docker compose up -d

# 2. Portal
(cd portal && yarn install)
export GITHUB_TOKEN=<PAT com escopo repo>   # necessário para os templates publicarem no GitHub
export ANTHROPIC_API_KEY=sk-ant-...         # necessário para o chat do agente
./scripts/start-portal.sh
```

- Frontend: http://localhost:3000 (login como **guest**, membro do `platform-team`)
- Backend: http://localhost:7007

Variações:

```bash
./scripts/start-portal.sh bruno      # login como bruno.lima (checkout-team); também: ana, diego
./scripts/start-portal.sh --sqlite   # sem Docker, dados em memória
./scripts/start-portal.sh --keycloak # SSO e diretório pelo Keycloak (veja abaixo)
```

> O `--config` do `backstage-cli` **substitui** o `app-config.yaml` em vez de somar. Por isso use o script, que monta a lista completa (`app-config.yaml` + `app-config.local.yaml` + overrides).

> O TechDocs está configurado com `runIn: docker`, então a renderização das docs também precisa do Docker rodando.

## Login corporativo (SSO com Keycloak)

O login guest é só para desenvolvimento. No cenário real, o portal usa o **Keycloak** para duas coisas:

| Parte | Como funciona |
|---|---|
| Login (OIDC) | Provedor `oidc` do auth-backend, client confidencial `backstage` no realm. O resolver `emailMatchingUserEntityProfileEmail` liga quem entrou ao `User` do catálogo pelo e-mail. |
| Diretório | Módulo `@backstage-community/plugin-catalog-backend-module-keycloak`: a cada 5 minutos, importa usuários e grupos (com subgrupos e participação) como `User` e `Group`, pela conta de serviço do client `backstage-catalog` (`query-groups`, `query-users`, `view-users`). |

```bash
./scripts/setup-keycloak.sh          # sobe o Keycloak (porta 8180), importa o realm e gera keycloak/.env
./scripts/start-portal.sh --keycloak
```

- **Usuários de teste:** `ana.souza` (platform-team), `bruno.lima` e `carla.mendes` (checkout-team), `diego.rocha` (payments-team). A senha é `KEYCLOAK_DEV_USER_PASSWORD`, em `keycloak/.env`.
- **Console do Keycloak:** http://localhost:8180/admin (usuário e senha em `keycloak/.env`).
- **Times:** os grupos do Keycloak viram os times do Backstage com o mesmo nome, então a política de permissões, o orçamento por time no LiteLLM e o painel de governança funcionam sem mudança. O time de plataforma é configurável em `organization.platformTeam`.
- **Catálogo:** no modo `--keycloak`, o `catalog/org/org.yaml` não é carregado; pessoas e times vêm só do diretório. O usuário `guest` (`catalog/org/guest.yaml`) continua para os evals e scripts locais.
- **MCP:** nada muda. O consentimento OAuth do Claude Code passa a pedir o login pelo Keycloak.
- **Segredos:** `keycloak/.env` (não versionado) guarda os segredos dos clients e da sessão do login; o `start-portal.sh` exporta só os que o portal usa.

Detalhes do realm (`keycloak/realm-acme.json`) que valem também para o Keycloak da empresa:
- o client de login precisa do papel `offline_access` no escopo, para o portal renovar a sessão;
- no Keycloak 26.8+, o client do diretório precisa do escopo `kc-admin-api`; sem ele, a API de administração responde 401;
- usuários criados por importação de realm não recebem os papéis padrão sozinhos.

**Para produção:** troque as URLs de `app-config.keycloak.yaml` pelas do Keycloak da empresa (com HTTPS), registre o callback `https://<backend>/api/auth/oidc/handler/frame` no client e injete os segredos pelo cofre. Em produção, o backend recusa o login guest.

## Servidor MCP

Tools expostas hoje (`tools/list`):

- `auth.who-am-i`
- `catalog.get-catalog-entity`, `catalog.query-catalog-entities`, `catalog.get-catalog-model-description`, `catalog.validate-entity`, `catalog.register-entity`, `catalog.unregister-entity`, `catalog.refresh-catalog-entity`
- `scaffolder.execute-template`, `scaffolder.dry-run-template`, `scaffolder.list-scaffolder-actions`, `scaffolder.list-scaffolder-tasks`, `scaffolder.get-scaffolder-task-logs`
- **Ações próprias** (`plugins/agent-backend/src/actions`):
  - `agent.check-service-compliance`: aplica as regras do Platform Handbook (por serviço, por time ou todos).
  - `agent.search-techdocs`: busca por termos na documentação de todas as entidades que o usuário vê.
  - `agent.read-techdocs-page`: lê uma página do TechDocs.

  As ações de TechDocs leem o Markdown direto da fonte (pasta `docs/`), sem depender de o site já ter sido gerado.

## Chat do agente no portal (home)

A página inicial do portal (http://localhost:3000) é um chat com o **Platform Agent**. O catálogo continua em `/catalog`.

```
Navegador ──► plugins/agent (chat)  ──NDJSON──►  plugins/agent-backend
                                                   ├─ Claude (Messages API, streaming)
                                                   └─ Actions Registry do Backstage
                                                      (com as credenciais do usuário logado)
```

- **Age em nome do usuário:** o backend lista e executa as ações com as credenciais de quem está logado, então as permissões do Backstage valem também para o agente (H3).
- **Aprovação humana:** ações de leitura rodam direto. Ações de escrita (executar template, registrar ou remover entidade) só rodam depois de o usuário clicar em **Aprovar** no chat.
- **Modelo:** `claude-opus-5-5` com `effort: medium`, configurável em `app-config.yaml` (bloco `agent`). O *fallback* de recusa do lado do servidor está ligado (`fallbacks: "default"`).

Para usar, inicie o portal com a chave da Anthropic no ambiente:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./scripts/start-portal.sh
```

Testes: `cd portal/plugins/agent-backend && yarn test` (loop do agente, aprovação, conformidade e TechDocs) e `cd portal/packages/backend && yarn test` (política de permissões).

## Conectando o agente (Claude Code)

O MCP usa **OAuth com o usuário do portal** (Client ID Metadata Documents, `auth.clientIdMetadataDocuments`). Na primeira conexão, o Claude Code abre o navegador. Você aprova o acesso no portal e o cliente recebe um token **seu**, então a política de permissões vale também pelo MCP.

```bash
# 1. Portal rodando
./scripts/start-portal.sh

# 2. Na raiz do repositório, em outro terminal
claude
# 3. No Claude Code: /mcp -> backstage -> Authenticate -> aprove no navegador
```

O `.mcp.json` na raiz registra o servidor `backstage`. O refresh token está ligado (`auth.experimentalRefreshToken`), então o login dura até 30 dias sem precisar repetir. Exemplos de perguntas:

- "Quem é dono do payment-service e de quais recursos ele depende?"
- "Quais serviços do time checkout-team estão em produção?"
- "Quais templates existem para criar um serviço novo?"
- "Como faço rollback de um deploy?"
- "Quais componentes estão fora dos padrões do Platform Handbook?"

Fluxo validado pela linha de comando:
- autorização, aprovação, troca do código pelo token (PKCE) e renovação do token;
- com o token, o MCP mostra **16 tools** (inclui `auth.who-am-i`);
- o `payments-db` fica oculto para o guest.

### Alternativa: token estático (só para desenvolvimento)

Serve para scripts e automações sem navegador. ⚠️ O token estático é uma identidade de **serviço**, e o Backstage libera tudo para serviços: a política de permissões **não se aplica** (o `payments-db` aparece).

```bash
eval "$(./scripts/setup-agent-token.sh)"   # gera portal/app-config.local.yaml (não versionado)
./scripts/start-portal.sh
claude mcp add --transport http backstage-service http://localhost:7007/api/mcp-actions/v1 \
  --header "Authorization: Bearer $BACKSTAGE_MCP_TOKEN"
```

> **Observações:**
> - Com o token estático, a tool `auth.who-am-i` não aparece, porque o plugin `auth` não está em `accessRestrictions`. São 15 tools.
> - `scaffolder.dry-run-template` exige o YAML do template e os arquivos do skeleton, não apenas a referência. Para criar serviços, o agente usa `scaffolder.execute-template` (cria um repositório real e requer `GITHUB_TOKEN` no portal).

## Permissões (H3)

A política fica em `portal/packages/backend/src/permissions/policy.ts` (substitui a `allow-all`):

| Regra | Quem pode |
|---|---|
| Ver entidades com `acme.example/data-classification: restricted` | só o time dono |
| Remover entidade do catálogo | só o time dono |
| Remover location (`catalog:unregister-entity`) | só o time de plataforma (`organization.platformTeam`) |
| Todo o resto | todos |

Como o agente usa as credenciais do usuário, a mesma regra vale no portal e no chat. Para conferir com outra pessoa:

```bash
./scripts/start-portal.sh bruno
./scripts/check-permissions.sh     # não altera nada
```

Resultado validado:

| Persona | `payments-db` | Remover location |
|---|---|---|
| guest / ana (platform-team) | oculto (404) | permitido |
| bruno (checkout-team) | oculto (404) | negado (403) |
| diego (payments-team) | visível (200) | negado (403) |

## Governança de IA e gateway

### Gateway de IA (LiteLLM)

As chamadas do agente ao modelo passam por um **gateway**, escolhido em `agent.gateway.type`:

| Tipo | Destino |
|---|---|
| `direct` (padrão) | API da Anthropic, com `ANTHROPIC_API_KEY` ou `agent.anthropicApiKey` |
| `litellm` | LiteLLM Proxy, rota de *pass-through* `/anthropic`: a Messages API nativa passa sem tradução, então `effort`, fallback e cache continuam funcionando |

```bash
./scripts/setup-gateway.sh   # sobe o LiteLLM (porta 4000), emite as keys do portal e grava agent.gateway no app-config.local.yaml
./scripts/start-portal.sh
```

- **Chaves:** a chave da Anthropic fica só no LiteLLM, em `gateway/.env`, que não é versionado. O portal usa:
  - a **virtual key** `backstage-agent`, para pedidos sem time;
  - a key de administração `backstage-admin` (usuário `backstage-portal`, papel `proxy_admin`), que gerencia os times e os orçamentos. Não é a master key e pode ser revogada sozinha.
- **Atribuição:** cada chamada vai com `metadata.user_id` e `litellm_metadata` (usuário e as tags `app:backstage-agent`, `team:<time>` e `request:<id>`). O LiteLLM registra o gasto por usuário final e por tag (`/spend/logs`).
- **Rastreabilidade:** a tag `request:<id>` é o mesmo ID da auditoria do Backstage.
- **Painel do LiteLLM:** http://localhost:4000/ui (login com a `LITELLM_MASTER_KEY` de `gateway/.env`).

### Orçamento de IA por time

Cada Group do catálogo tem um **orçamento mensal** no LiteLLM (padrão US$ 50, em `agent.governance.budgets`):
- o pedido é cobrado do primeiro time do usuário, com a virtual key do time;
- ao estourar, o LiteLLM bloqueia as chamadas do time até a renovação mensal, e o agente explica o motivo no chat;
- alertas vão para o **sino do Backstage** em 80% e 100%: para o próprio time e para o platform-team (com link para o painel);
- a sincronização roda a cada 5 minutos: times novos no catálogo ganham orçamento, e mudanças na config são aplicadas.

```yaml
agent:
  governance:
    budgets:
      enabled: true
      monthlyUsd: 50
      teams:
        platform-team: 100   # exceção por time
      thresholds: [0.8, 1]
      notify: [group:default/platform-team]
```

**Trocar de gateway** (Kong, Portkey, Envoy etc.):
1. Implemente a interface `ModelGateway` em `portal/plugins/agent-backend/src/gateway/<nome>.ts`. São quatro métodos: o cliente do SDK, a atribuição por chamada, a verificação de saúde e a descrição. O orçamento (`budgets`) é opcional.
2. Registre a nova classe em `GATEWAY_FACTORIES` (`gateway/index.ts`).
3. Mude `agent.gateway.type`.

O resto do agente não muda.

### Painel "Governança de IA"

Fica em http://localhost:3000/governanca-ia e só o **platform-team** acessa (permissão `agent.governance.read`).

| Aba | Conteúdo |
|---|---|
| Visão geral | Pedidos, usuários, tokens, custo estimado, latência, erros e ações de escrita; pedidos por dia; uso por time, por usuário e por ação |
| Orçamento | Gasto do mês por time (calculado pelo gateway) contra o orçamento, renovação, alertas enviados e regras |
| Auditoria | Cada pedido: quem fez, status, ações executadas, aprovações e recusas, tokens e latência |
| Inventário | Ativos de IA do catálogo (`catalog/ai/ai.yaml`): modelos, gateways, agentes e servidores MCP, com dono, risco, acesso a dados e aprovação humana |
| Políticas | Modelo, gateway (com verificação de saúde), regras, e ações disponíveis com indicação das que exigem aprovação |
| Qualidade | Histórico das rodadas de evals |

- **Dados:** os pedidos e as ações ficam no banco do plugin (`agent_requests` e `agent_tool_calls`). Ações de escrita também vão para o log de auditoria do Backstage (`agent-write-action`).
- **Perguntas:** `agent.governance.storePrompts` grava o início de cada pergunta. Está ligado na POC; avalie a política de dados antes de ligar em produção.
- **Custo:** preencha `agent.governance.pricing` (USD por milhão de tokens) com a tabela vigente. Sem isso, o painel mostra só os tokens.

## Avaliação (evals)

`evals/cases.yaml` tem 16 casos cobrindo H1 a H4, conformidade e segurança. O runner envia cada caso ao chat como o usuário logado e avalia a resposta com checagens determinísticas. Detalhes em [evals/README.md](evals/README.md).

```bash
node evals/run.mjs                 # todos os casos (chama o modelo de verdade: tem custo)
node evals/run.mjs --filter H4     # por hipótese ou id
node evals/run.mjs --repeat 3      # consistência
node evals/run.mjs --import evals/results/<arquivo>.json   # publica uma rodada antiga no painel
```

Cada rodada é publicada no painel de governança, na aba Qualidade. Use `--no-publish` para não publicar.

## Roadmap

- [x] **Semana 1: fundação.** Portal, Postgres, catálogo fictício, TechDocs e 2 templates.
- [x] **Semana 2: agente via MCP.** Token de acesso para o agente, Claude Code conectado ao MCP, ações customizadas (conformidade, busca no TechDocs) e conjunto de avaliação em `evals/`.
- [ ] **Semana 3: experiência e validação.**
  - [x] Chat do agente na home do portal, com aprovação humana
  - [x] Política de permissões e personas de teste
  - [x] Métricas de uso (tokens, latência) no runner dos evals
    - [x] OAuth no MCP: agentes externos com a identidade do usuário
  - [x] Governança de IA (fase 1): gateway LiteLLM plugável, auditoria, painel e inventário de IA no catálogo
  - [x] Governança de IA (fase 2): orçamento por time no LiteLLM, custo vindo do gateway no painel, alertas no sino
- [ ] **Implementação real.**
  - [x] SSO e diretório com Keycloak (OIDC + importação de usuários e grupos)
  - [ ] Rodar os evals com o modelo e fechar o [relatório de go/no-go](docs/relatorio-go-no-go.md)
