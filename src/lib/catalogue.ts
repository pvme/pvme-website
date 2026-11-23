import { z } from 'zod';
import {
  hubGuideDestinations,
  collectionGuideDestinations,
  guideDestination,
} from './guide-destinations';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
const strings = z.array(z.string()).default([]);
const setup = z.object({ style: z.string(), components: strings });
const method = z.object({
  id: z.string().min(1),
  label: z.string(),
  anchor: z.string().nullable().optional(),
  tag: z.string().nullable().default(null),
  purpose: z.string().optional(),
  styles: strings,
  combatSetups: z.array(setup).default([]),
  attributes: strings,
  context: strings,
  locations: z
    .array(z.object({ line: z.number(), label: z.string(), context: strings }))
    .optional(),
});
const section = z.object({
  id: z.string(),
  title: z.string(),
  tag: z.string().nullable().default(null),
  line: z.number(),
  types: strings,
  methodIds: strings,
});
const containedBoss = z.object({
  subjectId: z.string().min(1),
  name: z.string().min(1),
  guideIds: strings,
});
const collection = z.object({
  collectionParent: z.string().optional(),
  id: z.string().min(1),
  entryType: z.literal('collection'),
  title: z.string().min(1),
  subjectId: z.string().min(1),
  aliases: strings,
  containedBosses: z.array(containedBoss),
});
export type Collection = z.infer<typeof collection>;
const guide = z.object({
  collectionParent: z.string().optional(),
  sourceGuideId: z.string().optional(),
  parentGuideId: z.string().optional(),
  containedBosses: z.array(containedBoss).optional(),
  id: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1),
  category: z
    .string()
    .default('Resources')
    .transform((value) => (value === 'General PvM' ? 'Resources' : value)),
  types: strings,
  subjectId: z.string().nullable().optional(),
  subject: z.string().nullable().default(null),
  aliases: strings,
  styles: strings,
  combatSetups: z.array(setup).default([]),
  attributes: strings,
  sections: z.array(section).default([]),
  methods: z.array(method).default([]),
});
export type Guide = z.infer<typeof guide> & { slug: string; href: string };
export type Method = z.infer<typeof method>;
const reference = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  types: z.tuple([z.literal('quick-reference')]),
  path: z.string().startsWith('commands/'),
  title: z.string().min(1),
  aliases: strings,
  category: z.string().optional(),
  keywords: strings,
  payload: z.string(),
});
export type QuickReference = z.infer<typeof reference>;
export function adaptReferences(input: unknown): QuickReference[] {
  const result = z
    .object({
      schemaVersion: z.literal(3),
      quickReferences: z.array(reference).default([]),
    })
    .parse(input).quickReferences;
  if (new Set(result.map((r) => r.id)).size !== result.length)
    throw new Error('Duplicate quick-reference ID');
  return result;
}
export interface Hub {
  isCollection?: boolean;
  id: string;
  slug: string;
  name: string;
  href: string;
  guides: Guide[];
  aliases?: string[];
  containedBosses?: { id: string; name: string; href: string }[];
}
export const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'guide';
export function adaptCatalogue(input: unknown): Guide[] {
  const parsed = z
    .object({ schemaVersion: z.literal(3), guides: z.array(guide) })
    .safeParse(input);
  if (!parsed.success)
    throw new Error(
      `Invalid website catalogue. Expected schemaVersion 3. ${parsed.error.message}`,
    );
  const ids = new Set<string>();
  return parsed.data.guides.map((g) => {
    if (ids.has(g.id)) throw new Error(`Duplicate guide ID: ${g.id}`);
    ids.add(g.id);
    const slug = `${slugify(g.title)}-${slugify(g.id)}`;
    return { ...g, slug, href: `/guides/${slug}/` };
  });
}
export function adaptCollections(input: unknown): Collection[] {
  const parsed = z
    .object({
      schemaVersion: z.literal(3),
      collections: z.array(collection).default([]),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new Error(`Invalid website collections: ${parsed.error.message}`);
  return parsed.data.collections;
}
export function groupGuides(
  guides: Guide[],
  kind: 'bosses' | 'slayer',
  collections: Collection[] = [],
): Hub[] {
  const groups = new Map<string, Guide[]>();
  for (const g of guides) {
    const eligible =
      kind === 'slayer'
        ? g.types.includes('slayer')
        : g.types.some(
            (t) => t.startsWith('boss-') || t === 'combat-achievement',
          );
    if (!eligible || !g.subjectId || !g.subject) continue;
    if (g.collectionParent && g.collectionParent !== `/${kind}/`) continue;
    const list = groups.get(g.subjectId) || [];
    list.push(g);
    groups.set(g.subjectId, list);
  }
  const hubs: Hub[] = [...groups].map(([id, entries]) => {
    const name = [...entries]
      .map((g) => g.subject!)
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    return {
      id,
      slug: slugify(id),
      name: (kind === 'bosses'
        ? name.replace(/\s+\((?:HM|NM)\)$/i, '')
        : name
      )
        .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
        .replace(/\bed\d+\b/gi, (name) => name.toUpperCase()),
      href: `/${kind}/${slugify(id)}/`,
      guides: entries,
      isCollection: entries.some(
        (guide) => guide.containedBosses !== undefined,
      ),
    };
  });
  {
    for (const c of collections.filter(
      (collection) =>
        (collection.collectionParent || '/bosses/') === `/${kind}/`,
    )) {
      if (hubs.some((h) => h.id === c.subjectId))
        throw new Error(`Collection duplicates boss hub: ${c.subjectId}`);
      hubs.push({
        id: c.subjectId,
        slug: slugify(c.subjectId),
        name: c.title,
        href: `/${kind}/${slugify(c.subjectId)}/`,
        guides: [],
        isCollection: true,
        aliases: c.aliases,
      });
    }
    for (const hub of hubs) {
      const members = [
        ...hub.guides.flatMap((g) => g.containedBosses ?? []),
        ...collections
          .filter(
            (c) =>
              c.subjectId === hub.id &&
              (c.collectionParent || '/bosses/') === `/${kind}/`,
          )
          .flatMap((c) => c.containedBosses),
      ];
      if (members.length)
        hub.containedBosses = [
          ...new Map(
            members.flatMap((b) => {
              // Only link published member hubs backed by the declared source guides.
              const target = hubs.find(
                (h) =>
                  h.id === b.subjectId &&
                  h.id !== hub.id &&
                  h.guides.some((g) => b.guideIds.includes(g.id)),
              );
              return target
                ? [
                    [
                      target.id,
                      { id: target.id, name: b.name, href: target.href },
                    ] as const,
                  ]
                : [];
            }),
          ).values(),
        ];
    }
  }
  if (new Set(hubs.map((h) => h.slug)).size !== hubs.length)
    throw new Error(`Duplicate ${kind} routes from canonical subject IDs`);
  return hubs.sort((a, b) => a.name.localeCompare(b.name));
}
export function sourcePath(root: string, path: string): string {
  const target = resolve(root, path),
    rel = relative(resolve(root), target);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`Guide path escapes GUIDES_DIR: ${path}`);
  try {
    const actual = realpathSync(target);
    const actualRel = relative(realpathSync(root), actual);
    if (actualRel.startsWith('..') || isAbsolute(actualRel))
      throw new Error('outside root');
    return actual;
  } catch {
    throw new Error(
      `Missing or inaccessible source guide: ${target}. Check GUIDES_DIR and regenerate the catalogue if necessary.`,
    );
  }
}
let cache: ReturnType<typeof load> | undefined;
let cacheKey = '';
function load() {
  const file = resolve(
    process.env.CATALOGUE_FILE || 'catalogue/public/data/catalogue.json',
  );
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(
      `Cannot read catalogue JSON at ${file}. Set CATALOGUE_FILE to the schema v3 website export.`,
    );
  }
  const guides = adaptCatalogue(input),
    root = resolve(process.env.GUIDES_DIR || '../pvme-guides');
  for (const g of guides) sourcePath(root, g.path);
  const references = adaptReferences(input);
  for (const entry of references) sourcePath(root, entry.path);
  const bosses = groupGuides(guides, 'bosses', adaptCollections(input));
  const slayer = groupGuides(guides, 'slayer', adaptCollections(input));
  const destinations = new Map([
    ...hubGuideDestinations([...bosses, ...slayer]),
    ...collectionGuideDestinations(guides),
  ]);
  for (const guide of guides)
    guide.href = guideDestination(guide, destinations);
  return {
    guides,
    references,
    root,
    bosses,
    slayer,
  };
}
export const getCatalogue = () => {
  const file = resolve(
    process.env.CATALOGUE_FILE || 'catalogue/public/data/catalogue.json',
  );
  const info = statSync(file, { throwIfNoEntry: false });
  const key = JSON.stringify([file, info?.mtimeMs, info?.size]);
  if (!cache || key !== cacheKey) {
    cache = load();
    cacheKey = key;
  }
  return cache;
};
export const url = (path: string) =>
  /^https:\/\//.test(path)
    ? path
    : `${(import.meta.env?.BASE_URL || process.env.BASE_PATH || '/').replace(/\/$/, '')}${path}`;
