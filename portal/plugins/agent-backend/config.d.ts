export interface Config {
  /** Configuração do Platform Agent */
  agent?: {
    /**
     * Chave da API da Anthropic. Se omitida, o SDK usa ANTHROPIC_API_KEY do ambiente.
     * @visibility secret
     */
    anthropicApiKey?: string;
    /** Modelo Claude usado pelo agente. Padrão: claude-opus-5-5 */
    model?: string;
    /** Esforço de raciocínio: low | medium | high | xhigh | max. Padrão: medium */
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Máximo de iterações (chamadas ao modelo) por mensagem. Padrão: 12 */
    maxIterations?: number;
    /** Dono padrão (usuário/org do GitHub) para novos repositórios criados por templates */
    defaultRepoOwner?: string;
  };
}
