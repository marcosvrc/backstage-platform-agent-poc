# Conector Anthropic (direto) do Platform Agent

Módulo do plugin `agent` que registra o conector `direct` (`agent.gateway.type: direct`, o padrão): as chamadas vão direto para a API da Anthropic, sem gateway.

- **Chave:** `agent.anthropicApiKey` ou a variável `ANTHROPIC_API_KEY`.
- **Atribuição:** `metadata.user_id` recebe um hash do usuário. A Anthropic recomenda um identificador opaco, sem dados pessoais.
- **Recursos:** todos os recursos da Messages API ficam ligados (fallback no servidor, effort, cache e tools em streaming).
- **Orçamento:** este conector não tem orçamento por time; o painel mostra só o custo estimado.
