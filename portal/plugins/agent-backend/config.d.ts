export interface Config {
  organization?: {
    /**
     * Time de plataforma (entity ref do Group): painel de governança, remoção de
     * locations e alertas de orçamento. Padrão: group:default/platform-team
     */
    platformTeam?: string;
  };
  /** Configuração do Platform Agent */
  agent?: {
    /** Modelo Claude usado pelo agente. Padrão: claude-opus-5-5 */
    model?: string;
    /** Esforço de raciocínio: low | medium | high | xhigh | max. Padrão: medium */
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Máximo de iterações (chamadas ao modelo) por mensagem. Padrão: 12 */
    maxIterations?: number;
    /** Dono padrão (usuário/org do GitHub) para novos repositórios criados por templates */
    defaultRepoOwner?: string;
    /** Por onde as chamadas ao modelo passam (conector). Padrão: direct. */
    gateway?: {
      /**
       * Tipo do conector, registrado por um módulo do agente:
       * direct (agent-backend-module-anthropic) | litellm (agent-backend-module-litellm).
       * As demais chaves de agent.gateway são definidas por cada módulo.
       */
      type?: string;
    };
    /** Painel de governança de IA */
    governance?: {
      /** Grava o início de cada pergunta na auditoria. Padrão: false */
      storePrompts?: boolean;
      /**
       * Preço em USD por milhão de tokens, por modelo. Sem preço, o painel mostra só tokens.
       * Ex.: pricing: { claude-opus-5-5: { input: X, output: Y, cacheRead: Z, cacheWrite: W } }
       */
      /**
       * Orçamento mensal de IA por time, aplicado pelo gateway (precisa de um
       * gateway com orçamento, ex.: LiteLLM com adminKey).
       */
      budgets?: {
        /** Padrão: false */
        enabled?: boolean;
        /** Orçamento mensal padrão por time, em USD. Padrão: 50 */
        monthlyUsd?: number;
        /** Exceções por time (nome do Group ou entity ref), em USD. */
        teams?: { [team: string]: number };
        /** Frações do orçamento que disparam alerta no sino. Padrão: [0.8, 1] */
        thresholds?: number[];
        /** Quem recebe todos os alertas. Padrão: [organization.platformTeam] */
        notify?: string[];
      };
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
