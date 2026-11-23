import { createHash } from 'node:crypto';
import type { GuideDocument } from '@pvme/guide-parser';
import type { Guide, GuideSection, GuideType, Heading } from './schema';
import { GENERIC_METHOD, normaliseHeading } from './rules';
import { referenceContent, ordinaryMethodHeading } from './method-context';
import { validateGuideTypes } from './guide-types';

export interface SectionCorrection { match: GuideSection['match']; types: GuideType[] }
function baseType(guide: Guide): GuideType {
  if (/^basic-guides\//i.test(guide.path) || /-basic\.txt$/i.test(guide.path)) return 'boss-overview';
  if (/^combat-achievements\//i.test(guide.path) || /-ca\.txt$/i.test(guide.path) || /(?:combat[ -]+achievements?|CAs?)\s*$/i.test(guide.title)) return 'combat-achievement';
  if (/^afk\//i.test(guide.path)) return referenceContent(guide.path, guide.title) ? 'general-pvm' : 'boss-afk';
  if (/^slayer\//i.test(guide.path)) return 'slayer';
  if (/^upgrading-info\/upgrade-order\//i.test(guide.path)) return 'upgrade-order';
  if (/^rs3-full-boss-guides\//i.test(guide.path)) { const name = normaliseHeading(`${guide.title} ${guide.path.split('/').at(-1)!.replace(/[-.]/g, ' ')}`); if (/\bmechanics?\b/.test(name)) return 'boss-mechanics'; if (/\b(?:rotations?|rots)\b/.test(name)) return 'boss-rotation'; return 'boss-overview'; }
  return 'general-pvm';
}
function headingTypes(heading: Heading, fullBoss: boolean): GuideType[] {
  if (!fullBoss) return []; // Creature, achievement and AFK rotations retain their guide purpose.
  const name = normaliseHeading(heading.label), types: GuideType[] = [];
  if (ordinaryMethodHeading(heading) && /attack rotations?|prebuild|differences|examples?|sample/.test(name)) return /attack rotations?/.test(name) ? ['boss-mechanics'] : [];
  const afk = /\b(?:afk|low effort)\b/.test(name);
  if (/\b(?:mechanics?|attack patterns?|special attacks?)\b/.test(name)) types.push('boss-mechanics');
  if (afk) types.push('boss-afk');
  if (!afk && (/\b(?:rotations?|kill methods?)\b/.test(name) || /^(?:method\b)|\bmethods?$/.test(name) || (/\bstrateg(?:y|ies)\b/.test(name) && !GENERIC_METHOD.test(name)))) types.push('boss-rotation');
  if (/\b(?:overview|introduction|requirements?|general information)\b/.test(name) || /^(?:(?:general|basic) )?strateg(?:y|ies)$/.test(name)) types.push('boss-overview');
  return types;
}
export function classifyGuideTypes(guide: Guide, doc: GuideDocument, headings: Heading[], corrections: SectionCorrection[] = [], fileTypes?: GuideType[]): Guide {
  const base = baseType(guide), fullBoss = /^rs3-full-boss-guides\//i.test(guide.path) && !/-basic\.txt$/i.test(guide.path) && base !== 'combat-achievement';
  const defaults = fileTypes === undefined ? [base] : validateGuideTypes(fileTypes);
  const matches = headings.map(h => {
    const section = doc.sections.find(s => s.range.start.line === h.line);
    const tag = Object.values(doc.tags).find(t => t.sectionId === section?.id)?.tag ?? null;
    const peers = headings.filter(p => p.label === h.label && JSON.stringify(p.parents) === JSON.stringify(h.parents));
    return { heading: h, tag, match: tag ? { tag } : { heading: h.label, parents: h.parents, ...(peers.length > 1 ? { occurrence: peers.indexOf(h) + 1 } : {}) } };
  });
  const sections: GuideSection[] = [];
  const explicitTypes = headings.map(h => headingTypes(h, fullBoss));
  for (let index = 0; index < headings.length; index++) {
    const location = matches[index], own = explicitTypes[index];
    const isRoot = index === 0 && (!fullBoss || !explicitTypes.some(types => types.length));
    if (!own.length && !isRoot) continue;
    const types = own.length ? own : defaults;
    const parent = sections.filter(s => s.heading.level < location.heading.level && s.heading.line < location.heading.line && s.heading.endLine >= location.heading.line).at(-1);
    if (GENERIC_METHOD.test(normaliseHeading(location.heading.label)) && parent && (parent.types.includes('boss-afk') || JSON.stringify(parent.types) === JSON.stringify(types))) continue;
    sections.push({ id: `section-${createHash('sha256').update(`${guide.path}:${JSON.stringify(location.match)}`).digest('hex').slice(0, 16)}`, ...location, types, methodIds: [], typeEvidence: types.map(value => ({ value, origin: own.length || fileTypes === undefined ? 'inferred' : 'explicit', evidence: own.length ? `Source heading: ${location.heading.label}` : fileTypes !== undefined ? 'File purpose in overrides.json' : `Source folder / filename purpose: ${guide.path}` })) });
  }
  const used = new Set<number>();
  for (const correction of corrections) {
    if (!correction || !correction.match || Object.keys(correction).some(k => !['match', 'types'].includes(k))) throw new Error('A section override needs a match and guide types.');
    const match = correction.match;
    if (Object.keys(match).some(k => !['tag', 'heading', 'parents', 'occurrence'].includes(k)) || (match.tag !== undefined && (typeof match.tag !== 'string' || match.heading !== undefined || match.parents !== undefined || match.occurrence !== undefined)) || (match.parents !== undefined && (!Array.isArray(match.parents) || match.parents.some(p => typeof p !== 'string'))) || (match.occurrence !== undefined && (!Number.isInteger(match.occurrence) || match.occurrence < 1))) throw new Error('Use a section tag or a heading with optional parents and occurrence.');
    let candidates = matches.filter(m => match.tag ? doc.tags[match.tag]?.sectionId === doc.sections.find(s => s.range.start.line === m.heading.line)?.id : typeof match.heading === 'string' && normaliseHeading(m.heading.label) === normaliseHeading(match.heading) && (!match.parents || JSON.stringify(m.heading.parents.map(normaliseHeading)) === JSON.stringify(match.parents.map(normaliseHeading))));
    if (match.occurrence !== undefined) candidates = candidates.slice(match.occurrence - 1, match.occurrence);
    if (candidates.length !== 1) throw new Error(`The section match identifies ${candidates.length} headings. Choose a unique source heading or tag.`);
    const location = candidates[0], types = validateGuideTypes(correction.types);
    if (used.has(location.heading.line)) throw new Error('Combine corrections for the same section.');
    used.add(location.heading.line);
    let section = sections.find(s => s.heading.line === location.heading.line);
    if (!section) { section = { id: `section-${createHash('sha256').update(`${guide.path}:${JSON.stringify(location.match)}`).digest('hex').slice(0, 16)}`, ...location, types: [], methodIds: [], typeEvidence: [] }; sections.push(section); }
    section.types = types;
    section.typeEvidence = types.map(value => ({ value, origin: 'explicit', evidence: 'Section classification in overrides.json' }));
  }
  sections.sort((a, b) => a.heading.line - b.heading.line);
  for (const method of guide.methods) {
    const owner = sections.filter(s => s.heading.line <= method.heading.line && s.heading.endLine >= method.heading.line).sort((a, b) => b.heading.level - a.heading.level || b.heading.line - a.heading.line)[0];
    if (owner) owner.methodIds.push(method.id);
  }
  const combined = [...new Set([...(fileTypes ?? []), ...sections.flatMap(s => s.types)])];
  return { ...guide, sections, types: combined.length ? combined : corrections.length || fileTypes !== undefined ? combined : [base] };
}
