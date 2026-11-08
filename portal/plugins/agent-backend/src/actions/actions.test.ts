import { mockServices } from '@backstage/backend-test-utils';
import type { Entity } from '@backstage/catalog-model';
import path from 'node:path';
import { checkServiceCompliance } from './compliance';
import { DocsReader, searchPages, tokenize } from './docs';

const CATALOG_DIR = path.resolve(__dirname, '../../../../../catalog');

const service = (overrides: Partial<Entity['metadata']>, spec: object): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'svc', namespace: 'default', ...overrides },
  spec: { type: 'service', ...spec },
});

describe('checkServiceCompliance', () => {
  it('aprova um serviço que segue todos os padrões', () => {
    const result = checkServiceCompliance(
      service(
        { description: 'ok', annotations: { 'backstage.io/techdocs-ref': 'dir:.' } },
        {
          owner: 'group:checkout-team',
          system: 'checkout',
          lifecycle: 'production',
          providesApis: ['order-api'],
        },
      ),
    );
    expect(result).toMatchObject({
      entityRef: 'component:default/svc',
      owner: 'group:default/checkout-team',
      compliant: true,
      findings: [],
    });
  });

  it('aponta todas as violações do notification-worker', () => {
    const result = checkServiceCompliance(
      service({}, { owner: 'group:platform-team', lifecycle: 'deprecated' }),
    );
    expect(result.compliant).toBe(false);
    expect(result.findings.map(f => f.rule)).toEqual([
      'description',
      'system',
      'lifecycle',
      'techdocs',
      'provides-apis',
    ]);
  });

  it('exige owner Group e trata owner sem kind como Group', () => {
    const user = checkServiceCompliance(service({}, { owner: 'user:ana.souza' }));
    expect(user.findings.find(f => f.rule === 'owner-group')?.severity).toBe('error');
    const bare = checkServiceCompliance(service({}, { owner: 'checkout-team' }));
    expect(bare.findings.find(f => f.rule === 'owner-group')).toBeUndefined();
  });

  it('providesApis ausente é só alerta (não reprova)', () => {
    const result = checkServiceCompliance(
      service(
        { description: 'x', annotations: { 'backstage.io/techdocs-ref': 'dir:.' } },
        { owner: 'group:g', system: 's', lifecycle: 'production' },
      ),
    );
    expect(result.compliant).toBe(true);
    expect(result.findings).toEqual([expect.objectContaining({ severity: 'warning' })]);
  });
});

describe('TechDocs', () => {
  const handbook: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'platform-handbook',
      annotations: {
        'backstage.io/techdocs-ref': 'dir:.',
        'backstage.io/managed-by-location': `file:${CATALOG_DIR}/components/platform-handbook/catalog-info.yaml`,
      },
    },
  };
  const reader = new DocsReader(mockServices.urlReader.mock());

  it('lê as páginas Markdown de uma localização file:', async () => {
    const pages = await reader.readPages(handbook);
    expect(pages.map(p => p.path)).toEqual(['deploy.md', 'index.md', 'standards.md']);
    expect(pages.find(p => p.path === 'standards.md')?.title).toBe('Padrões de serviço');
  });

  it('encontra a página de padrões pela busca', async () => {
    const hits = searchPages(await reader.readPages(handbook), 'quais são os padrões de serviço?');
    expect(hits[0].path).toBe('standards.md');
  });

  it('ignora acentos e stopwords na busca', () => {
    expect(tokenize('Como faço o DEPLOY em produção?')).toEqual(['faco', 'deploy', 'producao']);
  });

  it('entidade sem techdocs-ref não tem páginas', async () => {
    const pages = await reader.readPages({ ...handbook, metadata: { name: 'x' } });
    expect(pages).toEqual([]);
  });
});
