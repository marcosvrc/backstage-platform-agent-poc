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
│   ├── org/                 # Groups e Users
│   ├── systems/             # Domain e Systems
│   ├── apis/                # APIs (OpenAPI / AsyncAPI)
│   ├── resources/           # bancos e tópicos
│   └── components/          # serviços (+ TechDocs)
├── templates/               # golden paths do Scaffolder (Node e Java)
├── docker-compose.yml       # Postgres local
└── app-config.sqlite.yaml   # override para rodar sem Docker
```

### Catálogo fictício

- **Times:** `platform-team`, `checkout-team`, `payments-team`
- **Sistemas:** `checkout`, `payments`, `developer-platform`
- **Serviços:** `order-service`, `payment-service`, `inventory-service`, `cart-web`, `notification-worker`, `platform-handbook`

Alguns componentes estão **fora do padrão de propósito**, para testar o caso de uso de conformidade. As regras estão em `catalog/components/platform-handbook/docs/standards.md`.

- `inventory-service`: sem TechDocs, lifecycle `experimental`
- `notification-worker`: sem `description`, sem `system`, sem TechDocs, lifecycle `deprecated`

## Como rodar

Pré-requisitos: Node 22 ou 24, Yarn (`corepack enable`) e Docker.

```bash
# 1. Postgres
docker compose up -d

# 2. Portal
cd portal
yarn install
export GITHUB_TOKEN=<PAT com escopo repo>   # necessário para os templates publicarem no GitHub
yarn start
```

- Frontend: http://localhost:3000 (login como **guest**)
- Backend: http://localhost:7007

Para rodar **sem Docker**, com dados em memória:

```bash
cd portal
yarn start --config ../app-config.sqlite.yaml
```

> O TechDocs está configurado com `runIn: docker`, então a renderização das docs também precisa do Docker rodando.

## Servidor MCP

Tools expostas hoje (`tools/list`):

- `auth.who-am-i`
- `catalog.get-catalog-entity`, `catalog.query-catalog-entities`, `catalog.get-catalog-model-description`, `catalog.validate-entity`, `catalog.register-entity`, `catalog.unregister-entity`, `catalog.refresh-catalog-entity`
- `scaffolder.execute-template`, `scaffolder.dry-run-template`, `scaffolder.list-scaffolder-actions`, `scaffolder.list-scaffolder-tasks`, `scaffolder.get-scaffolder-task-logs`

## Roadmap

- [x] **Semana 1: fundação.** Portal, Postgres, catálogo fictício, TechDocs e 2 templates.
- [ ] **Semana 2: agente via MCP.** Token de acesso para o agente, Claude Code conectado ao MCP, ações customizadas (conformidade, busca no TechDocs) e conjunto de avaliação em `evals/`.
- [ ] **Semana 3: experiência e validação.** Chat no portal, testes de permissão, métricas e relatório de go/no-go.
