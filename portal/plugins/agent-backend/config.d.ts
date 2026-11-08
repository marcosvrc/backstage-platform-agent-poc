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
    /** Por onde as chamadas ao modelo passam. Padrão: direct (API da Anthropic). */
    gateway?: {
      /** direct | litellm (outros: implemente ModelGateway em src/gateway). */
      type?: string;
      /** URL do gateway, ex.: http://localhost:4000 */
      baseUrl?: string;
      /**
       * Credencial do gateway (no LiteLLM, a virtual key do portal).
       * @visibility secret
       */
      apiKey?: string;
      /** Tags fixas enviadas em todas as chamadas, ex.: app:backstage-agent */
      tags?: string[];
      /** LiteLLM: envia litellm_metadata (usuário e tags). Padrão: true */
      sendMetadata?: boolean;
    };
    /** Painel de governança de IA */
    governance?: {
      /** Grava o início de cada pergunta na auditoria. Padrão: false */
      storePrompts?: boolean;
      /**
       * Preço em USD por milhão de tokens, por modelo. Sem preço, o painel mostra só tokens.
       * Ex.: pricing: { claude-opus-5-5: { input: X, output: Y, cacheRead: Z, cacheWrite: W } }
       */
      pricing?: {
        [model: string]: {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
        };
      };
    };
  };
}
