import './style.css';
import { GUIDE_TYPES } from '../guide-types';
import { publicCatalogue, catalogueEntries } from '../public-catalogue';
import { browseDetailView, browseFiltersView, browseListView, emptyBrowseFilters, filterCatalogue, methodMatches } from './catalogue-browser';
import type { Catalogue, Guide, Issue } from '../schema';
import { classifyIssue, DECISION_LABELS, issueLabel, LEVEL_LABELS } from '../review';
import { issueSources } from '../issue-sources';
import type { EditPreview } from '../local/service';
import { badge, esc, sourceLabel, vscode } from './html';
import { correctionPatch } from './correction-editor';
import { editorView, type EditorState, type SourceFile } from './editor';
import { guideSummary, methodsView, technicalView } from './details';
import { canConfirm, catalogueRows, followUp, keepSelection, nextActions, type CheckResult, type EditAction, type CorrectionMode, type ReviewRow } from './workflow';

const app = document.querySelector<HTMLDivElement>('#app')!;
let catalogue: Catalogue;
let token = '', online = false;
let mode: 'queue' | 'guides' | 'catalogue' = 'queue';
let selected: ReviewRow | undefined;
let query = '', severity = 'open', status = 'active', typeFilter = '', excluded = false, page = 0;
let source: SourceFile | null = null, sourceError = '', sourceLoading = '', sourceSequence = 0;
let editor: EditAction | null = null, editorFields: string[] | undefined, correction: CorrectionMode | undefined;
let yamlMode: 'simple' | 'advanced' = 'simple', drafts: Record<string, string> = {}, folders: string[] = [];
let preview: EditPreview | null = null, formError = '', errorMessage = '', notice = '', busy = false, inspected = false;
let outcome: CheckResult | null = null, saveNote = '';
let detailRowId = '';
let correctionIssue: Issue | undefined;
let editCatalogueFields = false;
const PAGE_SIZE = 30;
let browseFilters = emptyBrowseFilters(), browseSelectedId = '', browsePage = 0, browseRenderedId = '';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/local/${path}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token }, body: JSON.stringify(body),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Start npm run dev to use local editing.');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result as T;
}
function rowState(row: ReviewRow) { return !!row.resolvedAt ? 'resolved' : row.issue?.decision ?? 'active'; }
function rows(): ReviewRow[] {
  const all = catalogueRows(catalogue, mode === 'catalogue' ? 'guides' : mode);
  const q = query.trim().toLowerCase();
  return all.filter(row => {
    const g = row.guide, i = row.issue;
    if (excluded ? !g.excludedReason : !!g.excludedReason) return false;
    if (i) {
      if (severity === 'open' && i.reviewLevel === 'info') return false;
      if (!['open', 'all'].includes(severity) && severity !== i.reviewLevel) return false;
      if (typeFilter && typeFilter !== i.type) return false;
      if (status !== 'all' && rowState(row) !== status) return false;
    }
    return !q || [g.title, g.path, g.category, g.subject?.value, ...(g.subjectAliases ?? []).map(a => a.value), ...g.styles,
      i ? issueLabel(i.type) : '', i?.explanation, ...g.methods.map(m => m.label), ...(g.combatSetups ?? []).flatMap(s => [s.label, ...s.components])].join(' ').toLowerCase().includes(q);
  }).sort((a, b) => ({ action: 0, review: 1, info: 2 }[a.issue?.reviewLevel ?? 'info'] - { action: 0, review: 1, info: 2 }[b.issue?.reviewLevel ?? 'info']) || a.guide.path.localeCompare(b.guide.path) || (a.issue?.rootCause ?? a.issue?.type ?? '').localeCompare(b.issue?.rootCause ?? b.issue?.type ?? ''));
}
function resetWork() {
  editCatalogueFields = false; correctionIssue = undefined; drafts = {}; editor = null; editorFields = undefined; correction = undefined; preview = null; formError = ''; errorMessage = ''; outcome = null; saveNote = ''; inspected = false;
  sourceError = '';
}
function choose(row: ReviewRow, focusDetails = false) {
  if (selected?.id !== row.id) {
    if (selected?.guide.path !== row.guide.path) { source = null; sourceError = ''; sourceLoading = ''; sourceSequence++; }
    resetWork(); selected = row;
  }
  renderList();
  if (focusDetails) document.querySelector<HTMLElement>('#detail-title')?.focus();
  else document.querySelector<HTMLElement>('.queue-row[aria-current="true"]')?.focus({ preventScroll: true });
}
function buttonDisabled() { return !online || busy ? 'disabled' : ''; }
function sidebarView() { return `<aside class="sidebar"><a class="brand" href="#"><b>P</b><span>PvME<small>Guide catalogue</small></span></a>
  <nav aria-label="Main navigation"><button data-mode="catalogue" aria-current="${mode === 'catalogue' ? 'page' : 'false'}">Catalogue</button><button data-mode="queue" aria-current="${mode === 'queue' ? 'page' : 'false'}">Review queue</button><button data-mode="guides" aria-current="${mode === 'guides' ? 'page' : 'false'}">All guides</button></nav>
  <div class="sidebar-bottom"><span class="connection"><i></i>${online ? 'Local editing' : 'Viewing only'}</span><details><summary>Reports</summary><a href="/data/audit.md" download>Download audit</a><a href="/data/catalogue.json" download>Website catalogue JSON</a><a href="/data/inspector.json" download>Full inspector JSON</a></details></div></aside>`; }
