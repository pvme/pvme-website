import type { Guide } from './schema';

const ACHIEVEMENT_SUFFIX = /(?:\s+|\s*[-–—:]\s*)(?:combat[ -]+achievements?|CAs?)\s*$/i;
export function applyEncounterConvention(guide: Guide): Guide {
  const filename = guide.path.split('/').at(-1)!;
  const titleSubject = guide.title.replace(ACHIEVEMENT_SUFFIX, '').trim().replace(/\s*[-–—:]\s*$/, '');
  const titleMatches = titleSubject !== guide.title && !!titleSubject;
  const achievement = /^combat-achievements\//i.test(guide.path) || /-ca\.txt$/i.test(filename) || titleMatches;
  if (!achievement || guide.kind === 'boss-overview') return guide;
  const metadata = guide.metadata as Record<string, unknown> | null;
  const result: Guide = { ...guide, kind: 'combat-achievement',
    category: typeof metadata?.category === 'string' ? guide.category : 'Combat Achievements',
    subjectAliases: [],
    methods: guide.methods.map(method => ({ ...method, type: method.type ?? 'Combat Achievement', context: [...method.context, {
      value: 'Combat Achievement', origin: 'inferred', evidence: 'Guide title, combat-achievements folder or -ca filename identifies the method purpose',
    }] })),
  };
  if (result.subject?.origin !== 'explicit' && titleMatches) result.subject = {
    value: titleSubject, origin: 'inferred', evidence: 'Encounter name in guide title, with only the Combat Achievements / CA suffix removed',
  };
  // A short filename is an alias only when the title itself supports its
  // initials. Do not expand arbitrary abbreviations or uppercase boss names.
  const slug = filename.replace(/-ca\.txt$/i, '');
  if (result.subject && /^[a-z]{2,6}$/i.test(slug)) {
    const segments = [result.subject.value, ...result.subject.value.split(',').map(s => s.trim())];
    const initials = (value: string) => (value.match(/[\p{L}\p{N}]+/gu) ?? []).map(word => word[0]).join('').toLowerCase();
    if (segments.some(value => initials(value) === slug.toLowerCase())) result.subjectAliases = [{
      value: slug.toUpperCase(), origin: 'inferred', evidence: `Filename ${filename} matches the initials of the encounter title or its comma-separated subtitle`,
    }];
  }
  return result;
}
