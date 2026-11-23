import type { Catalogue, CombatSetup, Guide, Method, Style, GuideType } from './schema';
import { collectionDefinitions, type CollectionDefinitions, type CollectionDefinition } from './collection-definitions';

interface PublicSetup { style: Style; components: CombatSetup['components'] }
export interface PublicMethod {
  anchor?: string; locations?: { line: number; label: string; context: string[] }[]; id: string; label: string; purpose?: Method['type']; tag: string | null;
  styles: Style[]; combatSetups: PublicSetup[]; attributes: string[]; context: string[];
}
export interface PublicGuide {
  collectionParent?: string;
  entryType?: 'collection';
  sourceGuideId?: string; parentGuideId?: string;
  containedBosses?: { subjectId: string; name: string; guideIds: string[] }[];
  id: string; path: string; title: string; category: string; types: GuideType[]; sections: PublicSection[];
  subjectId?: string | null; subject: string | null; aliases: string[]; styles: Style[]; combatSetups: PublicSetup[];
  attributes: string[]; methods: PublicMethod[];
}
export interface PublicSection { id: string; title: string; tag: string | null; line: number; types: GuideType[]; methodIds: string[] }
/** Website contract. Editorial diagnostics belong to the separate inspector export. */
export interface PublicCatalogue { schemaVersion: 3; rulesVersion: string; generatedAt: string; guides: PublicGuide[]; collections?: PublicGuide[]; quickReferences?: import('./quick-reference').QuickReference[] }
/** Inspector navigation includes source-free collections; guides remain source-backed. */
export function catalogueEntries(catalogue: PublicCatalogue): PublicGuide[] {
  return [...catalogue.guides, ...(catalogue.collections ?? [])];
}
const unique = (values: string[]) => [...new Set(values)];
function setups(values: CombatSetup[] = []): PublicSetup[] {
  return [...new Map(values.map(s => {
    const components = [...new Set(s.components)].sort();
    return [JSON.stringify([s.style, components]), { style: s.style, components }];
  })).values()];
}
export function publicCatalogue(catalogue: Catalogue, definitions: CollectionDefinitions = collectionDefinitions): PublicCatalogue {
  const result: PublicCatalogue = {
    schemaVersion: 3, rulesVersion: catalogue.rulesVersion, generatedAt: catalogue.generatedAt,
    quickReferences: catalogue.quickReferences ?? [],
    guides: catalogue.guides.filter(g => !g.excludedReason && g.status !== 'error').map(g => ({
      id: g.id, path: g.path, title: g.title, category: g.category, types: g.types ?? ['general-pvm'], sections: (g.sections ?? []).map(s => ({ id: s.id, title: s.heading.label, tag: s.tag, line: s.heading.line, types: s.types, methodIds: s.methodIds })),
      subjectId: g.subjectId ?? null, subject: g.subject?.value ?? null, aliases: unique((g.subjectAliases ?? []).map(a => a.value)),
      styles: [...new Set(g.styles)], combatSetups: setups(g.combatSetups), attributes: unique(g.attributes.map(a => a.value)),
      methods: g.methods.map(m => ({
        id: m.id, label: m.label, ...(m.anchor ? { anchor: m.anchor } : {}), ...(m.locations && m.locations.length > 1 ? { locations: m.locations.map(h => ({ line: h.line, label: h.label, context: h.parents })) } : {}), ...(m.type ? { purpose: m.type } : {}), tag: m.tag,
        styles: [...new Set(m.styles)], combatSetups: setups(m.combatSetups), attributes: unique(m.attributes.map(a => a.value)), context: unique(m.context.map(c => c.value)),
      })),
    })),
  };
  return addCollectionNavigation(result, definitions.collections);
}

function addCollectionNavigation(catalogue: PublicCatalogue, definitions: CollectionDefinition[]): PublicCatalogue {
  for (const definition of definitions) {
    const { subjectId, title, aliases, sourcePath } = definition;
    const subjects = definition.members.filter((member): member is typeof member & {subjectId: string} => !!member.subjectId);
    if (!subjects.length) continue;
    const shared = sourcePath ? catalogue.guides.find(guide => guide.path === sourcePath) : undefined;
    if (sourcePath && !shared) continue;
    if (shared) {
      shared.subjectId = subjectId;
      shared.subject = title;
      shared.collectionParent = definition.parent;
      shared.aliases = unique([...shared.aliases, title, ...aliases]);
      const {collectionParent, ...memberSource} = shared;
      catalogue.guides.push(...subjects.filter(member => member.sharedGuideTitle).map(member => ({
        ...memberSource, id: `${shared.id}/boss/${member.subjectId}`, sourceGuideId: shared.id, parentGuideId: shared.id,
        title: member.sharedGuideTitle!, subjectId: member.subjectId, subject: member.name,
        aliases: unique([...(member.aliases ?? []), title, ...aliases]),
      })));
    }
    const members = catalogue.guides.filter(guide => subjects.some(member => member.subjectId === guide.subjectId));
    if (!members.length && !shared) continue;
    for (const guide of members) {
      const member = subjects.find(member => member.subjectId === guide.subjectId)!;
      guide.aliases = unique([...guide.aliases, ...(member.aliases ?? []), title, ...aliases]);
    }
    const containedBosses = subjects.map(member => ({
      subjectId: member.subjectId, name: member.name,
      guideIds: members.filter(guide => guide.id !== shared?.id && guide.subjectId === member.subjectId).map(guide => guide.id),
    }));
    if (shared) shared.containedBosses = containedBosses;
    else (catalogue.collections ??= []).push({
      id: `collection-${subjectId}`, entryType: 'collection', path: '', collectionParent: definition.parent,
      title, category: members[0]?.category || title, types: members[0]?.types || [], sections: [],
      subjectId, subject: title, aliases,
      styles: [], combatSetups: [], attributes: [], methods: [], containedBosses,
    });
  }
  return catalogue;
}
/** One guide/method per line makes generated changes readable without deep JSON indentation. */
export function serializePublicCatalogue(catalogue: PublicCatalogue): string {
  const header = JSON.stringify({ schemaVersion: catalogue.schemaVersion, rulesVersion: catalogue.rulesVersion, generatedAt: catalogue.generatedAt }).slice(1, -1);
  const rows = catalogue.guides.map(({ methods, ...guide }) => `    {${JSON.stringify(guide).slice(1, -1)},"methods":[${methods.length ? `\n${methods.map(m => `      ${JSON.stringify(m)}`).join(',\n')}\n    ` : ''}]}`);
  return `{\n  ${header},\n  "guides": [\n${rows.join(',\n')}\n  ]${catalogue.collections ? `,\n  "collections": ${JSON.stringify(catalogue.collections)}` : ''},\n  "quickReferences": ${JSON.stringify(catalogue.quickReferences ?? [])}\n}\n`;
}
