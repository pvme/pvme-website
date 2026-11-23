import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, extname as basenameExtension } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGuide } from '@pvme/guide-parser';
import { atomicWrite } from './output';
import { analyse, extractHeadings } from './detect';
import { sourcePresets } from './presets';
import { applyCorrections, matchKey, type CataloguePatch, type MethodCorrection, type PresetCorrection } from './corrections';
import { patchMetadata, type MetadataPatch } from './local/filesystem';
import { classifyGuideTypes, type SectionCorrection } from './classify-types';
import { validateGuideTypes } from './guide-types';
import type { GuideType } from './schema';
import { normaliseHeading } from './rules';

export interface CatalogueOverride { reference?: import('./quick-reference').ReferenceOverride; types?: GuideType[]; fields?: MetadataPatch; sections?: Record<string, SectionCorrection>; methods?: Record<string, MethodCorrection>; presets?: Record<string, PresetCorrection> }
export interface OverridesFile { schemaVersion: 1; files: Record<string, CatalogueOverride> }
export const defaultOverridesFile = () => fileURLToPath(new URL('../overrides.json', import.meta.url));
export const overrideHash = (value?: CatalogueOverride) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
export const overrideMethodKey = (match: MethodCorrection['match']) => match.tag ? `tag:${match.tag}` : `heading:${matchKey(match)}`;
export async function readOverrides(file: string): Promise<OverridesFile> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    const mapping = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
    if (value.schemaVersion !== 1 || !mapping(value.files)) throw new Error('Invalid overrides.json: expected schemaVersion 1 and a files mapping.');
    for (const [path, item] of Object.entries(value.files) as [string, CatalogueOverride][]) {
      if ((!path.endsWith('.txt') && !(path.startsWith('commands/') && !basenameExtension(path))) || path.includes('\\') || path.split('/').some(p => !p || p === '..' || p === '.') || !mapping(item) || Object.keys(item).some(k => !['fields', 'methods', 'presets', 'sections', 'types', 'reference'].includes(k)) || (item.sections !== undefined && !mapping(item.sections)) || (item.fields !== undefined && !mapping(item.fields)) || (item.methods !== undefined && !mapping(item.methods)) || (item.presets !== undefined && !mapping(item.presets))) throw new Error(`Invalid override for ${path}. Repair overrides.json before continuing.`);
      if (item.reference !== undefined) {
        const ref = item.reference;
        if (!path.startsWith('commands/') || !mapping(ref) || Object.keys(ref).some(k => !['include', 'reason', 'title', 'aliases', 'category'].includes(k)) || (ref.include !== undefined && typeof ref.include !== 'boolean') || ['reason', 'title', 'category'].some(k => (ref as Record<string, unknown>)[k] !== undefined && (typeof (ref as Record<string, unknown>)[k] !== 'string' || !(ref as Record<string, string>)[k].trim())) || (ref.aliases !== undefined && (!Array.isArray(ref.aliases) || ref.aliases.some(a => typeof a !== 'string' || !a.trim())))) throw new Error(`Invalid quick-reference override for ${path}.`);
      }
      if (item.types !== undefined) validateGuideTypes(item.types);
      for (const [key, rule] of Object.entries(item.methods ?? {})) if (!rule?.match || overrideMethodKey(rule.match) !== key) throw new Error(`Invalid method identifier in overrides.json: ${path} / ${key}.`);
      for (const [key, rule] of Object.entries(item.sections ?? {})) if (!rule?.match || overrideMethodKey(rule.match) !== key) throw new Error(`Invalid section identifier in overrides.json: ${path} / ${key}.`);
      for (const [url, rule] of Object.entries(item.presets ?? {})) if (!rule || rule.url !== url) throw new Error(`Invalid preset identifier in overrides.json: ${path}.`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, files: {} };
    throw error;
  }
}
export async function writeOverrides(file: string, data: OverridesFile) {
  await mkdir(dirname(file), { recursive: true });
  const files = Object.fromEntries(Object.entries(data.files).sort(([a], [b]) => a.localeCompare(b)));
  await atomicWrite(file, { schemaVersion: 1, files });
}
export function canonicalMatch(source: string, match: MethodCorrection['match']): MethodCorrection['match'] {
  if (match.tag || !match.heading) return match;
  const doc = parseGuide(source), headings = extractHeadings(doc);
  let matches = headings.filter(h => normaliseHeading(h.label) === normaliseHeading(match.heading!) && (!match.parents || JSON.stringify(h.parents.map(normaliseHeading)) === JSON.stringify(match.parents.map(normaliseHeading))));
  if (match.occurrence !== undefined) matches = matches.slice(match.occurrence - 1, match.occurrence);
  if (matches.length !== 1) return match; // Validation reports unresolved or ambiguous selectors.
  const section = doc.sections.find(s => s.range.start.line === matches[0].line);
  const tag = Object.values(doc.tags).find(t => t.sectionId === section?.id);
  return tag ? { tag: tag.tag } : match;
}
export function mergeOverride(previous: CatalogueOverride | undefined, patch: MetadataPatch | CataloguePatch, correction: boolean, source?: string): CatalogueOverride {
  const next: CatalogueOverride = structuredClone(previous ?? {});
  if (!correction) next.fields = { ...next.fields, ...patch as MetadataPatch };
  else {
    const value = structuredClone(patch) as CataloguePatch;
    if (source) {
      const methods: CatalogueOverride['methods'] = {};
      for (const rule of Object.values(next.methods ?? {})) { const match = canonicalMatch(source, rule.match); methods[overrideMethodKey(match)] = { ...methods[overrideMethodKey(match)], ...rule, match }; }
      if (next.methods) next.methods = methods;
      if (next.sections) next.sections = Object.fromEntries(Object.values(next.sections).map(rule => { const match = canonicalMatch(source, rule.match); return [overrideMethodKey(match), { ...rule, match }]; }));
      if (value.section) value.section.match = canonicalMatch(source, value.section.match);
      if (value.method) value.method.match = canonicalMatch(source, value.method.match);
      if (value.preset?.methods && value.preset.methods !== 'shared') value.preset.methods = value.preset.methods.map(match => canonicalMatch(source, match));
    }
    if (Number(!!value.method) + Number(!!value.preset) + Number(!!value.section) + Number(value.guideTypes !== undefined) !== 1) throw new Error('Choose one method, preset or section correction.');
    if (value.guideTypes !== undefined) next.types = validateGuideTypes(value.guideTypes);
    else if (value.section) { const key = overrideMethodKey(value.section.match); next.sections ??= {}; next.sections[key] = value.section; }
    else if (value.method) { const key = overrideMethodKey(value.method.match); next.methods ??= {}; next.methods[key] = { ...next.methods[key], ...value.method }; }
    else { next.presets ??= {}; next.presets[value.preset!.url] = { ...next.presets[value.preset!.url], ...value.preset! }; }
  }
  return next;
}
export function analyseWithOverrides(source: string, path: string, root: string, override?: CatalogueOverride) {
  if (!override) return analyse(source, path, root);
  try {
    const doc = parseGuide(source);
    if (override.fields) patchMetadata(Buffer.from(source), override.fields); // Validate legitimate field types.
    const metadata = { ...doc.metadata } as Record<string, unknown>;
    for (const [key, value] of Object.entries(override.fields ?? {})) if (value === null) delete metadata[key]; else metadata[key] = value;
    const parsed = { ...doc, metadata };
    let detected = analyse(source, path, root, parsed);
    const typed = classifyGuideTypes(detected, doc, extractHeadings(doc), Object.values(override.sections ?? {}), override.types);
    const scopes = (typed.sections ?? []).filter(s => s.typeEvidence.some(e => e.origin === 'explicit') && s.types.some(t => ['boss-rotation', 'boss-afk', 'slayer', 'combat-achievement'].includes(t))).map(s => s.heading);
    if (scopes.length) detected = analyse(source, path, root, parsed, scopes);
    const corrected = applyCorrections(detected, parsed, extractHeadings(doc), sourcePresets(doc), { version: 1, methods: Object.values(override.methods ?? {}), presets: Object.values(override.presets ?? {}) });
    const invalid = corrected.issues.find(i => i.type === 'invalid-catalogue-override');
    if (invalid) { const original = analyse(source, path, root); return { ...original, issues: [...original.issues, invalid] }; }
    return classifyGuideTypes(corrected, doc, extractHeadings(doc), Object.values(override.sections ?? {}), override.types);
  } catch (error) {
    const original = analyse(source, path, root);
    return { ...original, issues: [...original.issues, { type: 'invalid-catalogue-override', severity: 'error' as const, path, message: String((error as Error).message) }] };
  }
}
