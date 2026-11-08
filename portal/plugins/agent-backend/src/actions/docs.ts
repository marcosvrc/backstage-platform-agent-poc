import type { UrlReaderService } from '@backstage/backend-plugin-api';
import { ANNOTATION_LOCATION, Entity, parseLocationRef } from '@backstage/catalog-model';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TECHDOCS_ANNOTATION } from './compliance';

export interface DocPage {
  /** Caminho relativo à pasta docs/ (ex.: `runbook.md`). */
  path: string;
  title: string;
  content: string;
}

const MAX_PAGE_CHARS = 40_000;

/**
 * Lê as fontes Markdown do TechDocs de uma entidade (pasta docs/ ao lado do mkdocs.yml).
 * Lê direto da fonte, sem depender de o site do TechDocs já ter sido gerado.
 */
export class DocsReader {
  constructor(private readonly urlReader: UrlReaderService) {}

  async readPages(entity: Entity): Promise<DocPage[]> {
    const ref = entity.metadata.annotations?.[TECHDOCS_ANNOTATION];
    if (!ref) return [];
    const { type, target } = parseLocationRef(ref);

    if (type === 'url') return this.readRemote(target);
    if (type !== 'dir') throw new Error(`techdocs-ref não suportado: ${ref}`);

    const location = entity.metadata.annotations?.[ANNOTATION_LOCATION];
    if (!location) throw new Error('Entidade sem a annotation de localização');
    const loc = parseLocationRef(location);
    if (loc.type === 'file') {
      return this.readLocal(path.resolve(path.dirname(loc.target), target, 'docs'));
    }
    if (loc.type === 'url') {
      return this.readRemote(new URL(target, loc.target).toString());
    }
    throw new Error(`Localização não suportada: ${location}`);
  }

  private async readLocal(docsDir: string): Promise<DocPage[]> {
    const entries = await fs.readdir(docsDir, { recursive: true }).catch(() => []);
    const files = entries.filter(f => f.endsWith('.md')).sort();
    return Promise.all(
      files.map(async f => toPage(f, await fs.readFile(path.join(docsDir, f), 'utf8'))),
    );
  }

  private async readRemote(dirUrl: string): Promise<DocPage[]> {
    const tree = await this.urlReader.readTree(dirUrl, {
      filter: p => p.startsWith('docs/') && p.endsWith('.md'),
    });
    const files = await tree.files();
    return files
      .map(f => ({ path: f.path.replace(/^docs\//, ''), file: f }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .reduce<Promise<DocPage[]>>(async (acc, { path: p, file }) => {
        const pages = await acc;
        pages.push(toPage(p, (await file.content()).toString('utf8')));
        return pages;
      }, Promise.resolve([]));
  }
}

function toPage(pagePath: string, raw: string): DocPage {
  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? pagePath;
  const content =
    raw.length > MAX_PAGE_CHARS ? `${raw.slice(0, MAX_PAGE_CHARS)}\n...[página truncada]` : raw;
  return { path: pagePath.split(path.sep).join('/'), title, content };
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

/** Normaliza para busca: minúsculas e sem acentos. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR');
}

const STOPWORDS = new Set(
  'a o e de da do das dos em no na nos nas um uma para por com como que qual quais se ao os as the of to is'.split(
    ' ',
  ),
);

export function tokenize(query: string): string[] {
  return [
    ...new Set(
      normalize(query)
        .split(/[^a-z0-9-]+/)
        .filter(t => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ];
}

/** Busca por termos: título pesa mais que o corpo. Devolve trechos ao redor do primeiro termo. */
export function searchPages(pages: DocPage[], query: string): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const page of pages) {
    const title = normalize(page.title);
    const body = normalize(page.content);
    let score = 0;
    let firstIndex = -1;
    for (const term of terms) {
      if (title.includes(term)) score += 3;
      const count = body.split(term).length - 1;
      score += Math.min(count, 5);
      const idx = body.indexOf(term);
      if (idx >= 0 && (firstIndex < 0 || idx < firstIndex)) firstIndex = idx;
    }
    if (score === 0) continue;
    const start = Math.max(0, firstIndex - 150);
    const snippet = page.content.slice(start, start + 400).replace(/\s+/g, ' ').trim();
    hits.push({ path: page.path, title: page.title, score, snippet });
  }
  return hits.sort((a, b) => b.score - a.score);
}
