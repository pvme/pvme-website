import { getCatalogue, type Guide, type Hub } from './catalogue';
import type { CollectionEntry } from './collection-entries';
import { getRendered } from './renderer';
import { combatStyleFile } from './combat-styles';
import {
  collectionDefinitions,
  type CollectionDefinition,
} from '../../catalogue/src/collection-definitions';

export interface WebsiteCollection {
  id: string;
  title: string;
  aliases: string[];
  icon: string;
  description: string;
  href: string;
  parent: { href: string; label: string };
  guides: Guide[];
  members: CollectionEntry[];
  searchable: boolean;
  featuredStyles: boolean;
}

export function resolveCollections(
  guides: Guide[],
  hubs: Hub[] = [],
  definitions: CollectionDefinition[] = collectionDefinitions.collections,
  pools: Record<string, Guide[]> = {},
  root?: string,
): WebsiteCollection[] {
  const select = (definition: CollectionDefinition) =>
    guides.filter(
      (guide) =>
        definition.guideCategories?.includes(guide.category) ||
        definition.guidePaths?.includes(guide.path) ||
        (definition.sourcePath &&
          ((!guide.sourceGuideId && guide.path === definition.sourcePath) ||
            guide.subjectId === definition.subjectId)),
    );
  return definitions
    .map((definition) => {
      const href = `${definition.parent}${definition.subjectId}/`;
      const members = definition.members.flatMap((member) => {
        const guide = member.guidePath
          ? guides.find((guide) => guide.path === member.guidePath)
          : undefined;
        if (member.guidePath && !guide)
          throw new Error(
            `collections.json: guide not found: ${member.guidePath}`,
          );
        let guideHref = guide?.href;
        if (guide && member.heading) {
          const matches = getRendered(
            guide,
            root || getCatalogue().root,
          ).toc.filter(
            (entry) =>
              entry.text.toLowerCase() === member.heading!.toLowerCase(),
          );
          const level = Math.min(...matches.map((entry) => entry.level));
          const headings = matches.filter((entry) => entry.level === level);
          if (headings.length !== 1)
            throw new Error(
              `collections.json: expected one heading "${member.heading}" in ${guide.path}`,
            );
          guideHref += `#${headings[0].id}`;
        }
        const target =
          member.href ||
          guideHref ||
          hubs.find(
            (hub) =>
              hub.id === member.subjectId &&
              hub.href.startsWith(definition.parent),
          )?.href;
        return target
          ? [
              {
                id: member.id || member.subjectId || target,
                title: member.name,
                href: target,
                subtitle: member.description,
                icon:
                  guide &&
                  guide.styles.length === 1 &&
                  !guide.types.includes('combat-achievement')
                    ? [
                        ...new Set(
                          guide.combatSetups.flatMap(
                            (setup) => setup.components,
                          ),
                        ),
                      ]
                        .filter(combatStyleFile)
                        .map((style) => style.toLowerCase())
                        .join('+') ||
                      definition.icon ||
                      'document'
                    : definition.icon || 'document',
                terms: [
                  member.name,
                  ...(member.aliases || []),
                  member.description,
                ]
                  .join(' ')
                  .toLowerCase(),
              },
            ]
          : [];
      });
      const assigned = new Set(
        definitions
          .filter(
            (other) => other.parent === definition.parent && !other.catchAll,
          )
          .flatMap(select)
          .map((guide) => guide.id),
      );
      const selected = definition.catchAll
        ? (pools[definition.parent] || guides).filter(
            (guide) => !assigned.has(guide.id),
          )
        : select(definition);
      const order = new Map(
        definition.guideOrder?.map((path, index) => [path, index]),
      );
      return {
        id: definition.subjectId,
        title: definition.title,
        aliases: definition.aliases,
        href,
        icon: definition.icon || 'document',
        description: definition.description || '',
        parent: {
          href: definition.parent,
          label:
            definition.parentLabel ||
            (definition.parent.split('/').filter(Boolean).at(-1) || 'home')
              .replace(/-/g, ' ')
              .replace(/\b\w/g, (letter) => letter.toUpperCase()),
        },
        guides: [...selected].sort(
          (a, b) =>
            (order.get(a.path) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(b.path) ?? Number.MAX_SAFE_INTEGER) ||
            a.title.localeCompare(b.title),
        ),
        members,
        searchable: !!definition.searchable,
        featuredStyles: !!definition.featuredStyles,
      };
    })
    .filter(
      (collection) => collection.members.length || collection.guides.length,
    );
}

export function websiteCollections(
  catalogue: { root: string; guides: Guide[]; bosses: Hub[]; slayer: Hub[] },
  definitions = collectionDefinitions.collections,
) {
  const resourcePool = catalogue.guides.filter(
    (guide) =>
      guide.types.includes('general-pvm') ||
      guide.types.includes('upgrade-order') ||
      !guide.subjectId,
  );
  return resolveCollections(
    catalogue.guides,
    [...catalogue.bosses, ...catalogue.slayer],
    definitions,
    {
      '/resources/': resourcePool,
      '/bosses/': catalogue.guides.filter((guide) =>
        catalogue.bosses.some((hub) =>
          hub.guides.some((member) => member.id === guide.id),
        ),
      ),
      '/slayer/': catalogue.guides.filter((guide) =>
        guide.types.includes('slayer'),
      ),
      '/tools/': [],
    },
    catalogue.root,
  );
}

export function withCollectionHubs(
  hubs: Hub[],
  collections: WebsiteCollection[],
  parent: string,
): Hub[] {
  return [
    ...hubs,
    ...collections
      .filter(
        (collection) =>
          collection.parent.href === parent &&
          !hubs.some((hub) => hub.href === collection.href),
      )
      .map((collection) => ({
        id: collection.id,
        slug: collection.id,
        name: collection.title,
        aliases: collection.aliases,
        href: collection.href,
        guides: collection.guides,
        isCollection: true,
      })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
