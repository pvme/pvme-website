import { createHash } from 'node:crypto';
import type { GuideDocument } from '@pvme/guide-parser';
import type { CombatSetup, Guide, Heading, Method, Style } from './schema';
import { canonicalAttribute, normaliseHeading, styleCombination } from './rules';

export interface MethodMatch { tag?: string; heading?: string; parents?: string[]; occurrence?: number }
export interface MethodCorrection { match: MethodMatch; include?: boolean; label?: string; type?: 'Method' | 'Combat Achievement'; attributes?: string[]; styles?: string[]; context?: string | null; anchor?: string | null }
export interface PresetCorrection { url: string; methods?: MethodMatch[] | 'shared'; styles?: string[] }
export interface CataloguePatch { guideTypes?: import('./schema').GuideType[]; method?: MethodCorrection; preset?: PresetCorrection; section?: import('./classify-types').SectionCorrection }
export interface PresetSource { url: string; label: string; line: number }
export const matchKey = (match: MethodMatch) => JSON.stringify([match.tag ?? null, match.heading ?? null, match.parents ?? null, match.occurrence ?? null]);
export function methodMatch(method: Method, methods: Method[]): MethodMatch {
  if (method.tag) return { tag: method.tag };
  const peers = methods.filter(m => m.heading.label === method.heading.label && JSON.stringify(m.heading.parents) === JSON.stringify(method.heading.parents));
  return { heading: method.heading.label, parents: method.heading.parents, ...(peers.length > 1 ? { occurrence: peers.indexOf(method) + 1 } : {}) };
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use a mapping of named correction fields.');
  return value as Record<string, unknown>;
};
function knownKeys(value: Record<string, unknown>, keys: string[]) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown correction field: ${key}.`);
}
function declaredSetups(value: unknown, evidence: string): CombatSetup[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Styles must be a list, such as [melee] or [melee-mage].');
  return value.flatMap(text => {
    const combo = styleCombination(text);
    if (combo.ambiguous || !combo.styles.length) throw new Error(`Unclear style “${text}”. Use a single style or a hybrid label such as melee-mage.`);
    return combo.styles.map(style => ({ style, components: combo.hybrid ? combo.components : [style as Exclude<Style, 'Hybrid'>], origin: 'explicit' as const, evidence }));
  });
}

export function applyCorrections(input: Guide, doc: GuideDocument, headings: Heading[], presets: PresetSource[], raw?: unknown): Guide {
  if (raw === undefined) return input;
  // Invalid metadata never partly changes a result: work on a detached copy.
  const guide = structuredClone(input);
  try {
    const config = object(raw); knownKeys(config, ['version', 'methods', 'presets']);
    if (config.version !== undefined && config.version !== 1) throw new Error('The supported catalogue correction version is 1.');
    const methods = config.methods ?? [], presetRules = config.presets ?? [];
    if (!Array.isArray(methods) || !Array.isArray(presetRules)) throw new Error('catalogue.methods and catalogue.presets must be lists.');
    const findHeading = (rawMatch: unknown): Heading => {
      const match = object(rawMatch); knownKeys(match, ['tag', 'heading', 'parents', 'occurrence']);
      if (match.tag !== undefined && (typeof match.tag !== 'string' || match.heading !== undefined || match.parents !== undefined || match.occurrence !== undefined)) throw new Error('A method match must use either a tag, or a heading with optional parents and occurrence.');
      if (match.parents !== undefined && (!Array.isArray(match.parents) || match.parents.some(p => typeof p !== 'string'))) throw new Error('Method parents must be a list of heading names.');
      if (match.occurrence !== undefined && (!Number.isInteger(match.occurrence) || Number(match.occurrence) < 1)) throw new Error('Method occurrence must be a positive whole number.');
      let matches: Heading[];
      if (typeof match.tag === 'string') {
        const anchor = doc.tags[match.tag];
        const section = anchor ? doc.sections.find(s => s.id === anchor.sectionId) : undefined;
        matches = section ? headings.filter(h => h.line === section.range.start.line) : [];
      } else {
        if (typeof match.heading !== 'string' || !match.heading.trim()) throw new Error('Choose an existing heading or tag for each method correction.');
        matches = headings.filter(h => normaliseHeading(h.label) === normaliseHeading(String(match.heading)) && (match.parents === undefined || JSON.stringify(h.parents.map(normaliseHeading)) === JSON.stringify((match.parents as string[]).map(normaliseHeading))));
      }
      if (match.occurrence !== undefined) matches = matches.slice(Number(match.occurrence) - 1, Number(match.occurrence));
      if (matches.length !== 1) throw new Error(`The method match identifies ${matches.length} headings. Choose one heading using its tag, parents or occurrence.`);
      return matches[0];
    };
    const findMethod = (match: unknown): Method => {
      const heading = findHeading(match);
      const method = guide.methods.find(m => m.heading.line === heading.line);
      if (!method) throw new Error(`“${heading.label}” is not a listed method. Add it with include: true first.`);
      return method;
    };
    const seen = new Set<number>();
    for (const item of methods) {
      const rule = object(item); knownKeys(rule, ['match', 'include', 'styles', 'context', 'anchor', 'label', 'type', 'attributes']);
      const heading = findHeading(rule.match);
      if (seen.has(heading.line)) throw new Error(`More than one correction targets “${heading.label}”. Combine them in one entry.`);
      seen.add(heading.line);
      if (rule.include !== undefined && typeof rule.include !== 'boolean') throw new Error('include must be true or false.');
      let method = guide.methods.find(m => m.heading.line === heading.line);
      if (!method && rule.include === true) {
        const section = doc.sections.find(s => s.range.start.line === heading.line);
        const anchor = section ? Object.values(doc.tags).find(a => a.sectionId === section.id) : undefined;
        method = { id: `method-${createHash('sha256').update(`${guide.path}:override:${matchKey(rule.match as MethodMatch)}`).digest('hex').slice(0, 16)}`, label: heading.label, heading, styles: [], combatSetups: [], styleEvidence: [], attributes: [], tag: anchor?.tag ?? null, tagLine: anchor?.range.start.line ?? null, context: heading.parents.map(value => ({ value, origin: 'explicit', evidence: 'Parser section hierarchy' })), keywords: [], confidence: 'High', evidence: ['Method explicitly declared in repository overrides.json'], review: false };
        guide.methods.push(method);
      }
      if (!method && rule.include === false) continue; // A general detection fix may already exclude this heading.
      if (!method) throw new Error(`“${heading.label}” is not a listed method. Use include: true to add it.`);
      if (rule.label !== undefined) { if (typeof rule.label !== 'string' || !rule.label.trim()) throw new Error('Enter a nonempty method label.'); method.label = rule.label; }
      if (rule.type !== undefined) { if (!['Method', 'Combat Achievement'].includes(String(rule.type))) throw new Error('Choose Method or Combat Achievement.'); method.type = rule.type as Method['type']; }
      if (rule.attributes !== undefined) { if (!Array.isArray(rule.attributes) || rule.attributes.some(v => typeof v !== 'string' || !v.trim())) throw new Error('Attributes must be a list of names.'); method.attributes = [...new Set((rule.attributes as string[]).map(canonicalAttribute))].map(value => ({ value, origin: 'explicit', evidence: 'Repository catalogue override' })); }
      if (rule.include === false) {
        guide.methods = guide.methods.filter(m => m.id !== method!.id);
        guide.inspectionCandidates = [...(guide.inspectionCandidates ?? []), { ...method, review: false, evidence: [...method.evidence, 'Excluded from method selectors by explicit repository overrides.json'] }];
        guide.issues = guide.issues.filter(i => i.methodId !== method!.id);
        continue;
      }
      if (rule.include === true) {
        method.confidence = 'High'; method.review = false;
        guide.issues = guide.issues.filter(i => !(i.type === 'likely-missing-method' && i.line === heading.line));
        guide.inspectionCandidates = guide.inspectionCandidates?.filter(m => m.heading.line !== heading.line);
        method.evidence.push('Confirmed as a separate method by explicit repository overrides.json');
        guide.issues = guide.issues.filter(i => !(i.methodId === method!.id && i.type === 'ambiguous-method'));
      }
      if (rule.styles !== undefined) {
        method.combatSetups = declaredSetups(rule.styles, 'Explicit method styles in repository overrides.json');
        method.styles = [...new Set(method.combatSetups.map(s => s.style))];
        if (rule.attributes === undefined) { method.attributes = method.attributes.filter(a => a.value !== 'Hybrid'); if (method.styles.includes('Hybrid')) method.attributes.push({ value: 'Hybrid', origin: 'explicit', evidence: 'Repository style override' }); }
        method.styleEvidence = method.styles.map(value => ({ value, origin: 'explicit', evidence: 'Explicit method styles in repository overrides.json' }));
        guide.issues = guide.issues.filter(i => !(i.methodId === method!.id && (i.type === 'unknown-style' || (i.type === 'ambiguous-style-combination' && i.line === method!.heading.line))));
      }
      if (Object.hasOwn(rule, 'context')) {
        if (rule.context !== null && typeof rule.context !== 'string') throw new Error('Context must be a heading name or null for no section grouping.');
        const contexts = rule.context === null ? [] : headings.filter(h => normaliseHeading(h.label) === normaliseHeading(String(rule.context)));
        if (rule.context !== null && contexts.length !== 1) throw new Error('Choose one unique context heading, or null for no grouping.');
        method.context = method.context.filter(c => c.origin === 'explicit');
        if (contexts[0]) method.context.push({ value: contexts[0].label, origin: 'explicit', evidence: 'Section grouping chosen in repository overrides.json' });
        method.evidence.push(rule.context === null ? 'Override declares no extra section grouping' : `Override groups this method under “${contexts[0].label}”`);
        guide.issues = guide.issues.filter(i => !(i.methodId === method!.id && i.type === 'context-review'));
      }
      if (Object.hasOwn(rule, 'anchor')) {
        if (rule.anchor !== null && typeof rule.anchor !== 'string') throw new Error('Anchor must be an existing tag name, or null.');
        const anchor = typeof rule.anchor === 'string' ? doc.tags[rule.anchor] : null;
        if (rule.anchor !== null && !anchor) throw new Error(`The tag “${rule.anchor}” does not exist in this guide.`);
        method.tag = anchor?.tag ?? null; method.tagLine = anchor?.range.start.line ?? null;
        method.evidence.push(`Section link explicitly chosen in overrides.json: ${anchor?.tag ?? 'none'}`);
        guide.issues = guide.issues.filter(i => !(i.methodId === method!.id && ['missing-anchor', 'multiple-anchors'].includes(i.type)));
      }
    }
    const usedUrls = new Set<string>();
    for (const item of presetRules) {
      const rule = object(item); knownKeys(rule, ['url', 'methods', 'styles']);
      if (typeof rule.url !== 'string' || !presets.some(p => p.url === rule.url)) throw new Error('A preset correction must use a preset URL already present in this guide.');
      if (usedUrls.has(rule.url)) throw new Error('Combine corrections for the same preset URL in one entry.');
      usedUrls.add(rule.url);
      const source = presets.find(p => p.url === rule.url)!;
      if (rule.methods !== undefined && rule.methods !== 'shared' && (!Array.isArray(rule.methods) || !rule.methods.length)) throw new Error('Choose at least one method, or shared.');
      const owners = rule.methods === 'shared' ? [] : rule.methods === undefined ? guide.methods.filter(m => m.combatSetups?.some(s => s.url === rule.url) || guide.issues.some(i => i.line === source.line && i.methodId === m.id)) : (rule.methods as unknown[]).map(findMethod);
      const existing = guide.combatSetups?.filter(s => s.url === rule.url) ?? [];
      const combinations = rule.styles === undefined ? existing : declaredSetups(rule.styles, 'Preset style chosen in repository overrides.json');
      if (rule.styles !== undefined || rule.methods !== undefined) {
        for (const method of guide.methods) {
          method.combatSetups = (method.combatSetups ?? []).filter(s => s.url !== rule.url);
          method.styleEvidence = method.styleEvidence.filter(e => !e.evidence.includes(String(rule.url)));
          method.styles = [...new Set(method.styleEvidence.map(e => e.value).filter((v): v is Style => ['Melee', 'Magic', 'Ranged', 'Necromancy', 'Hybrid'].includes(v)))];
        }
        guide.combatSetups = (guide.combatSetups ?? []).filter(s => s.url !== rule.url);
      }
      const chosen = [...new Map(combinations.map(s => [`${s.style}:${s.components.join()}`, { ...s, origin: 'explicit' as const, label: source.label, line: source.line, url: source.url, evidence: 'Preset correction in repository overrides.json' }])).values()];
      guide.combatSetups = [...(guide.combatSetups ?? []), ...chosen];
      for (const method of owners) {
        method.combatSetups = [...(method.combatSetups ?? []), ...chosen];
        method.styles = [...new Set([...method.styles, ...chosen.map(s => s.style)])];
        method.styleEvidence.push(...chosen.map(s => ({ value: s.style, origin: 'explicit' as const, evidence: `Override links preset ${source.url} to this method` })));
        method.evidence.push(`Preset “${source.label}” explicitly linked to this method in overrides.json`);
      }
      guide.issues = guide.issues.filter(i => !(i.line === source.line && ((rule.methods !== undefined && i.type === 'ambiguous-preset-scope') || (rule.styles !== undefined && i.type === 'ambiguous-style-combination'))));
    }
    for (const method of guide.methods) method.anchor ??= method.tag ?? `method-${method.id.replace('method-', '')}`;
    guide.methods.sort((a, b) => a.heading.line - b.heading.line);
    if (guide.methods.length) guide.issues = guide.issues.filter(i => i.type !== 'no-methods');
    guide.issues = guide.issues.filter(i => !(i.type === 'unknown-style' && guide.methods.some(m => m.id === i.methodId && m.styles.length)));
    guide.combatSetups = [...(guide.combatSetups ?? []).filter(s => s.url || ['YAML combat style metadata', 'Guide filename'].includes(s.evidence)), ...guide.methods.flatMap(m => m.combatSetups ?? [])];
    guide.styles = [...new Set([...guide.combatSetups.map(s => s.style), ...guide.methods.flatMap(m => m.styles)])];
    return guide;
  } catch (error) {
    return { ...input, issues: [...input.issues, { type: 'invalid-catalogue-override', severity: 'error', path: input.path, message: (error as Error).message }] };
  }
}
