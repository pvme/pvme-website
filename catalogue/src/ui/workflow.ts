import type { Catalogue, Guide, Issue } from '../schema';
import type { EditPreview } from '../local/service';

export interface ReviewRow { id: string; guide: Guide; issue?: Issue; resolvedAt?: string }
export type EditAction = 'metadata' | 'move' | 'rename' | 'migrate' | 'reset-override';
export type CorrectionMode = 'preset' | 'styles' | 'method' | 'context' | 'anchor' | 'declare' | 'details' | 'section';
export interface NextAction { action: EditAction | 'inspect' | 'vscode'; label: string; fields?: string[]; correction?: CorrectionMode }
export function nextActions(issue: Issue, guide?: Guide): NextAction[] {
  if (issue.type === 'ambiguous-subject') return [{ action: 'metadata', label: 'Set the full encounter name', fields: ['subject'] }];
  if (issue.type === 'likely-missing-method') return [{ action: 'metadata', label: 'Choose whether to include this method', correction: 'declare' }];
  if (issue.type === 'legacy-catalogue-metadata') return [{ action: 'migrate', label: 'Preview migration to overrides.json' }];
  if (issue.type === 'invalid-catalogue-override') return [{ action: 'reset-override', label: 'Remove the saved catalogue correction' }];
  if (guide?.kind === 'boss-overview' && !(issue.methodId ? guide.methods.some(m => m.id === issue.methodId) : guide.methods.length) && ['ambiguous-method', 'context-review', 'multiple-anchors', 'ambiguous-preset-scope', 'ambiguous-style-combination'].includes(issue.type)) return [{ action: 'inspect', label: 'Read the overview text' }];
  if (issue.type === 'unknown-category') return [{ action: 'metadata', label: 'Choose a category', fields: ['category'] }, { action: 'move', label: 'Move to the right folder' }];
  if (issue.type.includes('FRONTMATTER')) return [{ action: 'metadata', label: 'Repair YAML details' }];
  if (issue.type === 'ambiguous-preset-scope') return [{ action: 'metadata', label: 'Choose which methods use this preset', correction: 'preset' }];
  if (issue.type === 'ambiguous-method') return [{ action: 'metadata', label: 'Choose whether this is a method', correction: 'method' }];
  if (issue.type === 'context-review') return [{ action: 'metadata', label: 'Choose the section grouping', correction: 'context' }];
  if (issue.type === 'no-methods') return [{ action: 'metadata', label: 'Choose a method heading', correction: 'declare' }];
  if (['unknown-style', 'ambiguous-style-combination'].includes(issue.type)) return [{ action: 'metadata', label: 'Set the combat styles', correction: 'styles' }, ...(issue.type === 'unknown-style' && guide?.methods.length === 1 ? [{ action: 'rename' as const, label: 'Add the style to the filename' }] : [])];
  if (['missing-anchor', 'multiple-anchors'].includes(issue.type)) return [{ action: 'metadata', label: 'Choose a section link', correction: 'anchor' }];
  if (issue.type === 'parse-failure' || issue.type.includes('DUPLICATE_TAG')) return [{ action: 'vscode', label: 'Edit in VS Code' }];
  return [{ action: 'inspect', label: issue.type === 'context-review' ? 'Compare the headings' : 'Read the relevant text' }];
}
export function catalogueRows(catalogue: Catalogue, mode: 'queue' | 'guides'): ReviewRow[] {
  const current = catalogue.guides.flatMap(g => mode === 'guides' ? [{ id: g.id, guide: g }] : g.issues.map(i => ({ id: i.id!, guide: g, issue: i })));
  if (mode === 'guides') return current;
  const historical: ReviewRow[] = (catalogue.resolutions ?? []).filter(r => !r.reopenedAt && !current.some(row => row.id === r.issue.id)).map(r => {
    const guide = catalogue.guides.find(g => g.path === r.path) ?? { id: r.id, title: r.title, path: r.path, absolutePath: `${catalogue.sourceRoot}/${r.path}`, category: 'History', subject: null, metadata: null, styles: [], attributes: [], methods: [], issues: [], status: 'classified' as const, excludedReason: null, parsed: { sections: 0, messages: 0, tags: 0, diagnostics: [] } };
    return { id: r.issue.id ?? r.id, guide, issue: r.issue, resolvedAt: r.resolvedAt };
  });
  return [...current, ...historical];
}
export function keepSelection(visible: ReviewRow[], selected?: ReviewRow): ReviewRow | undefined {
  // Filtering changes the queue, not the item being worked on.
  return selected ?? visible[0];
}
export interface CheckResult { state: 'resolved' | 'unresolved' | 'missing'; row: ReviewRow; message: string }
export function followUp(catalogue: Catalogue, previous: ReviewRow, newPath = previous.guide.path): CheckResult {
  const guide = catalogue.guides.find(g => g.path === newPath);
  if (!guide) {
    const row = newPath === previous.guide.path ? previous : { ...previous, guide: { ...previous.guide, path: newPath, absolutePath: `${catalogue.sourceRoot.replace(/[\\/]+$/, '')}/${newPath}` } };
    return { state: 'missing', row, message: 'This file is no longer in the catalogue. It may have been moved, deleted or excluded. The last known guide details are shown here.' };
  }
  if (!previous.issue) return { state: 'unresolved', row: { id: guide.id, guide }, message: `Guide checked. ${guide.issues.filter(i => !i.decision && i.reviewLevel !== 'info').length} items still need attention.` };
  const oldMethod = [...previous.guide.methods, ...(previous.guide.inspectionCandidates ?? [])].find(m => m.id === previous.issue!.methodId);
  const candidates = guide.issues.filter(i => {
    if (i.type !== previous.issue!.type) return false;
    if (!previous.issue!.methodId) return !i.methodId;
    if (!oldMethod) return true;
    return [...guide.methods, ...(guide.inspectionCandidates ?? [])].some(m => m.id === i.methodId && (m.id === oldMethod.id || m.label === oldMethod.label));
  });
  const issue = guide.issues.find(i => i.id === previous.issue!.id) ?? candidates.sort((a, b) => Math.abs((a.line ?? 1) - (previous.issue!.line ?? 1)) - Math.abs((b.line ?? 1) - (previous.issue!.line ?? 1)))[0];
  if (!issue) return { state: 'resolved', row: { ...previous, guide }, message: 'Resolved. This issue no longer appears in the guide.' };
  return { state: 'unresolved', row: { id: issue.id!, guide, issue }, message: issue.decision ? 'This check is still present in the file, but you have already reviewed it.' : 'Still needs attention. This issue is still present in the guide.' };
}
export function canConfirm(preview: EditPreview | null, confirmed: boolean, referencesChecked: boolean, busy: boolean, now = Date.now()): boolean {
  return !!preview && preview.bodyUnchanged && Date.parse(preview.expiresAt) > now && confirmed && (!preview.references.length || referencesChecked) && !busy;
}
