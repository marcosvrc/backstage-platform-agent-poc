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

## Gateway do modelo (`src/gateway`)

O agente sempre fala a Messages API da Anthropic pelo SDK oficial. A interface `ModelGateway` decide:
- para onde a chamada vai;
- com qual credencial;
- como cada chamada é atribuída ao usuário e ao time.

| Tipo | Classe | Config |
|---|---|---|
| `direct` | `DirectAnthropicGateway` | `agent.anthropicApiKey` ou `ANTHROPIC_API_KEY` |
| `litellm` | `LiteLLMGateway` | `agent.gateway.{baseUrl, apiKey, tags, sendMetadata}` |

Para outro gateway, implemente `ModelGateway` (`describe`, `client`, `requestExtras`, `health`) e registre a classe em `GATEWAY_FACTORIES`.

## Governança (`src/governance`, rotas `/governance/*`)

- **Pedidos:** cada pedido ao `/chat` é gravado com usuário, times, status, tokens, latência e as ações chamadas (`agent_requests`, `agent_tool_calls`). As migrações ficam em `migrations/`.
- **Auditoria:** ações de escrita (aprovadas ou recusadas) geram o evento `agent-write-action` no auditor do Backstage.
- **Rotas de leitura:** `GET /governance/{overview,audit,policy,evals}` exigem a permissão `agent.governance.read`.
- **Publicação de evals:** `POST /governance/evals` exige `agent.evals.publish`.
