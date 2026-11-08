import {
  Entity,
  RELATION_OWNED_BY,
  parseEntityRef,
  stringifyEntityRef,
} from '@backstage/catalog-model';

export const TECHDOCS_ANNOTATION = 'backstage.io/techdocs-ref';

export type Severity = 'error' | 'warning';

export interface ComplianceFinding {
  rule: string;
  severity: Severity;
  message: string;
}

export interface ComplianceResult {
  entityRef: string;
  owner?: string;
  lifecycle?: string;
  compliant: boolean;
  findings: ComplianceFinding[];
}

/**
 * Regras do Platform Handbook (catalog/components/platform-handbook/docs/standards.md)
 * para Components do tipo service.
 */
export function checkServiceCompliance(entity: Entity): ComplianceResult {
  const spec = (entity.spec ?? {}) as Record<string, unknown>;
  const findings: ComplianceFinding[] = [];
  const add = (rule: string, severity: Severity, message: string) =>
    findings.push({ rule, severity, message });

  if (!entity.metadata.description?.trim()) {
    add('description', 'error', '`metadata.description` não está preenchido.');
  }

  const ownerRef = ownerOf(entity);
  if (!ownerRef) {
    add('owner-group', 'error', '`spec.owner` não está definido.');
  } else if (parseEntityRef(ownerRef).kind.toLocaleLowerCase('en-US') !== 'group') {
    add('owner-group', 'error', `O owner (${ownerRef}) deve ser um Group, não um usuário.`);
  }

  if (!spec.system) {
    add('system', 'error', '`spec.system` não está definido.');
  }

  if (spec.lifecycle === 'deprecated') {
    add(
      'lifecycle',
      'error',
      'Lifecycle `deprecated`: se o serviço ainda está em uso, atualize o lifecycle; senão, planeje a remoção.',
    );
  }

  if (!entity.metadata.annotations?.[TECHDOCS_ANNOTATION]) {
    add('techdocs', 'error', `TechDocs não configurado (annotation \`${TECHDOCS_ANNOTATION}\`).`);
  }

  const providesApis = spec.providesApis;
  if (!Array.isArray(providesApis) || providesApis.length === 0) {
    // O catálogo não sabe se o serviço expõe APIs; por isso é só um alerta.
    add(
      'provides-apis',
      'warning',
      'Nenhuma API em `providesApis`. Se o serviço expõe APIs, declare-as.',
    );
  }

  return {
    entityRef: stringifyEntityRef(entity),
    owner: ownerRef,
    lifecycle: typeof spec.lifecycle === 'string' ? spec.lifecycle : undefined,
    compliant: !findings.some(f => f.severity === 'error'),
    findings,
  };
}

function ownerOf(entity: Entity): string | undefined {
  const relation = entity.relations?.find(r => r.type === RELATION_OWNED_BY);
  if (relation) return relation.targetRef;
  const owner = (entity.spec as { owner?: unknown } | undefined)?.owner;
  if (typeof owner !== 'string' || !owner) return undefined;
  return stringifyEntityRef(
    parseEntityRef(owner, {
      defaultKind: 'group',
      defaultNamespace: entity.metadata.namespace ?? 'default',
    }),
  );
}
