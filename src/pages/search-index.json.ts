import { getCatalogue, url } from '../lib/catalogue';
import { getRendered } from '../lib/renderer';
import { getReferenceIndex } from '../lib/references';
import { pageLinkTitle } from '../lib/page-link-title';
import { methodDestination } from '../lib/guide-destinations';
import { websiteCollections } from '../lib/collections';
import {
  guideSearchLabel,
  searchTabLabel,
  searchSectionLabel,
} from '../lib/search-label';
import type { SearchEntry } from '../lib/search';
export function GET() {
  const { guides, bosses, slayer, root } = getCatalogue();
  const hubs = [...bosses, ...slayer];
  const rows = [
    ...websiteCollections(getCatalogue())
      .filter((collection) => !hubs.some((hub) => hub.href === collection.href))
      .map((collection) => ({
        title: collection.title,
        href: url(collection.href),
        category: 'Collection',
        terms: [
          collection.title,
          ...collection.aliases,
          collection.description,
          collection.parent.label,
          ...collection.members.map((member) => member.title),
        ]
          .join(' ')
          .toLowerCase(),
      })),
    ...websiteCollections(getCatalogue())
      .filter((collection) => collection.parent.href === '/tools/')
      .flatMap((group) =>
        group.members.map((tool) => ({
          title: tool.title,
          href: `${url(group.href)}#${tool.id}`,
          category: 'Tool',
          terms:
            `${tool.title} ${tool.terms} ${group.title} tools pvme`.toLowerCase(),
        })),
      ),
    ...getReferenceIndex().map((entry) => ({
      title: entry.title,
      href: entry.href,
      category: 'Quick Reference',
      terms: entry.terms,
    })),
    ...hubs.map((h) => ({
      title: pageLinkTitle(h.name),
      href: url(h.href),
      category: searchTabLabel(h.href, h),
      terms: [
        h.name,
        ...(h.aliases ?? []),
        ...(h.containedBosses ?? []).map((b) => b.name),
        ...h.guides.flatMap((g) => g.aliases),
      ]
        .join(' ')
        .toLowerCase(),
    })),
    ...guides.flatMap((g) => {
      const hub = hubs.find((h) => h.guides.some((guide) => guide.id === g.id));
      const label = guideSearchLabel(g, hub);
      return [
        {
          ...label,
          href: url(g.href),
          category: searchTabLabel(g.href, hub),
          terms: [
            g.title,
            g.subject,
            ...g.aliases,
            ...g.styles,
            ...label.styles,
            g.category,
            ...g.methods.map((m) => m.label),
          ]
            .join(' ')
            .toLowerCase(),
        },
        ...g.methods.map((m) => {
          const label = guideSearchLabel(g, hub, m);
          const href = methodDestination(
            g,
            m.id,
            getRendered(g, root).methods,
            hub,
          );
          return {
            ...label,
            href: url(href),
            category: searchTabLabel(href, hub),
            terms: [
              g.title,
              g.subject,
              ...g.aliases,
              m.label,
              ...m.styles,
              ...label.styles,
              ...m.context,
              ...m.attributes,
              g.category,
            ]
              .join(' ')
              .toLowerCase(),
          };
        }),
      ];
    }),
  ];
  const unique = new Map<string, SearchEntry>();
  for (const row of rows) {
    const entry: SearchEntry = { ...row };
    if (new URL(entry.href, 'https://local').pathname.includes('/bosses/'))
      entry.section = searchSectionLabel(entry.section, entry.category);
    const existing = unique.get(entry.href);
    if (existing) existing.terms += ` ${entry.terms}`;
    else unique.set(entry.href, entry);
  }
  return new Response(JSON.stringify([...unique.values()]), {
    headers: { 'Content-Type': 'application/json' },
  });
}
