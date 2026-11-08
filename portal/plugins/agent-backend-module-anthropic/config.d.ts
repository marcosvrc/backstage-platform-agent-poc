export interface Config {
  agent?: {
    /**
     * Conector direto (agent.gateway.type: direct): chave da API da Anthropic.
     * Se omitida, o SDK usa ANTHROPIC_API_KEY do ambiente.
     * @visibility secret
     */
    anthropicApiKey?: string;
  };
}