function renderCatalogue() {
  const guides = catalogueEntries(publicCatalogue(catalogue));
  app.innerHTML = `<a class="skip-link" href="#detail-title">Skip to selected guide</a>${sidebarView()}<main><header class="page-header"><div><h1>Catalogue</h1><p>Explore ${guides.length} guides and ${guides.reduce((sum, g) => sum + g.methods.length, 0)} methods.</p></div><button id="refresh" ${!online || busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Refresh catalogue'}</button></header>${notice ? `<p class="global-notice" role="status">${esc(notice)}</p>` : ''}<div id="browse-feedback">${errorMessage ? `<div class="notice error" role="alert">${esc(errorMessage)}</div>` : ''}</div>${browseFiltersView(guides, browseFilters)}<div class="workspace catalogue-workspace"><section class="queue" aria-label="Catalogue results"><div class="browse-count" id="browse-count" role="status"></div><div id="browse-list"></div><p class="keyboard-hint">↑ ↓ to browse · Enter for details · / to search</p></section><section class="detail" id="detail" aria-label="Selected catalogue guide"></section></div><footer>This is the website catalogue. Use Manage this guide to edit its source or save catalogue corrections.</footer></main>`;
  renderCatalogueResults();
}
function renderCatalogueResults() {
  const panel = document.querySelector<HTMLElement>('#detail')!;
  const openMethods = new Set([...panel.querySelectorAll<HTMLDetailsElement>('details[data-browse-method-id][open]')].map(d => d.dataset.browseMethodId));
  const guides = catalogueEntries(publicCatalogue(catalogue)), matches = filterCatalogue(guides, browseFilters);
  const selectedGuide = guides.find(g => g.id === browseSelectedId) ?? matches[0];
  browseSelectedId = selectedGuide?.id ?? '';
  browsePage = Math.min(browsePage, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1));
  document.querySelector('#browse-count')!.textContent = `${matches.length} ${matches.length === 1 ? 'guide' : 'guides'} · ${matches.reduce((sum, g) => sum + g.methods.filter(m => methodMatches(m, browseFilters)).length, 0)} ${browseFilters.style || browseFilters.attribute || browseFilters.methodType ? 'matching methods' : 'methods'}`;
  document.querySelector('#browse-list')!.innerHTML = browseListView(matches, browseSelectedId, browsePage, PAGE_SIZE);
  panel.innerHTML = browseDetailView(selectedGuide, browseFilters, !!selectedGuide && !matches.some(g => g.id === selectedGuide.id), guides);
  if (browseRenderedId === browseSelectedId) { for (const details of panel.querySelectorAll<HTMLDetailsElement>('details[data-browse-method-id]')) if (openMethods.has(details.dataset.browseMethodId)) details.open = true; }
  else panel.scrollTop = 0;
  browseRenderedId = browseSelectedId;
}
function render() {
  if (mode === 'catalogue') { renderCatalogue(); return; }
  const types = [...new Set(catalogue.guides.filter(g => !g.excludedReason).flatMap(g => g.issues.map(i => i.type)))].sort((a, b) => issueLabel(a).localeCompare(issueLabel(b)));
  app.innerHTML = `<a class="skip-link" href="#detail-title">Skip to selected issue</a>${sidebarView()}
  <main><header class="page-header"><div><h1>${mode === 'queue' ? 'Review queue' : 'All guides'}</h1><p>${mode === 'queue' ? 'One issue at a time. Check it, fix it, then move on.' : 'Browse guides and manage their local files.'}</p></div><button id="refresh" ${!online || busy || editor ? 'disabled' : ''}>${busy ? 'Working…' : 'Refresh queue'}</button></header>
  ${!online ? '<div class="notice info">Viewing saved results. Start <code>npm run dev</code> to edit files and save review decisions.</div>' : ''}
  <div id="global-feedback" role="status">${notice ? `<p class="global-notice">${esc(notice)}</p>` : ''}</div>
  <div class="workspace"><section class="queue" aria-label="${mode === 'queue' ? 'Issue queue' : 'Guide list'}"><div class="queue-tools"><label class="search-label" for="search">${mode === 'queue' ? 'Find an issue' : 'Find a guide'}</label><input id="search" type="search" placeholder="Guide name, file or keyword" value="${esc(query)}" autocomplete="off">
  ${mode === 'queue' ? `<div class="filters"><label>Priority<select id="severity"><option value="open">Needs attention</option><option value="action">Fix needed</option><option value="review">Check this</option><option value="info">Optional</option><option value="all">All priorities</option></select></label><label>Status<select id="status"><option value="active">Unresolved</option><option value="reviewed">Checked</option><option value="dismissed">Ignored</option><option value="resolved">Resolved</option><option value="all">All statuses</option></select></label><label class="wide-filter">Issue type<select id="issue-type"><option value="">All issue types</option>${types.map(type => `<option value="${esc(type)}">${esc(issueLabel(type))}</option>`).join('')}</select></label></div>` : `<label class="check-label"><input id="excluded" type="checkbox" ${excluded ? 'checked' : ''}>Show excluded files</label>`}
  <div class="queue-count"><span id="result-count"></span><button id="reset" class="quiet">Clear filters</button></div></div><ul id="results" class="issue-list" aria-label="${mode === 'queue' ? 'Issues' : 'Guides'}"></ul><div id="pagination"></div><p class="keyboard-hint">↑ ↓ to browse · Enter to read · / to search</p></section>
  <section class="detail" id="detail" aria-label="Selected issue"></section></div><footer>Catalogue corrections are saved in overrides.json. Source guide changes require a separate preview and confirmation.</footer></main>`;
  if (mode === 'queue') {
    (document.querySelector('#severity') as HTMLSelectElement).value = severity;
    (document.querySelector('#status') as HTMLSelectElement).value = status;
    (document.querySelector('#issue-type') as HTMLSelectElement).value = typeFilter;
  }
  renderList();
}
function stateBadge(row: ReviewRow) {
  const state = rowState(row);
  return state === 'resolved' ? badge('Resolved', 'resolved') : row.issue?.decision ? badge(DECISION_LABELS[row.issue.decision], state) : row.issue ? badge(LEVEL_LABELS[row.issue.reviewLevel!], row.issue.reviewLevel) : badge(row.guide.category);
}
function renderList() {
  const list = rows();
  selected = keepSelection(list, selected);
  page = Math.min(page, Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1));
  document.querySelector('#result-count')!.textContent = `${list.length} ${mode === 'queue' ? 'issues' : 'guides'}`;
  const visible = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const tabbable = visible.find(row => row.id === selected?.id)?.id ?? visible[0]?.id;
  document.querySelector('#results')!.innerHTML = visible.length ? visible.map((row, index) => `${mode === 'queue' && row.issue && (index === 0 || visible[index - 1].guide.path !== row.guide.path || (visible[index - 1].issue?.rootCause ?? visible[index - 1].issue?.type) !== (row.issue.rootCause ?? row.issue.type)) ? `<li class="queue-group"><h3>${esc(row.guide.title)}</h3><span>${esc(row.issue.rootCause ?? issueLabel(row.issue.type))} · ${list.filter(r => r.guide.path === row.guide.path && (r.issue?.rootCause ?? r.issue?.type) === (row.issue?.rootCause ?? row.issue?.type)).length} findings</span></li>` : ''}<li><button data-row="${esc(row.id)}" class="queue-row ${selected?.id === row.id ? 'selected' : ''} state-${rowState(row)}" aria-current="${selected?.id === row.id}" tabindex="${row.id === tabbable ? 0 : -1}"><span class="row-status">${stateBadge(row)}</span><strong>${esc(row.issue ? [...row.guide.methods, ...(row.guide.inspectionCandidates ?? [])].find(m => m.id === row.issue!.methodId)?.label ?? issueLabel(row.issue.type) : row.guide.title)}</strong><span class="row-description">${row.issue ? esc(row.issue.explanation || issueLabel(row.issue.type)) : `${row.guide.methods.length} methods · ${esc(row.guide.subject?.value || row.guide.category)}`}</span><span class="row-path">${esc(row.guide.path)}${row.issue?.line ? `:${row.issue.line}` : ''}</span></button></li>`).join('') : `<li class="empty"><h2>No matches</h2><p>Try another filter or search.</p></li>`;
  document.querySelector('#pagination')!.innerHTML = list.length > PAGE_SIZE ? `<div class="pagination"><button data-page="-1" ${page === 0 ? 'disabled' : ''} aria-label="Previous page">← Previous</button><span>${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, list.length)}</span><button data-page="1" ${(page + 1) * PAGE_SIZE >= list.length ? 'disabled' : ''} aria-label="Next page">Next →</button></div>` : '';
  renderDetail();
}
const step = (n: number, title: string, body: string) => `<section class="workflow-step" id="step-${n}" aria-labelledby="step-title-${n}"><div class="step-heading"><span class="step-number" aria-hidden="true">${n}</span><h3 id="step-title-${n}">${title}</h3></div><div class="step-body">${body}</div></section>`;
function saveTarget(): 'guide' | 'catalogue' { return editCatalogueFields || !!correction || editor === 'reset-override' || (editor === 'metadata' && !!selected?.issue && !selected.issue.type.includes('FRONTMATTER')) ? 'catalogue' : 'guide'; }
function editState(): EditorState { return { target: saveTarget(), kind: editor!, source, sourceError, yamlMode, drafts, folders, fields: editorFields, correction, issue: correctionIssue ?? selected?.issue, busy, preview, error: formError }; }
function categories() { return [...new Set(catalogue.guides.map(g => g.category))].sort(); }
function actionButton(action: ReturnType<typeof nextActions>[number], primary: boolean, g: Guide, i: Issue) {
  if (action.action === 'vscode') return `<a class="button ${primary ? 'primary' : ''}" href="${esc(vscode(g, i.line))}">${esc(action.label)} ↗</a>`;
  return `<button ${action.action === 'inspect' ? 'id="inspect"' : `data-edit="${action.action}"`} class="${primary ? 'primary' : ''}" ${action.action === 'inspect' ? '' : buttonDisabled()}>${esc(action.label)}</button>`;
}
function renderDetail() {
  const panel = document.querySelector('#detail')!;
  const openDetails = new Set(detailRowId === selected?.id ? [...panel.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.querySelector('summary')?.textContent) : []);
  const row = selected;
  if (!row) { panel.innerHTML = '<div class="empty"><h2 id="detail-title" tabindex="-1">Choose an issue</h2><p>Select an item in the queue to get started.</p></div>'; return; }
  const g = row.guide, i = row.issue;
  const hidden = !rows().some(r => r.id === row.id);
  const complete = rowState(row) !== 'active';
  const actions = i ? nextActions(i, g) : [];
  const editorHTML = editor ? editorView(g, editState(), categories()) : '';
  panel.innerHTML = `<div class="detail-header"><div class="detail-status">${stateBadge(row)}${i ? `<span>${esc(issueLabel(i.type))}</span>` : ''}</div><h2 id="detail-title" tabindex="-1">${esc(g.title)}</h2><p class="path">${esc(g.path)}</p></div>
  <div class="detail-content">${hidden ? `<div class="selection-note">This selection is hidden by the queue filters. <button id="show-selected" class="quiet">Show in queue</button></div>` : ''}
  <div id="detail-feedback" aria-live="polite">${errorMessage ? `<div class="notice error" role="alert"><strong>Something needs checking</strong><p>${esc(errorMessage)}</p></div>` : ''}${saveNote ? `<div class="notice success"><strong>${esc(saveNote)}</strong></div>` : ''}</div>
  ${i ? `${step(1, 'The issue', `<p class="lead">${esc(i.explanation)}</p><p>${esc(i.impact)}</p>${i.contradictingEvidence?.length ? `<div class="finding-evidence"><h4>Why it needs a check</h4><p>${i.contradictingEvidence.map(esc).join(' ')}</p>${i.supportingEvidence?.length ? `<details><summary>What supports the detection</summary><ul>${i.supportingEvidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}</div>` : ''}${outcome?.state === 'resolved' ? '<p class="hint">This was the original issue. It is now resolved.</p>' : ''}<details id="source-details" class="source-details"><summary>Read the relevant guide text</summary>${issueSources(g, i).map(s => `<div class="source-heading"><span>${esc(sourceLabel(s.kind))}</span><code>${esc(s.text)}</code><a href="${esc(vscode(g, s.line))}">Line ${s.line} ↗</a></div>`).join('')}<div id="source-excerpt">${source?.path === g.path ? excerpt(i, g) : `<p class="muted">${esc(sourceError || (online ? 'Loading guide text…' : 'Open the file in VS Code to read the source.'))}</p>`}</div></details>`)}
  ${step(2, 'Actions and fixes', `<p>${esc(i.correction)}</p>${!complete ? `<div class="action-row">${actions.map((action, index) => actionButton(action, index === 0 && !editor && !inspected && !outcome, g, i)).join('')}</div>` : `<p class="hint">${rowState(row) === 'resolved' ? 'This issue no longer needs a fix.' : 'This item has been checked or ignored. Reopen it below if needed.'}</p>`}<div id="editor">${editorHTML}</div>${saveNote && !editor ? '<p class="preserved">Your change has been saved.</p>' : ''}<div class="review-actions" role="group" aria-label="Review actions"><h4>Other actions</h4><div class="action-row">${i.decision ? `<button data-decision="reopen" ${buttonDisabled()}>Reopen item</button>` : outcome?.state !== 'resolved' ? `<button data-decision="reviewed" ${buttonDisabled()}>Looks right</button><button data-decision="dismissed" class="quiet" ${buttonDisabled()}>Ignore</button>` : ''}${complete || !actions.some(action => action.action === 'vscode') ? `<a href="${esc(vscode(g, i.line))}">Open in VS Code ↗</a>` : ''}<button id="view-guide" class="quiet">View guide</button></div>${!complete ? '<p class="hint">Looks right and Ignore record your decision. They do not change the file.</p>' : ''}</div>`)}
  ${step(3, 'Check again', `<p>Saved changes and resolutions survive restarts. Check this guide to update its results.</p><div class="action-row"><button id="check-guide" class="${!editor && (inspected || saveNote || outcome) ? 'primary' : ''}" ${!online || busy || editor ? 'disabled' : ''}>${busy ? 'Checking…' : 'Check this guide'}</button>${complete || outcome?.state === 'resolved' ? '<button id="next-item">Next issue →</button>' : ''}</div>${editor ? '<p class="hint">Save or cancel your prepared change first.</p>' : ''}${outcome ? `<div class="check-result ${outcome.state}" role="status"><strong>${outcome.state === 'resolved' ? '✓ Resolved' : outcome.state === 'unresolved' ? 'Still present' : 'File not found'}</strong><p>${esc(outcome.message)}</p></div>` : ''}`)}
  <details class="guide-overview"><summary>About this guide and its methods</summary>${guideSummary(g)}${methodsView(g)}</details>` : `${guideSummary(g)}<section class="guide-edit"><h3>Manage this file</h3><p>Prepare a change, then check the preview before saving.</p><div class="action-row"><button data-edit="metadata" ${buttonDisabled()}>Edit source metadata</button><button data-correction="section" ${buttonDisabled()}>Classify guide sections</button><button data-correction="declare" ${buttonDisabled()}>Include a method heading</button><button data-correction="method" ${buttonDisabled()}>Include or exclude methods</button><button data-edit="rename" ${buttonDisabled()}>Rename file</button><button data-edit="move" ${buttonDisabled()}>Move file</button><a href="${esc(vscode(g))}">Open in VS Code ↗</a>${source?.hasCatalogueOverride ? `<button data-edit="reset-override" ${buttonDisabled()}>Remove catalogue corrections</button>` : ''}</div><div id="editor">${editorHTML}</div></section>${methodsView(g)}`}
  <details class="all-checks"><summary>All checks for this guide <span class="count">${g.issues.length}</span></summary>${g.issues.map(issue => `<button data-issue="${esc(issue.id)}"><span>${badge(issue.decision ? DECISION_LABELS[issue.decision] : LEVEL_LABELS[issue.reviewLevel!], issue.decision ?? issue.reviewLevel)} ${esc(issueLabel(issue.type))}</span><span>${esc(issue.explanation)}</span></button>`).join('') || '<p>No issues found.</p>'}</details>
  ${technicalView(g, catalogue, source?.path === g.path ? source.yaml || 'No saved details' : undefined)}</div>`;
  detailRowId = row.id;
  for (const details of panel.querySelectorAll<HTMLDetailsElement>('details')) if (openDetails.has(details.querySelector('summary')?.textContent)) details.open = true;
  if (online && source?.path !== g.path && sourceLoading !== g.path && !sourceError) void loadSource(g.path);
}
function excerpt(issue: Issue, guide: Guide) {
  if (!source || source.path !== guide.path) return '<p>Source is not available.</p>';
  const lines = source.text.split(/\r?\n/);
  return issueSources(guide, issue).map(location => `<div class="source-snippet"><h4>${esc(sourceLabel(location.kind))} · line ${location.line}</h4><pre>${lines.slice(Math.max(0, location.line - 3), location.line + 3).map((line, index) => `${Math.max(1, location.line - 2) + index}  ${line}`).map(esc).join('\n')}</pre></div>`).join('');
}
async function loadSource(path: string) {
  const sequence = ++sourceSequence; sourceLoading = path;
  try {
    const result = await api<SourceFile>(`source?path=${encodeURIComponent(path)}`);
    if (sequence !== sourceSequence || selected?.guide.path !== path) return;
    source = result; sourceError = '';
    if (editor) { renderDetail(); focusEditor(); }
    else {
      if (mode === 'guides' && source.hasCatalogueOverride) { renderDetail(); return; }
      const raw = document.querySelector('#raw-yaml'); if (raw) raw.textContent = source.yaml || 'No saved details';
      const node = document.querySelector('#source-excerpt'); if (node && selected.issue) node.innerHTML = excerpt(selected.issue, selected.guide);
    }
  } catch (error) {
    if (sequence !== sourceSequence || selected?.guide.path !== path) return;
    sourceError = (error as Error).message;
    if (editor) renderDetail();
    else { const node = document.querySelector('#source-excerpt'); if (node) node.innerHTML = `<p class="error-text">${esc(sourceError)}</p>`; }
  } finally { if (sequence === sourceSequence) sourceLoading = ''; }
}
function focusEditor() { document.querySelector<HTMLElement>('#edit-form input:not(:disabled), #edit-form select, #edit-form textarea')?.focus({ preventScroll: true }); }
function captureFocus() { return (document.activeElement as HTMLElement | null)?.id || ''; }
function restoreFocus(id: string) { if (id) document.getElementById(id)?.focus({ preventScroll: true }); }
function setBusy(value: boolean) {
  busy = value; app.setAttribute('aria-busy', String(value));
  document.querySelectorAll<HTMLButtonElement>('#refresh,#check-guide,[data-edit],[data-decision],#apply,button[type=submit]').forEach(button => { button.disabled = value || !online || ((button.id === 'refresh' || button.id === 'check-guide') && !!editor); });
  updateConfirm();
}
function updateConfirm() {
  const apply = document.querySelector<HTMLButtonElement>('#apply');
  if (apply) apply.disabled = !canConfirm(preview, !!document.querySelector<HTMLInputElement>('#confirm-write')?.checked, !!document.querySelector<HTMLInputElement>('#ack-references')?.checked, busy);
}
function showError(error: unknown) {
  const message = (error as Error).message;
  if (mode === 'catalogue') { errorMessage = message; const node = document.querySelector('#browse-feedback'); if (node) node.innerHTML = `<div class="notice error" role="alert">${esc(message)}</div>`; return; }
  if (editor) { formError = message; const node = document.querySelector<HTMLElement>('.form-error'); if (node) { node.hidden = false; node.textContent = message; } else renderDetail(); }
  else { errorMessage = message; const node = document.querySelector('#detail-feedback'); if (node) node.innerHTML = `<div class="notice error" role="alert"><strong>Could not finish this action</strong><p>${esc(message)}</p></div>`; }
}
function acceptCatalogue(next: Catalogue, previous = selected, newPath?: string) {
  catalogue = next;
  if (previous) { outcome = followUp(next, previous, newPath); selected = outcome.row; if (outcome.state === 'resolved') selected = { ...selected, resolvedAt: next.resolutions?.find(r => r.issue.id === selected!.id && !r.reopenedAt)?.resolvedAt ?? new Date().toISOString() }; }
  source = null; sourceError = ''; sourceLoading = ''; sourceSequence++;
}
async function refreshCatalogue() {
  const previous = selected;
  const result = await api<{ catalogue: Catalogue }>('refresh', {});
  acceptCatalogue(result.catalogue, previous); notice = 'Queue updated. Your selection has been kept.'; render();
}
async function openEditor(kind: EditAction, methodId?: string, mode?: CorrectionMode, catalogueFields = false, sectionLine?: number) {
  editCatalogueFields = catalogueFields; editor = kind; preview = null; formError = ''; drafts = {};
  const action = selected?.issue ? nextActions(selected.issue, selected.guide).find(a => a.action === kind) : undefined;
  const metadata = selected?.guide.metadata as Record<string, unknown> | null;
  editorFields = catalogueFields ? ['title', 'category', metadata?.boss !== undefined ? 'boss' : metadata?.creature !== undefined ? 'creature' : 'subject', 'styles'] : action?.fields; correction = mode ?? (methodId ? 'details' : action?.correction);
  correctionIssue = methodId || mode ? { type: 'method-details', severity: 'info', path: selected!.guide.path, message: '', methodId, line: sectionLine } : undefined;
  if (methodId) { const method = selected!.guide.methods.find(m => m.id === methodId); drafts['fix-styles'] = ''; drafts['fix-label'] = method?.label ?? ''; drafts['fix-type'] = method?.type ?? 'Method'; drafts['fix-attributes'] = method?.attributes.map(a => a.value).join(', ') ?? ''; }
  yamlMode = (selected?.issue?.type.includes('FRONTMATTER')) ? 'advanced' : 'simple';
  if (kind === 'move' && !folders.length) folders = (await api<{ folders: string[] }>('folders')).folders;
  renderDetail(); setBusy(false); focusEditor(); document.querySelector('#editor')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function revealSelection() {
  if (!selected) return;
  query = ''; severity = 'all'; status = 'all'; typeFilter = ''; excluded = !!selected.guide.excludedReason;
  const index = rows().findIndex(row => row.id === selected!.id); page = Math.max(0, Math.floor(index / PAGE_SIZE)); render();
}
app.addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (mode === 'catalogue' && input.dataset.browseFilter === 'query') { browseFilters.query = input.value; browsePage = 0; renderCatalogueResults(); return; }
  if (input.id === 'search') { query = input.value; page = 0; renderList(); return; }
  if (mode === 'catalogue' && input.dataset.browseFilter) { browseFilters = { ...browseFilters, [input.dataset.browseFilter]: input.value }; browsePage = 0; renderCatalogueResults(); return; }
  if (input.closest('#edit-form')) drafts[input.dataset.field ? `field-${input.dataset.field}` : input.id] = input.type === 'checkbox' ? (input.checked ? 'yes' : 'no') : input.value;
});
app.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (mode === 'catalogue' && input.dataset.browseFilter) { browseFilters = { ...browseFilters, [input.dataset.browseFilter]: input.value }; browsePage = 0; renderCatalogueResults(); return; }
  if (input.id === 'fix-heading' && correction === 'section') {
    drafts['fix-heading'] = input.value;
    const types = input.value === '__file' ? source?.fixData?.fileTypes ?? [] : source?.fixData?.sectionTypes?.[Number(input.value)] ?? [];
    for (const type of GUIDE_TYPES) drafts[`fix-guide-type-${type}`] = types.includes(type) ? 'yes' : 'no';
    renderDetail(); restoreFocus('fix-heading'); return;
  }
  if (input.id === 'folder') drafts.folder = input.value;
  else if (input.id === 'severity') severity = input.value;
  else if (input.id === 'status') status = input.value;
  else if (input.id === 'issue-type') typeFilter = input.value;
  else if (input.id === 'excluded') excluded = input.checked;
  if (['severity', 'status', 'issue-type', 'excluded'].includes(input.id)) { page = 0; renderList(); }
  updateConfirm();
});
app.addEventListener('submit', event => {
  if ((event.target as HTMLElement).id !== 'edit-form') return;
  event.preventDefault(); void (async () => {
    if (busy || !online || !source || !selected || !editor) return;
    const focus = captureFocus(); setBusy(true); formError = '';
    try {
      const body: Record<string, unknown> = { operation: ['migrate', 'reset-override'].includes(editor) ? 'metadata' : editor, target: saveTarget(), path: selected.guide.path, expectedHash: source.hash, expectedCatalogueHash: source.catalogueHash };
      if (editor === 'migrate') body.migrateCatalogue = true;
      else if (editor === 'reset-override') body.clearCatalogue = true;
      else if (editor === 'rename') body.filename = (document.querySelector('#filename') as HTMLInputElement).value;
      else if (editor === 'move') body.folder = (document.querySelector('#folder') as HTMLSelectElement).value;
      else if (correction && source.fixData && (correctionIssue ?? selected.issue)) {
        const values: Record<string, string> = {};
        for (const input of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#edit-form input, #edit-form select')) values[input.id] = input instanceof HTMLInputElement && input.type === 'checkbox' ? (input.checked ? 'yes' : 'no') : input.value;
        const patch = correctionPatch(correction, source.fixData, (correctionIssue ?? selected.issue)!, values);
        if ('guideStyles' in patch) body.patch = { styles: patch.guideStyles }; else body.cataloguePatch = patch;
      }
      else if (yamlMode === 'advanced') body.yaml = (document.querySelector('#yaml') as HTMLTextAreaElement).value;
      else {
        const patch: Record<string, unknown> = {};
        for (const input of document.querySelectorAll<HTMLInputElement>('[data-field]')) {
          if (input.disabled) continue;
          const key = input.dataset.field!, old = (saveTarget() === 'catalogue' ? source.effectiveMetadata as Record<string, unknown> : source.metadata)?.[key];
          const initial = Array.isArray(old) ? old.join(', ') : typeof old === 'string' ? old : '';
          if (input.value === initial) continue;
          patch[key] = !input.value.trim() ? null : key === 'styles' ? input.value.split(',').map(s => s.trim()).filter(Boolean) : input.value;
        }
        if (!Object.keys(patch).length) throw new Error('No fields have changed yet.');
        body.patch = patch;
      }
      preview = await api<EditPreview>('preview', body); renderDetail(); document.querySelector<HTMLElement>('#confirm-write')?.focus({ preventScroll: true }); document.querySelector('#editor')?.scrollIntoView({ block: 'nearest' });
    } catch (error) { showError(error); restoreFocus(focus); }
    finally { setBusy(false); }
  })();
});
app.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button');
  if (!button || button.disabled || busy) return;
  void (async () => {
    try {
      if (button.dataset.catalogueGuide) { browseSelectedId = button.dataset.catalogueGuide; renderCatalogueResults(); document.querySelector<HTMLElement>(`[data-catalogue-guide="${CSS.escape(browseSelectedId)}"]`)?.focus({ preventScroll: true }); }
      else if (button.dataset.browsePage) { browsePage += Number(button.dataset.browsePage); renderCatalogueResults(); document.querySelector<HTMLElement>('[data-catalogue-guide][tabindex="0"]')?.focus(); }
      else if (button.id === 'browse-reset') { browseFilters = emptyBrowseFilters(); browsePage = 0; renderCatalogue(); document.querySelector<HTMLElement>('#search')?.focus(); }
      else if (button.dataset.manageGuide || button.dataset.reviewGuide || button.dataset.editCatalogueGuide || button.dataset.classifyGuide) {
        const g = catalogue.guides.find(g => g.id === (button.dataset.manageGuide ?? button.dataset.reviewGuide ?? button.dataset.editCatalogueGuide ?? button.dataset.classifyGuide)); if (!g) return;
        resetWork(); query = ''; excluded = false; page = 0;
        if (button.dataset.reviewGuide) { const issue = g.issues.find(i => !i.decision && i.reviewLevel !== 'info') ?? g.issues[0]; if (!issue) { mode = 'guides'; selected = { id: g.id, guide: g }; notice = 'This guide has no issues to review.'; } else { mode = 'queue'; selected = { id: issue.id!, guide: g, issue }; status = 'all'; severity = 'all'; typeFilter = ''; } }
        else { mode = 'guides'; selected = { id: g.id, guide: g }; }
        revealSelection(); if (button.dataset.editCatalogueGuide && online) await openEditor('metadata', undefined, undefined, true);
        if (button.dataset.classifyGuide && online) await openEditor('metadata', undefined, 'section', false, button.dataset.sectionLine ? Number(button.dataset.sectionLine) : undefined);
        if (button.dataset.browseMethod && online) await openEditor('metadata', button.dataset.browseMethod);
        if (!button.dataset.browseMethod && !button.dataset.editCatalogueGuide && !button.dataset.classifyGuide) document.querySelector<HTMLElement>('#detail-title')?.focus();
      }
      else if (button.dataset.row) { const row = rows().find(row => row.id === button.dataset.row); if (row) choose(row); }
      else if (button.dataset.mode) { mode = button.dataset.mode as typeof mode; selected = undefined; resetWork(); excluded = false; page = 0; render(); }
      else if (button.dataset.page) { page += Number(button.dataset.page); renderList(); document.querySelector<HTMLElement>('.queue-row')?.focus(); }
      else if (button.id === 'reset') { query = ''; severity = 'open'; status = 'active'; typeFilter = ''; excluded = false; page = 0; render(); }
      else if (button.id === 'show-selected') revealSelection();
      else if (button.id === 'next-item') { const list = rows(); const index = list.findIndex(row => row.id === selected?.id); const next = list[index + 1] ?? list[0]; if (next) { page = Math.floor(list.indexOf(next) / PAGE_SIZE); choose(next, true); } }
      else if (button.id === 'view-guide') { if (!selected) return; const g = selected.guide; mode = 'guides'; selected = { id: g.id, guide: g }; resetWork(); revealSelection(); }
      else if (button.dataset.issue) { const row = catalogueRows(catalogue, 'queue').find(r => r.id === button.dataset.issue); if (row) { mode = 'queue'; resetWork(); selected = row; revealSelection(); } }
      else if (button.id === 'inspect') {
        inspected = true; const details = document.querySelector<HTMLDetailsElement>('#source-details'); if (details) { details.open = true; details.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); details.querySelector('summary')?.focus(); }
        document.querySelector('#inspect')?.classList.remove('primary'); document.querySelector('#check-guide')?.classList.add('primary');
      } else if (button.dataset.correction) await openEditor('metadata', undefined, button.dataset.correction as CorrectionMode);
      else if (button.dataset.correctMethod) await openEditor('metadata', button.dataset.correctMethod);
      else if (button.dataset.edit) await openEditor(button.dataset.edit as EditAction);
      else if (button.dataset.yamlMode) { yamlMode = button.dataset.yamlMode as typeof yamlMode; renderDetail(); focusEditor(); }
      else if (button.id === 'back-edit') { preview = null; formError = ''; renderDetail(); focusEditor(); }
      else if (button.id === 'cancel-edit') { editor = null; preview = null; formError = ''; renderDetail(); setBusy(false); document.querySelector<HTMLElement>('#step-title-2')?.scrollIntoView({ block: 'nearest' }); }
      else if (button.id === 'refresh' || button.id === 'check-guide') { setBusy(true); await refreshCatalogue(); restoreFocus(button.id); }
      else if (button.dataset.decision) {
        if (!selected?.issue) return;
        const previous = selected; setBusy(true);
        const result = await api<{ catalogue: Catalogue }>('review', { id: previous.issue!.id, sourceHash: previous.guide.sourceHash, decision: button.dataset.decision });
        catalogue = result.catalogue; selected = catalogueRows(catalogue, 'queue').find(r => r.id === previous.id) ?? previous;
        notice = button.dataset.decision === 'reopen' ? 'Item reopened.' : `Item ${button.dataset.decision === 'reviewed' ? 'checked' : 'ignored'}. The guide file was not changed.`;
        outcome = null; render(); document.querySelector<HTMLElement>('#detail-title')?.focus({ preventScroll: true });
      } else if (button.id === 'apply') {
        if (!selected || !canConfirm(preview, !!document.querySelector<HTMLInputElement>('#confirm-write')?.checked, !!document.querySelector<HTMLInputElement>('#ack-references')?.checked, busy)) return;
        const previous = selected; setBusy(true);
        const result = await api<{ applied: boolean; path: string; catalogue: Catalogue | null; reanalysisError: string | null }>('apply', { id: preview!.id, confirmed: true, acknowledgeReferences: !!document.querySelector<HTMLInputElement>('#ack-references')?.checked });
        const savedTarget = preview!.target; editor = null; preview = null; formError = ''; drafts = {}; saveNote = savedTarget === 'catalogue' ? `Saved catalogue correction for ${result.path} in overrides.json. The source guide was not changed.` : `Saved source change to ${result.path}.`;
        if (result.catalogue) acceptCatalogue(result.catalogue, previous, result.path);
        if (result.reanalysisError) errorMessage = result.reanalysisError;
        render(); document.querySelector<HTMLElement>('#step-3')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); restoreFocus('check-guide');
      }
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  })();
});
document.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (target.matches('input,textarea,select') || target.isContentEditable || busy) return;
  if (event.key === '/') { event.preventDefault(); document.querySelector<HTMLInputElement>('#search')?.focus(); return; }
  if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); document.querySelector<HTMLElement>('#detail-title')?.focus(); return; }
  if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); document.querySelector<HTMLElement>('.queue-row[tabindex="0"]')?.focus(); return; }
  const browseButton = target.closest<HTMLButtonElement>('[data-catalogue-guide]');
  if (mode === 'catalogue' && browseButton && ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'Enter') { browseSelectedId = browseButton.dataset.catalogueGuide!; renderCatalogueResults(); document.querySelector<HTMLElement>('#detail-title')?.focus(); return; }
    const matches = filterCatalogue(catalogueEntries(publicCatalogue(catalogue)), browseFilters), index = matches.findIndex(g => g.id === browseButton.dataset.catalogueGuide);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? matches.length - 1 : Math.max(0, Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    if (matches[nextIndex]) { browseSelectedId = matches[nextIndex].id; browsePage = Math.floor(nextIndex / PAGE_SIZE); renderCatalogueResults(); const selectedButton = document.querySelector<HTMLElement>('[data-catalogue-guide][aria-current="true"]'); selectedButton?.focus({ preventScroll: true }); selectedButton?.scrollIntoView({ block: 'nearest' }); }
    return;
  }
  const rowButton = target.closest<HTMLButtonElement>('[data-row]'); if (!rowButton) return;
  if (event.key === 'Enter') { event.preventDefault(); const row = rows().find(r => r.id === rowButton.dataset.row); if (row) choose(row, true); return; }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const list = rows(); const index = list.findIndex(row => row.id === rowButton.dataset.row);
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : Math.min(Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)), list.length - 1);
  const row = list[nextIndex]; if (row) { page = Math.floor(nextIndex / PAGE_SIZE); choose(row); document.querySelector<HTMLElement>('.queue-row[tabindex="0"]')?.focus({ preventScroll: true }); document.querySelector<HTMLElement>('.queue-row.selected')?.scrollIntoView({ block: 'nearest' }); }
});
async function start() {
  app.innerHTML = '<div class="loading"><h1>Loading the review queue…</h1></div>';
  try {
    try { const state = await api<{ catalogue: Catalogue; token: string }>('state'); catalogue = state.catalogue; token = state.token; online = true; }
    catch (error) { const response = await fetch('/data/inspector.json'); if (!response.ok) throw error; catalogue = await response.json() as Catalogue; notice = 'Local editing is unavailable. You can still browse the saved catalogue.'; }
    if (catalogue.schemaVersion !== 1 || !Array.isArray(catalogue.guides)) throw new Error('Please regenerate the catalogue with npm run catalogue.');
    for (const g of catalogue.guides) g.issues = g.issues.map(issue => issue.reviewLevel ? issue : classifyIssue(g, issue));
    render();
  } catch (error) { app.innerHTML = `<div class="loading"><h1>Could not load the catalogue</h1><p>Run <code>npm run catalogue</code>, then <code>npm run dev</code>.</p><p>${esc((error as Error).message)}</p></div>`; }
}
void start();
