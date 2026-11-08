# Platform Agent (backend)

Expõe `POST /api/agent/chat`. Roda o loop de ferramentas com o Claude (Messages API, streaming) usando as ações do Actions Registry do Backstage, sempre com as credenciais do usuário logado. Ações que não são `readOnly` exigem aprovação explícita do usuário.

Configuração (`app-config.yaml`):

```yaml
agent:
  model: claude-opus-5-5
  effort: medium
  maxIterations: 12
  defaultRepoOwner: <usuario-ou-org-github>
```

A chave vem de `ANTHROPIC_API_KEY` (ou de `agent.anthropicApiKey`).

## Ações próprias (Actions Registry)

Registradas em `src/actions` e expostas também via MCP (`backend.actions.pluginSources` inclui `agent`):

| Ação | O que faz |
|---|---|
| `agent:check-service-compliance` | Aplica as regras do Platform Handbook a Components `service` (todos, por time ou um só). Erros reprovam; `providesApis` ausente é só alerta. |
| `agent:search-techdocs` | Busca por termos no Markdown do TechDocs de todas as entidades que o usuário vê. |
| `agent:read-techdocs-page` | Lê uma página do TechDocs e lista as demais. |

Todas são `readOnly` e usam as credenciais de quem chama. O conteúdo do TechDocs é lido da fonte: `file:` direto do disco e `url:` via `UrlReader`.

O evento `done` do `/chat` inclui `usage` (chamadas ao modelo e tokens), usado pelo runner de `evals/`.
