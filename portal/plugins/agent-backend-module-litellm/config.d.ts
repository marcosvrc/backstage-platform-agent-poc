export interface Config {
  agent?: {
    /** Conector LiteLLM (agent.gateway.type: litellm). */
    gateway?: {
      /** URL do gateway, ex.: http://localhost:4000 */
      baseUrl?: string;
      /**
       * Credencial do gateway (no LiteLLM, a virtual key do portal).
       * @visibility secret
       */
      apiKey?: string;
      /**
       * LiteLLM: rota para o modelo.
       * passthrough (padrão): /anthropic, direto para a API da Anthropic.
       * messages: /v1/messages, roteado pelo model_list (Claude via AWS Bedrock ou Vertex AI).
       */
      route?: 'passthrough' | 'messages';
      /** LiteLLM: nome do modelo no model_list (ex.: claude-opus). Padrão: agent.model */
      model?: string;
      /**
       * Recursos da Messages API aceitos pelo destino. Padrão: todos ligados no
       * passthrough; na rota messages, serverSideFallback desligado.
       * Rode scripts/check-litellm.mjs para descobrir o que o seu LiteLLM aceita.
       */
      features?: {
        serverSideFallback?: boolean;
        effort?: boolean;
        eagerToolStreaming?: boolean;
        promptCaching?: boolean;
      };
      /**
       * LiteLLM, orçamento gerenciado pelo portal: chave de administração. O portal
       * cria um team por Group do catálogo e uma virtual key por team.
       * @visibility secret
       */
      adminKey?: string;
      /**
       * LiteLLM, orçamento gerenciado pelos admins do LiteLLM: virtual key de cada
       * time, emitida para o team correspondente. Chave: nome do Group ou entity ref.
       * Times sem key usam a apiKey do portal (sem orçamento próprio).
       * @deepVisibility secret
       */
      teamKeys?: { [team: string]: string };
      /** Tags fixas enviadas em todas as chamadas, ex.: app:backstage-agent */
      tags?: string[];
      /** LiteLLM: envia litellm_metadata (usuário e tags). Padrão: true */
      sendMetadata?: boolean;
    };
  };
}
