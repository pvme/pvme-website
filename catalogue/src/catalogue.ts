import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { analyseReference, isReferencePath, type ReferenceRecord } from './quick-reference';
import { analyse, exclusionReason, stableId } from './detect';
import { RULES_VERSION } from './rules';
import type { Catalogue, Guide, Issue } from './schema';
import { applyReviewPolicy, classifyIssue, isOpenIssue, reviewSummary, REVIEW_VERSION } from './review';
import { defaultReviewFile, readDecisions } from './review-store';
import { atomicWrite } from './output';
import { GUIDE_TYPES } from './guide-types';
import { canonicaliseSubjects } from './subjects';
import { publicCatalogue, serializePublicCatalogue } from './public-catalogue';
import { defaultStateFile, readCatalogueState, recordResolutions, writeCatalogueState } from './catalogue-state';
import { analyseWithOverrides, defaultOverridesFile, readOverrides, overrideHash } from './overrides';
export { atomicWrite } from './output';

interface Cache { version: string; root: string; files: Record<string, { hash: string; guide: Guide }>; references?: Record<string, { hash: string; record: ReferenceRecord }> }
export interface Options { root: string; output?: string; cacheDir?: string; reviewFile?: string; stateFile?: string; overridesFile?: string; force?: boolean; includeExcluded?: boolean; parserVersion?: string }
async function discover(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const result: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) result.push(...await discover(root, path));
    else if (e.isFile() && (e.name.toLowerCase().endsWith('.txt') || (isReferencePath(path) && !extname(e.name)))) result.push(path);
  }
  return result;
}
export async function generate(options: Options): Promise<Catalogue> {
  const root = resolve(options.root);
  const output = resolve(options.output ?? 'public/data');
  const cacheDir = resolve(options.cacheDir ?? '.cache');
  const parserPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('@pvme/guide-parser')), 'utf8')) as { version: string };
  const version = `${RULES_VERSION}:parser-${options.parserVersion ?? parserPackage.version}:schema-1`;
  await mkdir(output, { recursive: true }); await mkdir(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, 'files.json');
  let old: Cache = { version, root, files: {} };
  try { const c = JSON.parse(await readFile(cacheFile, 'utf8')) as Cache; if (c.version === version && c.root === root) old = c; } catch { /* absent or corrupt cache: safe full parse */ }
  const paths = await discover(root);
  const decisions = await readDecisions(options.reviewFile ?? defaultReviewFile(root));
  const stateFile = options.stateFile ?? defaultStateFile(root);
  const state = await readCatalogueState(stateFile);
  const overrides = await readOverrides(options.overridesFile ?? defaultOverridesFile());
  const next: Cache = { version, root, files: {}, references: {} };
  const quickReferences: NonNullable<Catalogue['quickReferences']> = [];
  const referenceAudit: NonNullable<Catalogue['referenceAudit']> = { excluded: [], warnings: [] };
  let guides: Guide[] = [];
  let parsed = 0, reused = 0;
  const excluded = paths.filter(p => !isReferencePath(p) && exclusionReason(p));
  for (const path of paths) {
    if (isReferencePath(path)) {
      const source = await readFile(join(root, path), 'utf8');
      const hash = createHash('sha256').update(source).update(overrideHash(overrides.files[path])).digest('hex');
      const existing = old.references?.[path];
      const record = !options.force && existing?.hash === hash ? existing.record : analyseReference(source, path, overrides.files[path]?.reference);
      if (!options.force && existing?.hash === hash) reused++; else parsed++;
      next.references![path] = { hash, record };
      if (record.entry) {
        if (quickReferences.some(r => r.id === record.entry!.id)) throw new Error(`Duplicate quick-reference ID: ${record.entry.id}. Check source filenames.`);
        quickReferences.push(record.entry);
      }
      if (record.excluded) referenceAudit.excluded.push({ path, reason: record.excluded });
      referenceAudit.warnings.push(...record.warnings.map(reason => ({ path, reason })));
      continue;
    }
    if (!options.includeExcluded && exclusionReason(path)) continue;
    const bytes = await readFile(join(root, path));
    const source = bytes.toString('utf8');
    const hash = createHash('sha256').update(source).update(overrides.files[path] ? overrideHash(overrides.files[path]) : '').digest('hex');
    const existing = old.files[path];
    let guide: Guide;
    if (!options.force && existing?.hash === hash) { guide = existing.guide; reused++; }
    else {
      parsed++;
      try { guide = analyseWithOverrides(source, path, root, overrides.files[path]); }
      catch (error) {
        guide = { id: `guide-${stableId(path)}`, path, absolutePath: resolve(root, path), title: path, category: 'Unclassified', subject: null, metadata: null, styles: [], attributes: [], methods: [], status: 'error', excludedReason: exclusionReason(path), parsed: { sections: 0, messages: 0, tags: 0, diagnostics: [] }, issues: [{ path, type: 'parse-failure', severity: 'error', message: String(error) }] };
      }
    }
    next.files[path] = { hash, guide }; guides.push(applyReviewPolicy(guide, hash, decisions));
  }
  guides = canonicaliseSubjects(guides).map(g => { const issues = g.issues.map(i => i.id ? i : classifyIssue(g, i, decisions)); return { ...g, issues, status: g.status === 'error' || g.status === 'excluded' ? g.status : issues.some(isOpenIssue) ? 'review' : 'classified' }; });
  const publicGuides = guides.filter(g => !g.excludedReason);
  const methods = publicGuides.flatMap(g => g.methods);
  const deleted = [...Object.keys(old.files), ...Object.keys(old.references ?? {})].filter(p => !paths.includes(p)).length;
  const catalogue: Catalogue = {
    schemaVersion: 1, rulesVersion: RULES_VERSION, sourceRoot: root, generatedAt: new Date().toISOString(),
    quickReferences: quickReferences.sort((a, b) => a.title.localeCompare(b.title)), referenceAudit,
    run: { analysed: guides.length + Object.keys(next.references!).length, parsed, reused, deleted, excluded: excluded.length + referenceAudit.excluded.length, forced: !!options.force },
    stats: { total: paths.length, eligible: publicGuides.length, classified: publicGuides.filter(g => g.category !== 'Unclassified' && g.status !== 'error').length,
      multipleMethods: publicGuides.filter(g => g.methods.length > 1).length, ambiguous: publicGuides.filter(g => g.issues.some(i => isOpenIssue(i) && ['ambiguous-method', 'context-review', 'unknown-category'].includes(i.type))).length,
      review: publicGuides.filter(g => g.issues.some(isOpenIssue)).length, methods: methods.length,
      confidence: { High: methods.filter(m => m.confidence === 'High').length, Medium: methods.filter(m => m.confidence === 'Medium').length, Low: methods.filter(m => m.confidence === 'Low').length } }, guides,
  };
  catalogue.reviewSummary = reviewSummary(guides);
  recordResolutions(state, guides);
  await writeCatalogueState(stateFile, state);
  catalogue.resolutions = state.resolutions;
  catalogue.changes = state.changes;
  catalogue.catalogueCorrections = Object.keys(overrides.files);
  catalogue.reviewPolicyVersion = REVIEW_VERSION;
  const issues = guides.flatMap(g => g.issues);
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) groups.set(issue.type, [...(groups.get(issue.type) ?? []), issue]);
  const typeSummary = Object.fromEntries(GUIDE_TYPES.map(type => [type, publicGuides.filter(g => g.types?.includes(type)).length]));
  const diagnostics = guides.flatMap(g => g.diagnostics ?? []);
  await atomicWrite(join(output, 'reference-audit.json'), { references: quickReferences.length, ...referenceAudit });
  const audit = { schemaVersion: 1, diagnostics, typeSummary, classifications: publicGuides.map(g => ({ path: g.path, types: g.types ?? [], sections: (g.sections ?? []).map(s => ({ heading: s.heading.label, line: s.heading.line, tag: s.tag, types: s.types })) })), reviewPolicyVersion: REVIEW_VERSION, generatedAt: catalogue.generatedAt, stats: catalogue.stats, reviewSummary: catalogue.reviewSummary, excluded: excluded.map(path => ({ path, reason: exclusionReason(path) })), issues };
  const md = ['# PvME Catalogue Audit', '', `Generated: ${catalogue.generatedAt}`, '', `${publicGuides.length} eligible guides; ${methods.length} methods; ${catalogue.stats.review} files have open action/review findings.`, '', `Action required: ${catalogue.reviewSummary.action}; needs review: ${catalogue.reviewSummary.review}; informational: ${catalogue.reviewSummary.info}; reviewed: ${catalogue.reviewSummary.reviewed}; dismissed: ${catalogue.reviewSummary.dismissed}.`, '', `Excluded by default: ${excluded.length} files. Run with --include-excluded to inspect them.`, '', '## Technical diagnostics', '', `${diagnostics.length} non-actionable source/preset diagnostics are available in audit.json and the inspector technical panel. Valid style-agnostic methods, generated anchors and reference guides do not create findings.`, '', '## Guide types', '', 'Files may count under more than one type.', '', ...Object.entries(typeSummary).map(([type, count]) => `- ${type}: ${count}`), '', ...[...groups].sort(([a], [b]) => a.localeCompare(b)).flatMap(([type, list]) => [`## ${type} (${list.length})`, '', ...list.map(i => `- \`${i.path}${i.line ? `:${i.line}` : ''}\` [${i.decision ?? i.reviewLevel}] — ${i.explanation} ${i.impact} Suggested next step: ${i.correction}`), ''])].join('\n');
  await atomicWrite(join(output, 'catalogue.json'), serializePublicCatalogue(publicCatalogue(catalogue)), true);
  await atomicWrite(join(output, 'inspector.json'), catalogue);
  await atomicWrite(join(output, 'audit.json'), audit);
  await atomicWrite(join(output, 'audit.md'), md, true);
  await atomicWrite(cacheFile, next);
  return catalogue;
}
