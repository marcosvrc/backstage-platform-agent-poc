# Conector LiteLLM do Platform Agent

Módulo do plugin `agent` que registra o conector `litellm` (`agent.gateway.type: litellm`).

## Rotas

| `agent.gateway.route` | Destino |
|---|---|
| `passthrough` (padrão) | `/anthropic`: repassa a Messages API para a API da Anthropic, sem tradução |
| `messages` | `/v1/messages`: formato da Anthropic, roteado pelo `model_list` do LiteLLM (Claude via AWS Bedrock ou Vertex AI). Use `agent.gateway.model` com o nome do modelo no LiteLLM |

`agent.gateway.features` liga ou desliga recursos que o destino pode recusar. Na rota `messages`, o fallback no servidor fica desligado por padrão. Rode `scripts/check-litellm.mjs` para descobrir o que o seu LiteLLM aceita.

## Atribuição

Cada chamada vai com `metadata.user_id` e `litellm_metadata`: o usuário e as tags `team:<time>` e `request:<id>`, além das tags fixas de `agent.gateway.tags`. Desligue com `sendMetadata: false` se o proxy recusar o campo.

## Orçamento por time

No LiteLLM com `adminKey` (modo `managed`):
- cada Group do catálogo vira um *team* (`backstage-<nome>`) com `max_budget` e `budget_duration: 1mo`;
- cada team ganha uma virtual key (`backstage-agent:<team>`), derivada da `adminKey` por HMAC, então não precisa ser guardada;
- o pedido sai com a key do time que paga, no header `Authorization`, e o LiteLLM recusa com HTTP 429 `budget_exceeded` quando o orçamento estoura.

No LiteLLM com `teamKeys` (modo `external`), os teams e orçamentos são dos admins do LiteLLM: o pedido sai com a key do time, e o gasto é lido com a mesma key (`/key/info` e `/team/info`, sem permissão de admin).

No LiteLLM com `adminKey` (modo `managed`):
- cada Group do catálogo vira um *team* (`backstage-<nome>`) com `max_budget` e `budget_duration: 1mo`;
- cada team ganha uma virtual key (`backstage-agent:<team>`), derivada da `adminKey` por HMAC, então não precisa ser guardada;
- o pedido sai com a key do time que paga, no header `Authorization`, e o LiteLLM recusa com HTTP 429 `budget_exceeded` quando o orçamento estoura.

`adminKey` e `teamKeys` não podem ser usados juntos.
