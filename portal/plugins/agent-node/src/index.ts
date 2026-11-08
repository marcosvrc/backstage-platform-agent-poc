/**
 * Contratos dos conectores do Platform Agent.
 *
 * O plugin do agente depende só destas interfaces; cada tecnologia (Anthropic,
 * LiteLLM...) fica em um módulo próprio que registra o seu gateway aqui.
 *
 * @packageDocumentation
 */
export * from './types';
export * from './extensions';
