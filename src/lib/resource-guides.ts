import type { Guide } from './catalogue';
import {
  collectionDefinitions,
  type CollectionDefinition,
} from '../../catalogue/src/collection-definitions';
import { resolveCollections } from './collections';

export interface ResourceCategory {
  collectionId?: string;
  id: string;
  title: string;
  icon: string;
  description: string;
  href: string;
  guides: Guide[];
  searchable?: boolean;
  featuredStyles?: boolean;
}
export function resourceGuides(guides: Guide[]): Guide[] {
  return guides.filter(
    (guide) =>
      guide.types.includes('general-pvm') ||
      guide.types.includes('upgrade-order') ||
      (!guide.subjectId && !guide.types.includes('upgrade-order')),
  );
}
export function resourceGuideTitle(title: string): string {
  const acronyms: Record<string, string> = {
    dpm: 'DPM',
    pvm: 'PvM',
    faq: 'FAQ',
    afk: 'AFK',
    rs3: 'RS3',
    eof: 'EoF',
    pvme: 'PvME',
  };
  return title
    .replace(/^[\s>#*_]+|[\s*_]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(
      /\b(dpm|pvm|faq|afk|rs3|eof|pvme)\b/gi,
      (word) => acronyms[word.toLowerCase()],
    )
    .replace(/^\p{L}/u, (letter) => letter.toUpperCase());
}
export function resourceCategories(
  guides: Guide[],
  definitions: CollectionDefinition[] = collectionDefinitions.collections,
): ResourceCategory[] {
  return resolveCollections(
    guides,
    [],
    definitions.filter((definition) => definition.parent === '/resources/'),
    {
      '/resources/': resourceGuides(guides),
    },
  ).filter((collection) => collection.parent.href === '/resources/');
}
