import type Anthropic from '@anthropic-ai/sdk';
import type { ActionsServiceAction } from '@backstage/backend-plugin-api/alpha';

/** Nomes de tools da API aceitam apenas [a-zA-Z0-9_-]{1,64}. */
export function toToolName(actionId: string): string {
  return actionId.replace(/[^a-zA-Z0-9_-]/g, '__').slice(0, 64);
}

export function requiresApproval(action: ActionsServiceAction): boolean {
  return !action.attributes.readOnly;
}

/**
 * Converte as ações do Actions Registry do Backstage em tools do Claude.
 * A lista é ordenada por id para manter o prefixo do prompt estável (cache).
 */
export function actionsToTools(actions: ActionsServiceAction[]): {
  tools: Anthropic.Beta.BetaTool[];
  byName: Map<string, ActionsServiceAction>;
} {
  const byName = new Map<string, ActionsServiceAction>();
  const tools = [...actions]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(action => {
      const name = toToolName(action.id);
      byName.set(name, action);
      const { $schema, ...schema } = action.schema.input as Record<string, unknown>;
      const approvalNote = requiresApproval(action)
        ? '\n\n[Ação de escrita: o portal pedirá aprovação explícita do usuário antes de executar.]'
        : '';
      return {
        name,
        description: `${action.title}\n\n${action.description}${approvalNote}`,
        input_schema: {
          ...schema,
          type: 'object',
        } as Anthropic.Beta.BetaTool.InputSchema,
        eager_input_streaming: true,
      } satisfies Anthropic.Beta.BetaTool;
    });
  return { tools, byName };
}
