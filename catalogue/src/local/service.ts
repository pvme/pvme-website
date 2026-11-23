import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { analyse } from '../detect';
import { generate, type Options } from '../catalogue';
import type { Catalogue, ReviewDecision } from '../schema';
import { defaultReviewFile, readDecisions, writeDecisions } from '../review-store';
import { applyReviewPolicy } from '../review';
import { parseGuide } from '@pvme/guide-parser';
import { extractHeadings } from '../detect';
import { sourcePresets } from '../presets';
import { methodMatch, type CataloguePatch } from '../corrections';
import { defaultStateFile, issueKey, readCatalogueState, writeCatalogueState } from '../catalogue-state';
import { analyseWithOverrides, defaultOverridesFile, mergeOverride, overrideHash, readOverrides, writeOverrides, type CatalogueOverride } from '../overrides';
import { parseDocument, isMap } from 'yaml';
import { existingFolders, hashBytes, LocalError, patchMetadata, pathReferences, relocate, replaceMetadata, safePath, splitFrontmatter, validateSegment, writeMetadata, type MetadataPatch, type ReferenceHit } from './filesystem';

export type EditRequest = { path: string; expectedHash: string; expectedCatalogueHash?: string; target?: 'guide' | 'catalogue' } & (
  { operation: 'rename'; filename: string } | { operation: 'move'; folder: string } |
  { operation: 'metadata'; yaml: string | null } | { operation: 'metadata'; patch: MetadataPatch } | { operation: 'metadata'; cataloguePatch: CataloguePatch } | { operation: 'metadata'; clearCatalogue: true } | { operation: 'metadata'; migrateCatalogue: true }
);
export interface EditPreview {
  target?: 'guide' | 'catalogue';
  overrideBefore?: string; overrideAfter?: string;
  id: string; operation: EditRequest['operation']; from: string; to: string;
  beforeYaml: string; afterYaml: string; references: ReferenceHit[];
  before: { title: string; category: string; kind: string; subject: string | null; aliases: string[]; types?: import('../schema').GuideType[]; styles: string[]; combatSetups: string[]; methodTypes: string[] };
  after: EditPreview['before']; expiresAt: string; bodyUnchanged: boolean;
  issueChanges?: { resolved: { id?: string; type: string; explanation?: string }[]; remaining: { id?: string; type: string; explanation?: string }[]; introduced: { id?: string; type: string; explanation?: string }[] };
  sectionChanges?: { label: string; before: string; after: string }[];
  methodChanges?: { label: string; before: string; after: string }[];
}
interface Pending { preview: EditPreview; hash: string; bytes: Buffer; referencesHash: string; catalogueHash: string; override?: CatalogueOverride }
export class LocalService {
  private pending = new Map<string, Pending>();
  private tail: Promise<unknown> = Promise.resolve();
  catalogue: Catalogue | null = null;
  constructor(public options: Options) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => {}); return result;
  }
  async refresh() {
    return this.serial(async () => this.catalogue = await generate(this.options));
  }
  async state() { return this.catalogue ?? await this.refresh(); }
  async source(path: string) {
    const full = await safePath(this.options.root, path);
    const bytes = await readFile(full);
    let yaml = '', metadataError = '';
    try { yaml = splitFrontmatter(bytes).yaml; } catch (error) { metadataError = String((error as Error).message); }
    const overrides = await readOverrides(this.options.overridesFile ?? defaultOverridesFile());
    const text = bytes.toString('utf8'), doc = parseGuide(text), guide = analyse(text, path, this.options.root);
    let effectiveGuide = guide;
    try { effectiveGuide = analyseWithOverrides(text, path, this.options.root, overrides.files[path]); } catch { /* Keep source and override reset available when a saved rule is invalid. */ }
    const reviewedGuide = applyReviewPolicy(effectiveGuide, hashBytes(bytes), {});
    const candidates = [...guide.methods, ...(guide.inspectionCandidates ?? []), ...effectiveGuide.methods.filter(m => !guide.methods.some(raw => raw.heading.line === m.heading.line))];
    const headings = extractHeadings(doc);
    const headingMatches = headings.map(h => {
      const section = doc.sections.find(s => s.range.start.line === h.line);
      const anchor = Object.values(doc.tags).find(a => a.sectionId === section?.id);
      if (anchor) return { tag: anchor.tag };
      const peers = headings.filter(x => x.label === h.label && JSON.stringify(x.parents) === JSON.stringify(h.parents));
      return { heading: h.label, parents: h.parents, ...(peers.length > 1 ? { occurrence: peers.indexOf(h) + 1 } : {}) };
    });
    const methods = candidates.map(m => {
      const corrected = reviewedGuide.methods.find(c => c.id === m.id || c.heading.line === m.heading.line);
      return { id: m.id, label: corrected?.label ?? m.label, type: corrected?.type, attributes: (corrected ?? m).attributes.map(a => a.value), line: m.heading.line, parents: m.heading.parents, match: methodMatch(m, candidates), tag: m.tag, styles: (corrected ?? m).styles };
    });
    return { path, hash: hashBytes(bytes), text, yaml, metadata: doc.metadata ?? null, metadataError, catalogueHash: overrideHash(overrides.files[path]), hasCatalogueOverride: !!overrides.files[path], effectiveMetadata: effectiveGuide.metadata,
      fixData: { methods, headings, headingMatches, fileTypes: overrides.files[path]?.types ?? guide.types ?? [], sectionTypes: headings.map(h => effectiveGuide.sections?.find(s => s.heading.line === h.line)?.types ?? []), anchors: Object.values(doc.tags).map(a => ({ tag: a.tag, heading: a.heading, line: a.range.start.line })), presets: sourcePresets(doc) } };
  }

  async folders() { return existingFolders(this.options.root); }
  async preview(request: EditRequest): Promise<EditPreview> {
    if (!request || !['rename', 'move', 'metadata'].includes(request.operation) || typeof request.path !== 'string' || typeof request.expectedHash !== 'string') throw new LocalError('Invalid edit request.');
    const source = await safePath(this.options.root, request.path);
    const original = await readFile(source);
    const hash = hashBytes(original);
    if (hash !== request.expectedHash) throw new LocalError('Source changed since it was loaded. Reload the guide and preview again.', 409);
    const overrides = await readOverrides(this.options.overridesFile ?? defaultOverridesFile());
    const currentOverride = overrides.files[request.path], catalogueHash = overrideHash(currentOverride);
    if (request.expectedCatalogueHash && request.expectedCatalogueHash !== catalogueHash) throw new LocalError('The saved catalogue correction changed. Reload the guide and preview again.', 409);
    const target = request.target ?? ('cataloguePatch' in request ? 'catalogue' : 'guide');
    if ('cataloguePatch' in request && target !== 'catalogue') throw new LocalError('Catalogue corrections must be saved in overrides.json, never source YAML.');
    if (!['guide', 'catalogue'].includes(target) || (target === 'catalogue' && request.operation !== 'metadata')) throw new LocalError('Choose a valid save destination. Renames and moves change the guide file.');
    let nextOverride: CatalogueOverride | undefined = currentOverride;
    let to = request.path;
    let bytes: Buffer = original;
    let beforeYaml = '', afterYaml = '';
    if (request.operation === 'rename') {
      if (typeof request.filename !== 'string') throw new LocalError('Enter a filename.');
      validateSegment(request.filename);
      if (!request.filename.endsWith('.txt')) throw new LocalError('Filename must end in .txt.');
      to = posix.join(posix.dirname(request.path), request.filename);
    } else if (request.operation === 'move') {
      if (typeof request.folder !== 'string') throw new LocalError('Select an existing folder.');
      await safePath(this.options.root, request.folder, 'folder');
      to = request.folder ? `${request.folder}/${posix.basename(request.path)}` : posix.basename(request.path);
    } else if ('migrateCatalogue' in request) {
      if (target !== 'guide') throw new LocalError('Migration removes legacy source YAML and saves overrides.json.');
      const legacy = (parseGuide(original.toString('utf8')).metadata as Record<string, unknown> | undefined)?.catalogue as { version?: number; methods?: import('../corrections').MethodCorrection[]; presets?: import('../corrections').PresetCorrection[] } | undefined;
      if (!legacy || typeof legacy !== 'object' || (legacy.version !== undefined && legacy.version !== 1) || Object.keys(legacy).some(k => !['version', 'methods', 'presets'].includes(k)) || (legacy.methods !== undefined && !Array.isArray(legacy.methods)) || (legacy.presets !== undefined && !Array.isArray(legacy.presets))) throw new LocalError('The legacy catalogue field is invalid. Inspect it before migrating.');
      const document = parseDocument(splitFrontmatter(original).yaml); document.delete('catalogue');
      bytes = replaceMetadata(original, isMap(document.contents) && document.contents.items.length ? document.toString() : null);
      const automatic = analyse(bytes.toString('utf8'), request.path, this.options.root);
      const rawDoc = parseGuide(bytes.toString('utf8')), rawHeadings = extractHeadings(rawDoc);
      let migrated: CatalogueOverride | undefined;
      for (const method of legacy.methods ?? []) {
        const stillDetected = automatic.methods.some(m => method.match?.tag ? m.tag === method.match.tag : m.heading.label === method.match?.heading && (!method.match.parents || JSON.stringify(m.heading.parents) === JSON.stringify(method.match.parents)));
        const targetExists = method.match?.tag ? !!rawDoc.tags[method.match.tag] : rawHeadings.some(h => h.label === method.match?.heading && (!method.match.parents || JSON.stringify(h.parents) === JSON.stringify(method.match.parents)));
        if (method.include === false && !stillDetected && targetExists) continue; // General detection rule already handles it.
        migrated = mergeOverride(migrated, { method }, true, bytes.toString('utf8'));
      }
      for (const preset of legacy.presets ?? []) migrated = mergeOverride(migrated, { preset }, true, bytes.toString('utf8'));
      nextOverride = migrated;
      for (const method of Object.values(currentOverride?.methods ?? {})) nextOverride = mergeOverride(nextOverride, { method }, true, bytes.toString('utf8'));
      for (const preset of Object.values(currentOverride?.presets ?? {})) nextOverride = mergeOverride(nextOverride, { preset }, true, bytes.toString('utf8'));
      for (const section of Object.values(currentOverride?.sections ?? {})) nextOverride = mergeOverride(nextOverride, { section }, true, bytes.toString('utf8'));
      if (currentOverride?.types !== undefined) nextOverride = { ...nextOverride, types: currentOverride.types };
      if (currentOverride?.fields) nextOverride = { ...nextOverride, fields: currentOverride.fields };
      beforeYaml = splitFrontmatter(original).yaml; afterYaml = splitFrontmatter(bytes).yaml;
    } else if (target === 'catalogue') {
      if ('clearCatalogue' in request) {
        if (!currentOverride) throw new LocalError('There is no saved catalogue correction for this guide.');
        nextOverride = undefined;
      } else if ('cataloguePatch' in request) nextOverride = mergeOverride(currentOverride, request.cataloguePatch, true, original.toString('utf8'));
      else if ('patch' in request) nextOverride = mergeOverride(currentOverride, request.patch, false);
      else throw new LocalError('Use the fields or guided fix to save a catalogue-only correction. Advanced YAML edits change the guide file.');
      beforeYaml = JSON.stringify(currentOverride ?? {}, null, 2);
      afterYaml = JSON.stringify(nextOverride ?? {}, null, 2);
      if (beforeYaml === afterYaml) throw new LocalError('There are no changes to preview.');
    } else {
      if ('clearCatalogue' in request) throw new LocalError('Removing a catalogue correction requires the catalogue save destination.');
      if ('cataloguePatch' in request) throw new LocalError('Catalogue corrections belong in overrides.json.');
      const yaml = 'patch' in request ? patchMetadata(original, request.patch) : request.yaml;
      if (yaml !== null && typeof yaml !== 'string') throw new LocalError('YAML must be text, or null to remove frontmatter.');
      beforeYaml = splitFrontmatter(original).yaml;
      bytes = replaceMetadata(original, yaml);
      afterYaml = splitFrontmatter(bytes).yaml;
      if (Object.hasOwn(parseGuide(bytes.toString('utf8')).metadata ?? {}, 'catalogue')) throw new LocalError('Catalogue corrections cannot be saved in source YAML. Use the migration action to move the existing catalogue field to overrides.json.');
      if (bytes.equals(original)) throw new LocalError('There are no changes to preview.');
    }
    if (request.operation !== 'metadata') {
      if (to === request.path) throw new LocalError('Choose a different destination.');
      await safePath(this.options.root, to, 'new-file');
    }
    const references = to !== request.path ? await pathReferences(this.options.root, request.path) : [];
    const beforeGuide = applyReviewPolicy(analyseWithOverrides(original.toString('utf8'), request.path, this.options.root, currentOverride), hash, {});
    const afterGuide = applyReviewPolicy(analyseWithOverrides(bytes.toString('utf8'), to, this.options.root, nextOverride), hashBytes(bytes), {});
    const invalid = afterGuide.issues.find(i => i.type === 'invalid-catalogue-override');
    if (invalid) throw new LocalError(`The catalogue correction cannot be applied: ${invalid.message}`);
    const beforeKeys = new Set(beforeGuide.issues.map(i => issueKey(beforeGuide, i))), afterKeys = new Set(afterGuide.issues.map(i => issueKey(afterGuide, i)));
    const classification = (g: typeof beforeGuide) => ({ title: g.title, category: g.category, kind: g.kind ?? 'guide', subject: g.subject?.value ?? null, aliases: g.subjectAliases?.map(a => a.value) ?? [], types: g.types ?? [], styles: g.styles, combatSetups: [...new Set((g.combatSetups ?? []).map(s => s.style === 'Hybrid' ? `Hybrid (${s.components.join(' + ') || 'components unspecified'})` : s.style))], methodTypes: [...new Set(g.methods.flatMap(m => m.type ? [m.type] : []))] });
    const methodDetails = (g: typeof beforeGuide) => new Map(g.methods.map((m, index) => [JSON.stringify(methodMatch(m, g.methods)), { label: m.label, text: `Listed as a method; styles: ${[...new Set((m.combatSetups ?? []).map(s => s.style === 'Hybrid' ? `Hybrid (${s.components.join(' + ')})` : s.style))].join(', ') || 'any / not specified'}; grouping: ${m.context.map(c => c.value).join(' / ') || 'none'}; section link: ${m.tag ?? 'none'}`, index }]));
    const oldMethods = methodDetails(beforeGuide), newMethods = methodDetails(afterGuide);
    const methodChanges = [...new Set([...oldMethods.keys(), ...newMethods.keys()])].flatMap(key => {
      const before = oldMethods.get(key), after = newMethods.get(key);
      return before?.text === after?.text ? [] : [{ label: (after ?? before)!.label, before: before?.text ?? 'Not listed as a method', after: after?.text ?? 'Not listed as a method' }];
    });
    const preview: EditPreview = {
      id: randomUUID(), operation: request.operation, target, from: request.path, to, beforeYaml, afterYaml, references,
      overrideBefore: JSON.stringify(currentOverride ?? {}, null, 2), overrideAfter: JSON.stringify(nextOverride ?? {}, null, 2),
      before: classification(beforeGuide), after: classification(afterGuide),
      methodChanges,
      sectionChanges: [...new Set([...(beforeGuide.sections ?? []).map(s => s.heading.line), ...(afterGuide.sections ?? []).map(s => s.heading.line)])].flatMap(line => { const before = beforeGuide.sections?.find(s => s.heading.line === line), after = afterGuide.sections?.find(s => s.heading.line === line); const oldTypes = before?.types.join(', ') ?? 'Not classified', newTypes = after?.types.join(', ') ?? 'Not classified'; return oldTypes === newTypes ? [] : [{ label: (after ?? before)!.heading.label, before: oldTypes, after: newTypes }]; }),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      bodyUnchanged: request.operation !== 'metadata' || splitFrontmatter(original).body.equals(splitFrontmatter(bytes).body),
      issueChanges: { resolved: beforeGuide.issues.filter(i => !afterKeys.has(issueKey(beforeGuide, i))), remaining: beforeGuide.issues.filter(i => afterKeys.has(issueKey(beforeGuide, i))), introduced: afterGuide.issues.filter(i => !beforeKeys.has(issueKey(afterGuide, i))) },
    };
    for (const [id, entry] of this.pending) if (Date.parse(entry.preview.expiresAt) < Date.now()) this.pending.delete(id);
    if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(preview.id, { preview, hash, bytes, referencesHash: hashBytes(Buffer.from(JSON.stringify(references))), catalogueHash, override: nextOverride });
    return preview;
  }
  async apply(id: string, confirmed: boolean, acknowledgeReferences = false) {
    return this.serial(async () => {
      if (confirmed !== true) throw new LocalError('Explicit confirmation of a preview is required.');
      const pending = this.pending.get(id);
      if (!pending || Date.parse(pending.preview.expiresAt) < Date.now()) throw new LocalError('Preview expired or was already used. Create a new preview.', 409);
      const p = pending.preview;
      const previousCatalogue = await this.state();
      const stateFile = this.options.stateFile ?? defaultStateFile(this.options.root);
      const state = await readCatalogueState(stateFile);
      const overridesFile = this.options.overridesFile ?? defaultOverridesFile();
      const overrides = await readOverrides(overridesFile);
      if (overrideHash(overrides.files[p.from]) !== pending.catalogueHash) throw new LocalError('The saved catalogue correction changed after preview. Create a new preview.', 409);
      if (hashBytes(await readFile(await safePath(this.options.root, p.from))) !== pending.hash) throw new LocalError('Source changed after preview. Create a new preview.', 409);
      if (p.references.length && acknowledgeReferences !== true) throw new LocalError('Acknowledge the reference warning before applying.');
      await safePath(this.options.root, p.from);
      if (p.from !== p.to) {
        const references = await pathReferences(this.options.root, p.from);
        if (hashBytes(Buffer.from(JSON.stringify(references))) !== pending.referencesHash) throw new LocalError('Repository references changed after preview. Create a new preview.', 409);
      }
      if (p.from !== p.to && overrides.files[p.to]) throw new LocalError('The destination has a saved catalogue correction. Remove it before moving this guide.');
      this.pending.delete(id); // No replay or duplicate-submit of a confirmed change.
      const originalOverrides = structuredClone(overrides);
      if (pending.override) overrides.files[p.from] = pending.override; else delete overrides.files[p.from];
      if (p.from !== p.to) {
        if (overrides.files[p.from]) { overrides.files[p.to] = overrides.files[p.from]; delete overrides.files[p.from]; }
        if (state.snapshots[p.from]) { state.snapshots[p.to] = state.snapshots[p.from]; delete state.snapshots[p.from]; }
        for (const resolution of state.resolutions) if (resolution.path === p.from) resolution.path = p.to;
      }
      await writeOverrides(overridesFile, overrides);
      try {
        if (p.target !== 'catalogue' && p.operation === 'metadata') await writeMetadata(this.options.root, p.from, pending.bytes, pending.hash);
        else if (p.target !== 'catalogue') await relocate(this.options.root, p.from, p.to, pending.hash);
      } catch (error) {
        await writeOverrides(overridesFile, originalOverrides);
        throw error;
      }
      state.changes.push({ id: p.id, savedAt: new Date().toISOString(), target: p.target ?? 'guide', operation: p.operation, from: p.from, to: p.to, beforeYaml: p.beforeYaml, afterYaml: p.afterYaml });
      try {
        await writeCatalogueState(stateFile, state);
        this.catalogue = await generate(this.options);
        if (p.from !== p.to) {
          const oldGuide = previousCatalogue.guides.find(g => g.path === p.from), newGuide = this.catalogue.guides.find(g => g.path === p.to);
          if (oldGuide && newGuide && oldGuide.sourceHash === newGuide.sourceHash) {
            const reviewFile = this.options.reviewFile ?? defaultReviewFile(this.options.root), decisions = await readDecisions(reviewFile);
            let changed = false;
            for (const oldIssue of oldGuide.issues) { const record = decisions[oldIssue.id!]; if (!record || record.sourceHash !== oldGuide.sourceHash) continue; const nextIssue = newGuide.issues.find(i => issueKey(newGuide, i) === issueKey(oldGuide, oldIssue)); if (nextIssue?.id) { decisions[nextIssue.id] = record; delete decisions[oldIssue.id!]; changed = true; } }
            if (changed) { await writeDecisions(reviewFile, decisions); this.catalogue = await generate(this.options); }
          }
        }
        return { applied: true as const, path: p.to, catalogue: this.catalogue, reanalysisError: null };
      } catch (error) {
        this.catalogue = null;
        return { applied: true as const, path: p.to, catalogue: null, reanalysisError: `The change was saved, but updating the catalogue/history failed: ${String(error)}. Refresh the catalogue; do not repeat the edit.` };
      }
    });
  }
  async decide(id: string, sourceHash: string, decision: ReviewDecision | 'reopen') {
    return this.serial(async () => {
      if (!['reviewed', 'dismissed', 'reopen'].includes(decision)) throw new LocalError('Invalid review decision.');
      const catalogue = await generate(this.options);
      const guide = catalogue.guides.find(g => g.issues.some(i => i.id === id));
      if (!guide || guide.sourceHash !== sourceHash) throw new LocalError('This issue has changed. Refresh the catalogue before reviewing it.', 409);
      const file = this.options.reviewFile ?? defaultReviewFile(this.options.root);
      const decisions = await readDecisions(file);
      if (decision === 'reopen') delete decisions[id];
      else decisions[id] = { decision, sourceHash, updatedAt: new Date().toISOString() };
      await writeDecisions(file, decisions);
      return this.catalogue = await generate(this.options);
    });
  }
}
export async function createLocalService(options: Options) {
  return new LocalService({ ...options, root: await realpath(options.root) });
}
