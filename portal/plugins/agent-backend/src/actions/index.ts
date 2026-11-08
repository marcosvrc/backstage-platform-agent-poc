import type { UrlReaderService } from '@backstage/backend-plugin-api';
import type { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { NotFoundError } from '@backstage/errors';
import { CATALOG_FILTER_EXISTS } from '@backstage/catalog-client';
import { stringifyEntityRef } from '@backstage/catalog-model';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { TECHDOCS_ANNOTATION, checkServiceCompliance } from './compliance';
import { DocsReader, searchPages } from './docs';

/**
 * Ações próprias da plataforma, registradas no Actions Registry.
 * Ficam disponíveis para o chat do portal e, via MCP, para agentes externos.
 * Todas usam as credenciais de quem chamou, então respeitam as permissões do catálogo.
 */
export function registerPlatformActions(opts: {
  actionsRegistry: ActionsRegistryService;
  catalog: CatalogService;
  urlReader: UrlReaderService;
}) {
  const { actionsRegistry, catalog } = opts;
  const docs = new DocsReader(opts.urlReader);

  actionsRegistry.register({
    name: 'check-service-compliance',
    title: 'Verificar conformidade de serviços',
    description:
      'Verifica se Components do tipo service seguem os padrões da plataforma (Platform Handbook): description, owner sendo um Group, system, lifecycle não deprecated, TechDocs e providesApis. Sem filtros, verifica todos os serviços. Pode filtrar por um serviço (entityRef) ou por time dono (owner).',
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z =>
        z.object({
          entityRef: z
            .string()
            .optional()
            .describe('Serviço específico, ex.: component:default/order-service'),
          owner: z
            .string()
            .optional()
            .describe('Filtra pelo time dono, ex.: group:default/checkout-team'),
        }),
      output: z =>
        z.object({
          total: z.number(),
          compliant: z.number(),
          results: z.array(
            z.object({
              entityRef: z.string(),
              owner: z.string().optional(),
              lifecycle: z.string().optional(),
              compliant: z.boolean(),
              findings: z.array(
                z.object({
                  rule: z.string(),
                  severity: z.enum(['error', 'warning']),
                  message: z.string(),
                }),
              ),
            }),
          ),
        }),
    },
    action: async ({ input, credentials }) => {
      let entities;
      if (input.entityRef) {
        const entity = await catalog.getEntityByRef(input.entityRef, { credentials });
        if (!entity) throw new NotFoundError(`Entidade não encontrada: ${input.entityRef}`);
        entities = [entity];
      } else {
        const filter: Record<string, string> = { kind: 'Component', 'spec.type': 'service' };
        if (input.owner) filter['relations.ownedBy'] = input.owner.toLocaleLowerCase('en-US');
        ({ items: entities } = await catalog.getEntities({ filter }, { credentials }));
      }
      const results = entities
        .map(checkServiceCompliance)
        .sort((a, b) => a.entityRef.localeCompare(b.entityRef));
      return {
        output: {
          total: results.length,
          compliant: results.filter(r => r.compliant).length,
          results,
        },
      };
    },
  });

  actionsRegistry.register({
    name: 'search-techdocs',
    title: 'Buscar no TechDocs',
    description:
      'Busca por termos na documentação (TechDocs) de todas as entidades que o usuário pode ver: guias da plataforma (deploy, padrões, golden paths), runbooks e documentação de serviços. Devolve as páginas mais relevantes com um trecho. Use read-techdocs-page para ler a página inteira.',
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z =>
        z.object({
          query: z.string().min(2).describe('Termos de busca, ex.: "rollback deploy"'),
          entityRef: z
            .string()
            .optional()
            .describe('Limita a busca à documentação de uma entidade'),
          limit: z.number().int().min(1).max(20).optional().describe('Padrão: 5'),
        }),
      output: z =>
        z.object({
          hits: z.array(
            z.object({
              entityRef: z.string(),
              path: z.string(),
              title: z.string(),
              score: z.number(),
              snippet: z.string(),
            }),
          ),
        }),
    },
    action: async ({ input, credentials, logger }) => {
      let entities;
      if (input.entityRef) {
        const entity = await catalog.getEntityByRef(input.entityRef, { credentials });
        if (!entity) throw new NotFoundError(`Entidade não encontrada: ${input.entityRef}`);
        entities = [entity];
      } else {
        ({ items: entities } = await catalog.getEntities(
          { filter: { [`metadata.annotations.${TECHDOCS_ANNOTATION}`]: CATALOG_FILTER_EXISTS } },
          { credentials },
        ));
      }
      const perEntity = await Promise.all(
        entities.map(async entity => {
          const entityRef = stringifyEntityRef(entity);
          try {
            const pages = await docs.readPages(entity);
            return searchPages(pages, input.query).map(h => ({ entityRef, ...h }));
          } catch (err) {
            logger.warn(`Falha ao ler TechDocs de ${entityRef}: ${err}`);
            return [];
          }
        }),
      );
      const hits = perEntity
        .flat()
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit ?? 5);
      return { output: { hits } };
    },
  });

  actionsRegistry.register({
    name: 'read-techdocs-page',
    title: 'Ler página do TechDocs',
    description:
      'Lê o conteúdo Markdown de uma página do TechDocs de uma entidade. Sem `path`, lê a página inicial (index.md). A resposta lista as demais páginas disponíveis.',
    attributes: { readOnly: true, idempotent: true, destructive: false },
    schema: {
      input: z =>
        z.object({
          entityRef: z.string().describe('ex.: component:default/platform-handbook'),
          path: z.string().optional().describe('Página relativa à pasta docs/, ex.: deploy.md'),
        }),
      output: z =>
        z.object({
          entityRef: z.string(),
          path: z.string(),
          title: z.string(),
          content: z.string(),
          pages: z.array(z.object({ path: z.string(), title: z.string() })),
        }),
    },
    action: async ({ input, credentials }) => {
      const entity = await catalog.getEntityByRef(input.entityRef, { credentials });
      if (!entity) throw new NotFoundError(`Entidade não encontrada: ${input.entityRef}`);
      const pages = await docs.readPages(entity);
      if (pages.length === 0) {
        throw new NotFoundError(`${input.entityRef} não tem TechDocs`);
      }
      const wanted = (input.path ?? 'index.md').replace(/^\/+/, '');
      const page =
        pages.find(p => p.path === wanted || p.path === `${wanted}.md`) ??
        (input.path ? undefined : pages[0]);
      if (!page) {
        throw new NotFoundError(
          `Página ${wanted} não encontrada. Disponíveis: ${pages.map(p => p.path).join(', ')}`,
        );
      }
      return {
        output: {
          entityRef: stringifyEntityRef(entity),
          path: page.path,
          title: page.title,
          content: page.content,
          pages: pages.map(p => ({ path: p.path, title: p.title })),
        },
      };
    },
  });
}
