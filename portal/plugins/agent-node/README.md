# Contratos dos conectores do Platform Agent

Interfaces que o plugin `agent` usa para falar com o modelo, sem conhecer a tecnologia:

- `ModelGateway`: cliente, modelo no destino, recursos aceitos, atribuição, saúde e erros;
- `GatewayBudgets`: orçamento por time (opcional);
- `agentGatewaysExtensionPoint`: onde os módulos registram seus conectores.

Para criar um conector, veja [docs/integracoes.md](../../../docs/integracoes.md).
