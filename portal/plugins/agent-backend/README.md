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
| `litellm` | `LiteLLMGateway` | `agent.gateway.{baseUrl, apiKey, adminKey, tags, sendMetadata}` |

Para outro gateway, implemente `ModelGateway` (`describe`, `client`, `requestExtras`, `health`) e registre a classe em `GATEWAY_FACTORIES`.

**Orçamento (opcional):** um gateway que controla gasto expõe `budgets` (`GatewayBudgets`: `ensureTeam`, `list`, `isBudgetExceeded`). No LiteLLM, ele fica ativo quando há `adminKey`:
- cada Group do catálogo vira um *team* (`backstage-<nome>`) com `max_budget` e `budget_duration: 1mo`;
- cada team ganha uma virtual key (`backstage-agent:<team>`), derivada da `adminKey` por HMAC, então não precisa ser guardada;
- o pedido sai com a key do time que paga, no header `Authorization`, e o LiteLLM recusa com HTTP 429 `budget_exceeded` quando o orçamento estoura.

Gateways sem `budgets` continuam funcionando; o painel mostra só o custo estimado.

## Governança (`src/governance`, rotas `/governance/*`)

- **Pedidos:** cada pedido ao `/chat` é gravado com usuário, times, status, tokens, latência e as ações chamadas (`agent_requests`, `agent_tool_calls`). As migrações ficam em `migrations/`.
- **Auditoria:** ações de escrita (aprovadas ou recusadas) geram o evento `agent-write-action` no auditor do Backstage.
- **Orçamento por time** (`budgets.ts`, `agent.governance.budgets`):
  - o pedido é cobrado do primeiro time do usuário;
  - antes de chamar o modelo, o agente garante o time no gateway e recusa cedo, com mensagem em português, se o orçamento acabou;
  - a tarefa agendada `agent-budgets-sync` roda a cada 5 minutos, sincroniza os Groups do catálogo com o gateway e envia alertas no sino (plugin de notificações) ao atingir os limiares (padrão: 80% e 100%);
  - cada alerta sai uma vez por time, período e limiar (`agent_budget_alerts`), e o alerta de 100% substitui o de 80% no sino;
  - se o gateway não responder, o pedido segue e o próprio gateway aplica o limite.
- **Rotas de leitura:** `GET /governance/{overview,audit,policy,budgets,evals}` exigem a permissão `agent.governance.read`.
- **Publicação de evals:** `POST /governance/evals` exige `agent.evals.publish`.
