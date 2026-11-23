import configuredCollections from '../collections.json';
import { parseNavigationSettings, type NavigationSettings } from './navigation-definitions';

export interface CollectionMember {
  subjectId?: string;
  href?: string;
  guidePath?: string;
  heading?: string;
  id?: string;
  description?: string;
  name: string;
  aliases?: string[];
  sharedGuideTitle?: string;
}

export interface CollectionDefinition {
  parent: string;
  parentLabel?: string;
  subjectId: string;
  title: string;
  icon?: string;
  description?: string;
  searchable?: boolean;
  featuredStyles?: boolean;
  guideCategories?: string[];
  guidePaths?: string[];
  guideOrder?: string[];
  catchAll?: boolean;
  aliases: string[];
  sourcePath?: string;
  members: CollectionMember[];
}

export interface CollectionDefinitions {
  schemaVersion: 1;
  collections: CollectionDefinition[];
  navigation?: NavigationSettings;
  cardGroups: CollectionCardGroup[];
}

export interface CollectionCardGroup {
  parent: string;
  label: string;
  heading?: string;
  cards?: string[];
  collection?: string;
  remaining?: boolean;
  columns?: number;
}

export function parseCollectionDefinitions(input: unknown): CollectionDefinitions {
  const fail = (path: string, message: string): never => {
    throw new Error(`collections.json: ${path} ${message}`);
  };
  const object = (value: unknown, path: string, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object.');
    const result = value as Record<string, unknown>;
    for (const key of Object.keys(result)) if (!keys.includes(key)) fail(`${path}.${key}`, 'is not a supported field.');
    return result;
  };
  const text = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail(path, 'must be a non-empty string without surrounding spaces.');
    return value as string;
  };
  const subjectId = (value: unknown, path: string) => {
    const id = text(value, path);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail(path, 'must be a lowercase, hyphen-separated subject ID.');
    return id;
  };
  const aliases = (value: unknown, path: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail(path, 'must be an array of strings.');
    return (value as unknown[]).map((item, index) => text(item, `${path}[${index}]`));
  };
  const root = object(input, 'root', ['schemaVersion', 'collections', 'navigation', 'cardGroups']);
  if (root.schemaVersion !== 1) fail('schemaVersion', 'must be 1.');
  if (!Array.isArray(root.collections)) fail('collections', 'must be an array.');
  const ids = new Set<string>(), sources = new Set<string>();
  const collections = (root.collections as unknown[]).map((value, index): CollectionDefinition => {
    const path = `collections[${index}]`;
    const definition = object(value, path, ['parent', 'parentLabel', 'subjectId', 'title', 'aliases', 'sourcePath', 'members', 'icon', 'description', 'searchable', 'featuredStyles', 'guideCategories', 'guidePaths', 'guideOrder', 'catchAll']);
    const parent = text(definition.parent, `${path}.parent`);
    if (!/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/.test(parent)) fail(`${path}.parent`, 'must be a local parent page path, e.g. /bosses/.');
    const id = subjectId(definition.subjectId, `${path}.subjectId`);
    const collectionId = `${parent}${id}`;
    if (ids.has(collectionId)) fail(`${path}.subjectId`, `duplicates ${id}.`);
    ids.add(collectionId);
    const display = {
      ...(definition.icon === undefined ? {} : {icon: text(definition.icon, `${path}.icon`)}),
      ...(definition.description === undefined ? {} : {description: text(definition.description, `${path}.description`)}),
    };
    for (const key of ['searchable', 'featuredStyles', 'catchAll']) if (definition[key] !== undefined && typeof definition[key] !== 'boolean') fail(`${path}.${key}`, 'must be true or false.');
    const guideCategories = aliases(definition.guideCategories, `${path}.guideCategories`);
    const guidePaths = aliases(definition.guidePaths, `${path}.guidePaths`);
    const guideOrder = aliases(definition.guideOrder, `${path}.guideOrder`);
    if (guideOrder.some(value => value.startsWith('/') || value.includes('\\') || value.includes(':') || value.split('/').some(part => !part || part === '..' || part === '.'))) fail(`${path}.guideOrder`, 'must contain relative guide paths.');
    if (guidePaths.some(value => value.startsWith('/') || value.includes('\\') || value.includes(':') || value.split('/').some(part => part === '..' || part === '.' || !part))) fail(`${path}.guidePaths`, 'must contain relative guide paths.');
    const sourcePath = definition.sourcePath === undefined ? undefined : text(definition.sourcePath, `${path}.sourcePath`);
    if (sourcePath !== undefined) {
      if (!sourcePath.endsWith('.txt') || sourcePath.includes('\\') || sourcePath.includes(':') || sourcePath.split('/').some(part => !part || part === '.' || part === '..')) fail(`${path}.sourcePath`, 'must be a relative guide .txt path.');
      if (sources.has(parent + sourcePath)) fail(`${path}.sourcePath`, 'is already used by another collection under this parent.');
      sources.add(parent + sourcePath);
    }
    if (definition.members !== undefined && !Array.isArray(definition.members)) fail(`${path}.members`, 'must be an array.');
    const memberIds = new Set<string>();
    const members = ((definition.members ?? []) as unknown[]).map((value, memberIndex): CollectionMember => {
      const memberPath = `${path}.members[${memberIndex}]`;
      const member = object(value, memberPath, ['subjectId', 'href', 'guidePath', 'heading', 'id', 'name', 'description', 'aliases', 'sharedGuideTitle']);
      if ([member.subjectId, member.href, member.guidePath].filter(value => value !== undefined).length !== 1) fail(memberPath, 'needs exactly one of subjectId, href or guidePath.');
      const guidePath = member.guidePath === undefined ? undefined : text(member.guidePath, `${memberPath}.guidePath`);
      if (guidePath && (!guidePath.endsWith('.txt') || guidePath.includes('\\') || guidePath.includes(':') || guidePath.split('/').some(part => !part || part === '.' || part === '..'))) fail(`${memberPath}.guidePath`, 'must be a relative guide .txt path.');
      const heading = member.heading === undefined ? undefined : text(member.heading, `${memberPath}.heading`);
      if (heading && !guidePath) fail(`${memberPath}.heading`, 'requires guidePath.');
      const href = member.href === undefined ? undefined : text(member.href, `${memberPath}.href`);
      if (href && (!/^(?:\/(?!\/)|https:\/\/)/.test(href) || href.includes('\\'))) fail(`${memberPath}.href`, 'must be a local site URL or HTTPS URL.');
      const memberId = href || (guidePath ? `${guidePath}#${heading || ''}` : subjectId(member.subjectId, `${memberPath}.subjectId`));
      if ((!href && !guidePath && memberId === id) || memberIds.has(memberId)) fail(`${memberPath}.subjectId`, 'must be unique within the collection and different from its parent.');
      memberIds.add(memberId);
      const sharedGuideTitle = member.sharedGuideTitle === undefined ? undefined : text(member.sharedGuideTitle, `${memberPath}.sharedGuideTitle`);
      if (sharedGuideTitle && (!sourcePath || href || guidePath)) fail(`${memberPath}.sharedGuideTitle`, 'requires a collection sourcePath and member subjectId.');
      return { ...(href ? {href} : guidePath ? {guidePath, ...(heading ? {heading} : {})} : {subjectId: memberId}), name: text(member.name, `${memberPath}.name`), aliases: aliases(member.aliases, `${memberPath}.aliases`),
        ...(member.id === undefined ? {} : {id: subjectId(member.id, `${memberPath}.id`)}),
        ...(member.description === undefined ? {} : {description: text(member.description, `${memberPath}.description`)}),
        ...(sharedGuideTitle ? { sharedGuideTitle } : {}) };
    });
    if (!members.length && !sourcePath && !guideCategories.length && !guidePaths.length && !definition.catchAll) fail(path, 'needs members, sourcePath, guideCategories, guidePaths or catchAll.');
    if (definition.catchAll && (members.length || sourcePath || guideCategories.length || guidePaths.length)) fail(`${path}.catchAll`, 'cannot be combined with explicit selectors.');
    return { parent, ...(definition.parentLabel === undefined ? {} : {parentLabel: text(definition.parentLabel, `${path}.parentLabel`)}),
      subjectId: id, title: text(definition.title, `${path}.title`), aliases: aliases(definition.aliases, `${path}.aliases`), ...(sourcePath ? { sourcePath } : {}), members, ...display,
      guideCategories, guidePaths, guideOrder, searchable: definition.searchable === true, featuredStyles: definition.featuredStyles === true, catchAll: definition.catchAll === true };
  });
  if (root.cardGroups !== undefined && !Array.isArray(root.cardGroups)) fail('cardGroups', 'must be an array.');
  const usedCards = new Set<string>(), remainders = new Set<string>();
  const cardGroups = ((root.cardGroups ?? []) as unknown[]).map((value, index): CollectionCardGroup => {
    const path = `cardGroups[${index}]`;
    const group = object(value, path, ['parent', 'label', 'heading', 'cards', 'collection', 'remaining', 'columns']);
    const parent = text(group.parent, `${path}.parent`);
    if (!/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/.test(parent)) fail(`${path}.parent`, 'must be a local parent page path.');
    if (group.remaining !== undefined && typeof group.remaining !== 'boolean') fail(`${path}.remaining`, 'must be true or false.');
    const cards = aliases(group.cards, `${path}.cards`);
    const collection = group.collection === undefined ? undefined : subjectId(group.collection, `${path}.collection`);
    if (Number(!!cards.length) + Number(group.remaining === true) + Number(!!collection) !== 1) fail(path, 'needs one of cards, collection or remaining: true.');
    if (collection && !collections.some((definition) => definition.parent === parent && definition.subjectId === collection)) fail(`${path}.collection`, 'must name a collection under this parent.');
    for (const card of cards) {
      if (usedCards.has(parent + card)) fail(`${path}.cards`, `duplicates ${card} under ${parent}.`);
      usedCards.add(parent + card);
    }
    if (group.remaining === true) {
      if (remainders.has(parent)) fail(`${path}.remaining`, 'is already used under this parent.');
      remainders.add(parent);
    }
    if (group.columns !== undefined && (!Number.isInteger(group.columns) || Number(group.columns) < 1 || Number(group.columns) > 6)) fail(`${path}.columns`, 'must be a whole number from 1 to 6.');
    return {parent, label: text(group.label, `${path}.label`), ...(group.heading === undefined ? {} : {heading: text(group.heading, `${path}.heading`)}),
      ...(cards.length ? {cards} : collection ? {collection} : {remaining: true}), ...(group.columns === undefined ? {} : {columns: group.columns as number})};
  });
  return { schemaVersion: 1, collections, cardGroups, ...(root.navigation === undefined ? {} : {navigation: parseNavigationSettings(root.navigation)}) };
}

export const collectionDefinitions = parseCollectionDefinitions(configuredCollections);
