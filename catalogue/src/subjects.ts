import type { Guide } from './schema';
import { referenceContent } from './method-context';
import { normaliseHeading } from './rules';

const ENRAGE_PREFIX = /^\d+(?:\.\d+)?%?\s+enrage\s+/i;

function clean(value: string): string {
  return value.replace(/[_-]/g, ' ').replace(/^(?:afk|low effort|story\s*mode|hard\s*mode|normal\s*mode)\s+/i, '')
    .replace(ENRAGE_PREFIX, '')
    .replace(/\s+(?:combat achievements?|CAs?|basic)(?:\s+guide)?\b.*$/i, '')
    .replace(/\s*[–—-]\s*(?:boss )?guide\s*$/i, '').replace(/\s+boss guide$/i, '')
    .replace(/\s*\((?:(?:story|normal|hard)\s*mode|sm|nm|hm)[^)]*\)\s*$/i, '').replace(/\s+(?:duo|solo|small teams|\d+s|sm|hm|nm|story\s*mode|hard\s*mode|normal\s*mode)(?:\b.*)?$/i, '').trim();
}
const subjectIds: Record<string, string> = {
  'silverquill-dreadhog': 'silverquill',
  'ivar-king-of-bones': 'ivar',
};
const key = (value: string) => {
  const normalized = normaliseHeading(clean(value)).replace(/\bthe\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  return subjectIds[normalized] ?? normalized;
};
interface Entity { id: string; name: string; aliases: Set<string> }
/** Build encounter aliases from overview filenames and titles. */
export function canonicaliseSubjects(guides: Guide[]): Guide[] {
  const entities = new Map<string, Entity>(), aliases = new Map<string, Set<string>>();
  const addAlias = (entity: Entity, alias: string) => {
    const normal = key(alias); if (!normal) return;
    entity.aliases.add(alias); const ids = aliases.get(normal) ?? new Set<string>(); ids.add(entity.id); aliases.set(normal, ids);
  };
  for (const guide of [...guides].sort((a, b) => a.path.localeCompare(b.path))) {
    const primarySource = /^basic-guides\//i.test(guide.path) || /^slayer\//i.test(guide.path) || (/^rs3-full-boss-guides\/[^/]+\.txt$/i.test(guide.path) && !referenceContent(guide.path, guide.title)) || (/^afk\//i.test(guide.path) && !referenceContent(guide.path, guide.title));
    if (!primarySource || /^(?:magic|melee|ranged|necromancy|rotations?|strateg(?:y|ies)|methods?)\b/i.test(clean(guide.sourceTitle ?? guide.title))) continue;
    const name = clean(guide.sourceTitle ?? guide.title); if (!name) continue;
    const filename = guide.path.split('/').at(-1)!.replace(/(?:-basic|-ca)?\.txt$/i, '');
    const fileKey = key(filename), nameKey = key(name);
    const rootFolder = guide.path.split('/').slice(1, -1)[0];
    const id = rootFolder ? key(rootFolder.replace(/-basic$/i, '')) : fileKey.length >= 4 && (nameKey === fileKey || nameKey.startsWith(`${fileKey}-`)) ? fileKey : nameKey;
    const entity = entities.get(id) ?? { id, name, aliases: new Set<string>() };
    // A plain overview is a better display name than its team/phase-specific companion.
    if (name.length < entity.name.length) entity.name = name;
    entities.set(id, entity); addAlias(entity, name); addAlias(entity, filename); addAlias(entity, id);
    for (const subtitle of name.split(',')) {
      const part = subtitle.trim();
      // A comma subtitle identifies an encounter alias; first-name collisions remain ambiguous.
      if (part !== name) addAlias(entity, part);
      const initials = (part.match(/[\p{L}\p{N}]+/gu) ?? []).map(word => word[0]).join('');
      if (initials.length >= 2 && initials.length <= 6) addAlias(entity, initials.toUpperCase());
    }
  }
  return guides.map(guide => {
    const encounter = (guide.types ?? []).some(t => t !== 'general-pvm' && t !== 'upgrade-order');
    if (!encounter && guide.subject?.origin !== 'explicit' && !/^one-tick-guides\//i.test(guide.path)) return { ...guide, subject: null, subjectId: null };
    const folder = guide.path.split('/')[1];
    const filename = guide.path.split('/').at(-1)!.replace(/\.txt$/i, '');
    const candidates = guide.subject?.origin === 'explicit' ? [guide.subject.value] : [guide.subject?.value ?? '', folder && guide.path.split('/').length > 2 ? folder : '', clean(guide.sourceTitle ?? guide.title), filename];
    let entity: Entity | undefined;
    for (const candidate of candidates) {
      const ids = aliases.get(key(candidate));
      if (entities.has(key(candidate))) { entity = entities.get(key(candidate)); break; }
      if (ids?.size === 1) { entity = entities.get([...ids][0]); break; }
    }
    if (!entity) {
      const ambiguous = candidates.map(candidate => ({ candidate, ids: aliases.get(key(candidate)) })).find(item => item.ids && item.ids.size > 1);
      if (ambiguous && guide.subject?.origin !== 'explicit') {
        const names = [...ambiguous.ids!].map(id => entities.get(id)!.name);
        return { ...guide, subjectId: null, issues: [...guide.issues, { type: 'ambiguous-subject', severity: 'warning' as const, path: guide.path, message: `Subject alias “${ambiguous.candidate}” matches more than one encounter: ${names.join('; ')}.`, supportingEvidence: names.map(name => `Source-derived alias for ${name}`), contradictingEvidence: ['No longer source title or folder name disambiguates this abbreviation'] }] };
      }
      const display = clean(guide.subject?.value ?? guide.title);
      if (!encounter && guide.subject?.origin !== 'explicit') return { ...guide, subject: null, subjectId: null };
      return { ...guide, subject: guide.subject ?? { value: display, origin: 'inferred', evidence: 'Encounter title' }, subjectId: key(display) || null };
    }
    const subject = guide.subject?.origin === 'explicit' || (guide.subject && clean(guide.subject.value) === guide.subject.value && !ENRAGE_PREFIX.test(guide.subject.value) && key(guide.subject.value) === key(entity.name)) ? guide.subject : { value: entity.name, origin: 'inferred' as const, evidence: 'Canonical encounter from matching overview/creature titles and source aliases' };
    const extra = [...entity.aliases].filter(a => a !== entity!.name && a.length <= 80);
    const subjectAliases = [...(guide.subjectAliases ?? []), ...extra.map(value => ({ value, origin: 'inferred' as const, evidence: 'Source title/filename or supported title initials' }))].filter((a, index, list) => list.findIndex(b => key(b.value) === key(a.value)) === index);
    return { ...guide, subject, subjectId: entity.id, subjectAliases };
  });
}
