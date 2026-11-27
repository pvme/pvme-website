import {
  validateGuide,
  issueSummary,
  type GuideIssue,
} from '../lib/guide-validation';
import { textareaSourceOffset } from '../lib/textarea-source';
import { buttonClasses } from '../lib/buttons';
import {
  canvasBlocks,
  canvasLabels,
  type CanvasBlock,
} from '../lib/page-canvas';

interface DiagnosticsEditing {
  host?: () => HTMLElement | undefined;
  openSource?: (start: number, end: number, source: string) => boolean;
  underline?: (issue: GuideIssue, source: string) => Promise<boolean>;
}

/** A single cached snapshot serves the live panel and submission review. */
export class GuideDiagnostics {
  private source?: string;
  private issues: GuideIssue[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private acknowledged?: string;
  private panel: HTMLDetailsElement;
  private summary: HTMLElement;
  private list: HTMLElement;
  private review: HTMLElement;
  private checkbox: HTMLInputElement;
  private sourceView: HTMLDetailsElement;
  private sourceInput: HTMLTextAreaElement;
  private editorLink: HTMLAnchorElement;
  private shortcuts: HTMLElement;
  private counter: HTMLButtonElement;
  private blocks: CanvasBlock[] = [];

  constructor(
    private doc: Document,
    private current: () => string | undefined,
    private navigate: (issue: GuideIssue, source: string) => boolean,
    private clearHighlight: () => void,
    private editorHref: () => string | undefined = () => undefined,
    private editing: DiagnosticsEditing = {},
  ) {
    this.panel = doc.createElement('details');
    this.panel.className = 'guide-diagnostics';
    this.panel.dataset.guideDiagnostics = '';
    this.summary = doc.createElement('summary');
    this.summary.setAttribute('aria-live', 'polite');
    this.summary.textContent = 'Checking guide…';
    this.list = doc.createElement('div');
    this.list.className = 'guide-issue-list';
    this.sourceView = doc.createElement('details');
    const label = doc.createElement('summary');
    label.textContent = 'Current source location';
    const hint = doc.createElement('p');
    hint.textContent =
      'Read-only source. Use section source editing or open Guide Editor for locations without a visual block.';
    this.sourceInput = doc.createElement('textarea');
    this.sourceInput.readOnly = true;
    this.sourceInput.setAttribute(
      'aria-label',
      'Current guide source (read only)',
    );
    this.editorLink = doc.createElement('a');
    this.editorLink.textContent = 'Open in Guide Editor';
    this.editorLink.target = '_blank';
    this.editorLink.rel = 'noopener noreferrer';
    this.sourceView.append(label, hint, this.sourceInput, this.editorLink);
    this.panel.append(this.summary, this.list, this.sourceView);
    this.shortcuts = doc.createElement('div');
    this.shortcuts.className = 'guide-diagnostics-shortcuts';
    this.shortcuts.hidden = true;
    this.counter = doc.createElement('button');
    this.counter.type = 'button';
    this.counter.className = buttonClasses('secondary');
    this.counter.dataset.editorIssues = '';
    this.counter.addEventListener('click', () => {
      this.panel.open = true;
      this.panel.scrollIntoView?.({ block: 'start' });
      this.summary.focus();
    });
    const sourceButton = doc.createElement('button');
    sourceButton.type = 'button';
    sourceButton.className = buttonClasses('secondary');
    sourceButton.textContent = 'Page source';
    sourceButton.dataset.editorPageSource = '';
    sourceButton.setAttribute('aria-label', 'Edit whole page source');
    sourceButton.addEventListener('click', () => {
      const source = this.current();
      if (source !== undefined) this.editSource(0, 0, source);
    });
    this.shortcuts.append(this.counter, sourceButton);
    (
      doc.querySelector('[data-editor-diagnostics]') ||
      doc.querySelector('.inline-editor-status')
    )?.append(this.shortcuts);
    if (!this.editing.host)
      doc.querySelector('.inline-editor-status')?.append(this.panel);

    this.review = doc.createElement('section');
    this.review.dataset.reviewDiagnostics = '';
    this.review.setAttribute('aria-label', 'Guide validation');
    this.checkbox = doc.createElement('input');
    this.checkbox.type = 'checkbox';
    this.checkbox.dataset.acknowledgeIssues = '';
    this.checkbox.addEventListener('change', () => {
      this.acknowledged = this.checkbox.checked ? this.source : undefined;
    });
    const acknowledgement = doc.createElement('label');
    acknowledgement.append(
      this.checkbox,
      ' I have reviewed and acknowledge the guide errors and warnings.',
    );
    const form = doc.querySelector('[data-prepare-form]');
    form?.before(this.review);
    form?.prepend(acknowledgement);
  }

  schedule() {
    const source = this.current();
    if (source !== this.source) {
      this.clearHighlight();
      this.acknowledged = undefined;
      this.checkbox.checked = false;
      this.summary.textContent = 'Checking guide…';
      this.counter.textContent = 'Checking…';
      // Old locations must never remain actionable while waiting for validation.
      this.list.replaceChildren();
      this.sourceView.hidden = true;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    const source = this.current();
    if (source === undefined) {
      this.reset();
      return;
    }
    if (source !== this.source) {
      const entering = this.source === undefined;
      const previouslyClear = this.issues.length === 0;
      this.clearHighlight();
      this.source = source;
      this.issues = validateGuide(source);
      this.blocks = canvasBlocks(source);
      if (entering || previouslyClear) this.panel.open = this.issues.length > 0;
      this.checkbox.checked = false;
      this.acknowledged = undefined;
    }
    const host = this.editing.host?.();
    if (host && host.firstElementChild !== this.panel) host.prepend(this.panel);
    this.shortcuts.hidden = false;
    this.counter.textContent = this.issues.length
      ? `Issues: ${this.issues.length}`
      : 'No issues';
    this.counter.title = issueSummary(this.issues);
    this.counter.dataset.severity = this.issues.some(
      (issue) => issue.severity === 'error',
    )
      ? 'error'
      : this.issues.length
        ? 'warning'
        : 'none';
    this.counter.setAttribute(
      'aria-label',
      `Guide issues: ${issueSummary(this.issues)}`,
    );
    this.summary.textContent = `Guide issues: ${issueSummary(this.issues)}`;
    this.renderList(this.list, true);
    this.sourceView.hidden = !!this.editing.openSource;
    this.sourceInput.value = source;
    const href = this.editorHref();
    this.editorLink.hidden = !href;
    if (href) this.editorLink.href = href;
    this.review.replaceChildren();
    const summary = this.doc.createElement('p');
    summary.textContent = issueSummary(this.issues);
    this.review.append(summary);
    this.renderList(this.review, true);
    this.checkbox.parentElement!.hidden = !this.issues.length;
  }

  private renderList(host: HTMLElement, navigate: boolean) {
    if (host === this.list) host.replaceChildren();
    for (const issue of this.issues) {
      const element = this.doc.createElement(navigate ? 'button' : 'p');
      const location = issue.range.start;
      const block = this.blocks.find(
        (block) =>
          location.offset >= block.start && location.offset < block.end,
      );
      const heading = this.blocks.findLast(
        (block) => block.kind === 'heading' && block.start <= location.offset,
      );
      const headingName = heading?.source
        .replace(/^\s*#+\s*/, '')
        .replace(/[*_~|]/g, '');
      const context = headingName
        ? `“${headingName}” · ${block ? canvasLabels[block.kind] : 'Source'}`
        : block
          ? canvasLabels[block.kind]
          : 'Guide source';
      element.textContent = `${issue.severity === 'error' ? 'Error' : 'Warning'} · ${context} · source line ${location.line}:${location.column} · ${issue.message}`;
      element.dataset.issueCode = issue.code;
      element.dataset.severity = issue.severity;
      if (navigate) {
        (element as HTMLButtonElement).type = 'button';
        element.addEventListener('click', () => {
          if (this.current() !== this.source) {
            this.flush();
            return;
          }
          this.clearHighlight();
          if (this.navigate(issue, this.source!)) {
            this.panel.open = false;
          } else
            this.editSource(
              issue.range.start.offset,
              issue.range.end.offset,
              this.source!,
            );
        });
      }
      host.append(element);
      if (this.editing.openSource) {
        const source = this.doc.createElement('button');
        source.type = 'button';
        source.className = 'guide-issue-source';
        source.textContent = 'Edit source';
        source.setAttribute(
          'aria-label',
          `Edit source at line ${location.line}`,
        );
        source.addEventListener('click', () => {
          if (this.current() !== this.source) {
            this.flush();
            return;
          }
          this.editSource(
            issue.range.start.offset,
            issue.range.end.offset,
            this.source!,
          );
        });
        host.append(source);
      }
      if (issue.code === 'HEADING_UNDERLINE' && this.editing.underline) {
        const fix = this.doc.createElement('button');
        fix.type = 'button';
        fix.textContent = 'Underline heading';
        fix.dataset.issueUnderline = '';
        fix.addEventListener('click', async () => {
          if (this.current() !== this.source) {
            this.flush();
            return;
          }
          const source = this.source!;
          fix.disabled = true;
          const applied = await this.editing.underline!(issue, source);
          if (!applied && this.current() === source)
            this.editSource(
              issue.range.start.offset,
              issue.range.end.offset,
              source,
            );
          this.flush();
        });
        host.append(fix);
      }
    }
  }

  private editSource(start: number, end: number, source: string) {
    if (this.editing.openSource?.(start, end, source)) return;
    this.panel.open = true;
    this.sourceView.hidden = false;
    this.sourceView.open = true;
    this.sourceInput.focus();
    const from = textareaSourceOffset(source, this.sourceInput.value, start);
    const to = textareaSourceOffset(source, this.sourceInput.value, end);
    if (from !== undefined && to !== undefined)
      this.sourceInput.setSelectionRange(from, to);
  }

  canSubmit() {
    this.flush();
    return !this.issues.length || this.acknowledged === this.source;
  }

  reset() {
    clearTimeout(this.timer);
    this.source = undefined;
    this.issues = [];
    this.acknowledged = undefined;
    this.checkbox.checked = false;
    this.checkbox.parentElement!.hidden = true;
    this.summary.textContent = 'Guide checker';
    this.list.replaceChildren();
    this.review.replaceChildren();
    this.sourceInput.value = '';
    this.editorLink.removeAttribute('href');
    this.sourceView.open = false;
    this.sourceView.hidden = true;
    this.panel.open = false;
    this.panel.remove();
    this.shortcuts.hidden = true;
    this.clearHighlight();
  }
}
