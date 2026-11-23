import { readFileSync } from 'node:fs';
import {
  getCatalogue,
  sourcePath,
  url,
  type QuickReference,
} from './catalogue';
import { renderGuide } from './renderer';
export interface ReferenceIndexEntry {
  id: string;
  title: string;
  aliases: string[];
  category?: string;
  terms: string;
  href: string;
  payload: string;
}
export const referenceHref = (id: string) =>
  `${url('/resources/')}?tab=reference&ref=${encodeURIComponent(id)}`;
export function getReferenceIndex(): ReferenceIndexEntry[] {
  return getCatalogue().references.map((entry) => ({
    id: entry.id,
    title: entry.title,
    aliases: entry.aliases,
    ...(entry.category ? { category: entry.category } : {}),
    terms: [entry.title, ...entry.aliases, entry.category, ...entry.keywords]
      .join(' ')
      .toLowerCase(),
    href: referenceHref(entry.id),
    payload: url(`/reference-content/${encodeURIComponent(entry.id)}.json`),
  }));
}
export function renderReference(entry: QuickReference, root: string) {
  const source = readFileSync(sourcePath(root, entry.path), 'utf8');
  // Live pricing tokens have no configured data source.
  const placeholders = [...new Set(source.match(/\$data_pvme:[^$]+\$/g) ?? [])];
  const rendered = renderGuide(
    source.replace(/\$data_pvme:[^$]+\$/g, 'Live value unavailable'),
    { methods: [], sections: [] },
    `reference-${entry.id}--`,
    {},
    { referenceTitle: entry.title },
  );
  return {
    id: entry.id,
    title: entry.title,
    html: rendered.html,
    source: `https://github.com/pvme/pvme-guides/blob/master/${entry.path}`,
    ...(placeholders.length
      ? {
          notice:
            'Live prices and other dynamic values are unavailable in this static reference.',
        }
      : {}),
  };
}
