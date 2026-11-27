import { EditSession, type PendingChange } from '../lib/edit-session';
import { DraftStorage, type DraftRestore } from '../lib/draft-storage';
import type { GuideSourceProvider } from '../lib/guide-source-provider';
import {
  type SourceEdit,
  sourceDiff,
  sourceDiffChanges,
  displayDiffLine,
  diffContext,
  highlightSourceDiff,
} from '../lib/source-diff';
import { updateDraftPreview } from './inline-preview';
import { RichLineEditor } from './rich-line-editor';
import { PageCanvasEditor } from './page-canvas-editor';
import { EmojiAutocomplete } from './emoji-autocomplete';
import { pageLinkTitle } from '../lib/page-link-title';
import {
  GuideSubmission,
  reviewIdentity,
  submissionFailure,
  type ReplacementConsent,
  type SubmissionReceipt,
} from '../lib/guide-submission';
import { guideEditorHref } from '../lib/guide-editor';
import { GuideDiagnostics } from './guide-diagnostics';

export interface InlineEditorOptions {
  provider: GuideSourceProvider;
  drafts: DraftStorage;
  download?: (name: string, value: string) => void;
  pageCanvas?: boolean;
  refreshEmojis?: boolean;
  beforeEnter?: () => Promise<void>;
  restoreReadingDrafts?: boolean;
  onSourceFailure?: (path: string, error: unknown) => void;
  submission?: GuideSubmission;
}

export function initializeInlineEditor(
  doc: Document,
  options: InlineEditorOptions,
) {
  const toolbar = doc.querySelector<HTMLElement>('[data-inline-editor]');
  if (!toolbar || toolbar.dataset.ready) return;
  toolbar.dataset.ready = 'true';
  const emojis = new EmojiAutocomplete(doc);
  if (options.refreshEmojis) void emojis.refresh();
  const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const element = doc.querySelector<T>(selector);
    if (!element) throw new Error(`Missing editor element ${selector}`);
    return element;
  };
  const valueDialog = get<HTMLDialogElement>('[data-inline-value-editor]');
  const reviewDialog = get<HTMLDialogElement>('[data-review-dialog]');
  const confirmDialog = get<HTMLDialogElement>('[data-editor-confirm]');
  const wideToolbar = doc.defaultView?.matchMedia?.('(min-width: 1201px)');
  const mobileToolbar = doc.defaultView?.matchMedia?.('(max-width: 600px)');
  const arrangeToolbar = () => {
    const options = get<HTMLDetailsElement>('[data-editor-options]');
    const menu = get('.inline-editor-menu');
    const secondary = get('[data-editor-secondary]');
    const recovery = get('[data-draft-recovery]');
    const actions = get('.inline-editor-actions');
    const target = mobileToolbar?.matches
      ? actions
      : wideToolbar?.matches
        ? secondary
        : menu;
    get('[data-editor-discard] [data-action-label]').textContent =
      mobileToolbar?.matches ? 'Discard' : 'Discard draft';
    get('[data-editor-review] span').textContent = mobileToolbar?.matches
      ? 'Submit'
      : 'Submit changes';
    get('[data-editor-exit]').textContent = mobileToolbar?.matches
      ? 'Done'
      : 'Exit editor';
    const action = get('[data-editor-discard]');
    if (action.parentElement !== target) {
      const focused = doc.activeElement === action;
      if (target === menu) menu.insertBefore(action, recovery);
      else if (target === actions)
        actions.insertBefore(action, get('[data-editor-exit]'));
      else secondary.append(action);
      if (recovery.hidden) options.open = false;
      if (focused)
        (target === menu
          ? options.querySelector<HTMLElement>('summary')
          : action
        )?.focus({ preventScroll: true });
    }
    options.hidden =
      (!!wideToolbar?.matches || !!mobileToolbar?.matches) && recovery.hidden;
  };
  wideToolbar?.addEventListener?.('change', arrangeToolbar);
  mobileToolbar?.addEventListener?.('change', arrangeToolbar);
  arrangeToolbar();
  let session: EditSession | undefined;
  let activeArticle: HTMLElement | undefined;
  let startTrigger: HTMLElement | undefined;
  let title = '';
  let selected: string[] = [];
  let blocked: Extract<DraftRestore, { status: 'blocked' }> | undefined;
  let loading = false;
  let prepareGeneration = 0;
  let lifecycleGeneration = 0;
  let submissionPending = false;
  let submitted: SubmissionReceipt | undefined;
  let replacementConsent: ReplacementConsent | undefined;
  let persistenceError = '';
  let confirmAction: (() => void) | undefined;
  let resumeLineAfterLink = false;
  let canvas: PageCanvasEditor | undefined;
  const diagnostics = new GuideDiagnostics(
    doc,
    () =>
      session ? (canvas?.diagnosticSource() ?? session.content()) : undefined,
    (issue, source) => {
      focusReturn.delete(reviewDialog);
      if (reviewDialog.open) reviewDialog.close();
      return (
        canvas?.revealIssue(
          issue.range.start.offset,
          issue.range.end.offset,
          source,
        ) ?? false
      );
    },
    () =>
      doc
        .querySelectorAll('[data-guide-issue]')
        .forEach((element) => element.removeAttribute('data-guide-issue')),
    () => (session ? guideEditorHref({ path: session.path }) : undefined),
    {
      host: () => canvas?.root || activeArticle,
      openSource: (start, end, source) => {
        if (!session || blocked) return false;
        focusReturn.delete(reviewDialog);
        if (reviewDialog.open) reviewDialog.close();
        openCanvas();
        return canvas?.openPageSource(start, end, source) ?? false;
      },
      underline: async (issue, source) => {
        if (!session || blocked) return false;
        focusReturn.delete(reviewDialog);
        if (reviewDialog.open) reviewDialog.close();
        openCanvas();
        return (
          (await canvas?.underlineHeading(
            issue.range.start.offset,
            issue.range.end.offset,
            source,
          )) ?? false
        );
      },
    },
  );
  doc.addEventListener('input', (event) => {
    if (
      (event.target as Element).closest(
        '[data-page-canvas],article[data-inline-active]',
      )
    )
      diagnostics.schedule();
  });
  const draftViews = new Map<HTMLElement, () => void>();
  const loadingViews = new Set<HTMLElement>();
  const restoreReadingDrafts = async () => {
    if (
      options.restoreReadingDrafts === false ||
      !options.pageCanvas ||
      session ||
      loading
    )
      return;
    for (const article of doc.querySelectorAll<HTMLElement>(
      'article[data-guide-source]',
    )) {
      const path = article.dataset.guideSource;
      if (
        !path ||
        article.closest('[hidden]') ||
        draftViews.has(article) ||
        loadingViews.has(article) ||
        !options.drafts.hasDraft(path)
      )
        continue;
      loadingViews.add(article);
      try {
        const map = JSON.parse(
          article.querySelector('script[data-guide-source-map]')?.textContent ||
            'null',
        );
        const loaded = await options.provider.load(path);
        const draft = await EditSession.create(map, loaded);
        const result = options.drafts.restore(draft);
        if (
          result.status !== 'restored' ||
          !draft.count ||
          session ||
          loading ||
          draftViews.has(article) ||
          article.closest('[hidden]')
        )
          continue;
        const reader = new PageCanvasEditor(doc, article, draft, () => {});
        const clear = reader.close(true);
        if (clear) draftViews.set(article, clear);
      } catch {
        /* Stale/malformed drafts stay available through explicit recovery. */
      } finally {
        loadingViews.delete(article);
      }
    }
  };
  queueMicrotask(() => void restoreReadingDrafts());
  doc.addEventListener('pvme:guide-change', () => void restoreReadingDrafts());
  const lineEditor = new RichLineEditor(
    doc,
    () => session,
    () => update(),
    (target) => {
      resumeLineAfterLink = true;
      editTarget(target);
    },
  );
  const focusReturn = new WeakMap<HTMLDialogElement, HTMLElement>();
  const message = (selector: string, text: string) => {
    get(selector).textContent = text;
  };
  const failure = (error: unknown) =>
    error instanceof Error ? error.message : 'Editing unavailable';
  const download =
    options.download ||
    ((name: string, content: string) => {
      const blob = new Blob([content], { type: 'application/json' });
      const address = URL.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = address;
      link.download = name;
      doc.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(address), 1000);
    });
  const open = (dialog: HTMLDialogElement, trigger?: HTMLElement) => {
    const active = trigger || (doc.activeElement as HTMLElement);
    if (active) focusReturn.set(dialog, active);
    dialog.showModal();
  };
  for (const dialog of [valueDialog, reviewDialog, confirmDialog]) {
    dialog.addEventListener('close', () => {
      const trigger = focusReturn.get(dialog);
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
    // Native <dialog> supplies focus trapping and Escape-to-cancel.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  valueDialog.addEventListener('close', () => {
    if (resumeLineAfterLink) {
      resumeLineAfterLink = false;
      lineEditor.resumeAfterLink();
    }
  });
  const invalidatePrepared = () => {
    prepareGeneration++;
    if (!submitted) message('[data-prepare-status]', '');
  };
  const update = (persist = true) => {
    if (!session) return;
    replacementConsent = undefined;
    get<HTMLInputElement>('[data-replace-review]').checked = false;
    invalidatePrepared();
    if (session.hasDocumentDraft && !blocked && !canvas) openCanvas();
    if (canvas) canvas.sync();
    else updateDraftPreview(doc, session, !blocked);
    if (persist && !blocked)
      persistenceError = options.drafts.save(session) || '';
    message('[data-editor-guide]', pageLinkTitle(title));
    get('[data-editor-guide]').title = pageLinkTitle(title);
    message(
      '[data-editor-status]',
      blocked
        ? 'Draft recovery required before editing.'
        : canvas
          ? session.count
            ? 'Draft saved locally'
            : 'No changes yet'
          : `${session.count} pending change${session.count === 1 ? '' : 's'}. Click text to edit in place. Enter starts a new line; Bullets toggles list formatting. Tab / Shift+Tab changes bullet level.`,
    );
    message('[data-editor-error]', persistenceError);
    get<HTMLButtonElement>('[data-editor-review]').disabled =
      !session.count || !!blocked;
    get<HTMLButtonElement>('[data-editor-discard]').disabled =
      !session.count || !!blocked;
    arrangeToolbar();
    diagnostics.schedule();
  };
  const openCanvas = () => {
    if (!session || !activeArticle || blocked || canvas || !lineEditor.finish())
      return;
    updateDraftPreview(doc, session, false);
    canvas = new PageCanvasEditor(
      doc,
      activeArticle,
      session,
      () => update(),
      () => queueMicrotask(() => diagnostics.schedule()),
    );
  };
  const showRecovery = () => {
    get('[data-draft-recovery]').hidden = !blocked;
    message('[data-draft-message]', blocked?.message || '');
    get<HTMLButtonElement>('[data-draft-export]').disabled = !blocked?.raw;
    if (blocked) get<HTMLDetailsElement>('[data-editor-options]').open = true;
    arrangeToolbar();
  };
  const start = async (button: HTMLElement) => {
    if (loading) return;
    if (session) {
      message(
        '[data-editor-error]',
        'Exit the current editing session before opening another guide. Your draft will be retained.',
      );
      return;
    }
    const path = button.dataset.inlineEditPath;
    const candidates = [
      ...doc.querySelectorAll<HTMLElement>('article[data-guide-source]'),
    ].filter((article) => article.dataset.guideSource === path);
    const reader = button.closest('.reader-layout');
    const article =
      candidates.find((article) => reader?.contains(article)) ||
      candidates.find((article) => !article.closest('[hidden]'));
    if (!article) return;
    loading = true;
    toolbar.hidden = false;
    get<HTMLButtonElement>('[data-editor-review]').disabled = true;
    get<HTMLButtonElement>('[data-editor-discard]').disabled = true;
    message(
      '[data-editor-status]',
      'Loading and checking the original source…',
    );
    message('[data-editor-error]', '');
    const lifecycle = lifecycleGeneration;
    try {
      await options.beforeEnter?.();
      if (lifecycle !== lifecycleGeneration) return;
      const metadata = article.querySelector(
        'script[data-guide-source-map]',
      )?.textContent;
      if (!metadata) throw new Error('No source map on this guide');
      const map = JSON.parse(metadata);
      if (
        map.path !== path ||
        map.sourceHash !== article.dataset.guideSourceHash
      )
        throw new Error('Guide metadata does not match this article');
      const loaded = await options.provider.load(path!);
      const created = await EditSession.create(map, loaded);
      if (lifecycle !== lifecycleGeneration) return;
      session = created;
      for (const [view, clear] of draftViews) {
        if (view.dataset.guideSource !== path) continue;
        clear();
        draftViews.delete(view);
      }
      activeArticle = article;
      startTrigger = button;
      title = button.dataset.inlineEditTitle || loaded.name;
      submitted = undefined;
      replacementConsent = undefined;
      get<HTMLInputElement>('[data-replace-review]').checked = false;
      get('[data-replacement-consent]').hidden =
        !options.submission ||
        loaded.source !== 'master' ||
        !loaded.existingReviewBranch;
      get('[data-submit-export]').hidden = !options.submission;
      get('[data-submit-reading]').hidden = true;
      get('[data-submit-result]').hidden = true;
      get('[data-submit-recovery]').hidden = !options.submission;
      get<HTMLAnchorElement>('[data-submit-editor]').href = guideEditorHref({
        path: path!,
      });
      const sourceNotice = doc.querySelector<HTMLElement>(
        '[data-review-source]',
      );
      if (sourceNotice) {
        const reviewUrl = loaded.existingReviewUrl || loaded.prUrl;
        sourceNotice.hidden = !reviewUrl;
        sourceNotice.textContent =
          loaded.source === 'user-pr'
            ? 'Editing your submitted update. '
            : options.submission
              ? 'An existing submitted update is retained. Confirm replacement below to submit this live-guide version. '
              : 'An existing submitted update is retained. This export does not authorise replacing it. ';
        if (reviewUrl && /^https:\/\/github\.com\//.test(reviewUrl)) {
          const link = doc.createElement('a');
          link.href = reviewUrl;
          link.textContent = 'View submitted update';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          sourceNotice.append(link);
        }
      }
      get<HTMLInputElement>('[data-prepare-form] [name="title"]').value =
        `Update ${title}`.slice(0, 120);
      get<HTMLTextAreaElement>('[data-prepare-form] [name="notes"]').value = '';
      const result = options.drafts.restore(session);
      blocked = result.status === 'blocked' ? result : undefined;
      persistenceError = result.status === 'unavailable' ? result.message : '';
      showRecovery();
      if (options.pageCanvas && !blocked) openCanvas();
      update(false);
      diagnostics.flush();
      if (result.status === 'restored')
        message(
          '[data-editor-status]',
          `Restored ${session.count} pending change${session.count === 1 ? '' : 's'}. This is an unpublished draft.`,
        );
      get<HTMLButtonElement>('[data-editor-review]').focus({
        preventScroll: true,
      });
    } catch (error) {
      if (lifecycle !== lifecycleGeneration) return;
      message(
        '[data-editor-status]',
        'Editing unavailable. The guide remains unchanged.',
      );
      message('[data-editor-error]', failure(error));
      options.onSourceFailure?.(path!, error);
    } finally {
      loading = false;
    }
  };
  const editTarget = (target: HTMLElement) => {
    if (!session || blocked || !target.closest('article[data-inline-active]'))
      return;
    selected = [target.dataset.editRef, target.dataset.editUrl].filter(
      (id): id is string => !!id,
    );
    const fields = get('[data-value-fields]');
    fields.replaceChildren();
    for (const id of selected) {
      const entry = session.entry(id);
      const label = doc.createElement('label');
      label.textContent =
        entry.kind === 'link-url'
          ? 'Original source URL'
          : entry.kind === 'link-label'
            ? 'Link label'
            : 'Text';
      const input = doc.createElement('input');
      input.type = 'text';
      input.value = session.value(id);
      input.dataset.entryId = id;
      input.required = false;
      if (entry.kind === 'link-url') {
        input.inputMode = 'url';
        input.autocapitalize = 'off';
        input.spellcheck = false;
      }
      label.append(input);
      fields.append(label);
    }
    message('[data-value-error]', '');
    get<HTMLButtonElement>('[data-value-undo]').disabled = !selected.some(
      (id) => session!.value(id) !== session!.entry(id).value,
    );
    const rect = target.getBoundingClientRect();
    valueDialog.style.left = `${Math.max(16, Math.min(rect.left, (doc.defaultView?.innerWidth || 1000) - 652))}px`;
    valueDialog.style.top = `${Math.max(16, Math.min(rect.bottom + 8, (doc.defaultView?.innerHeight || 800) - 420))}px`;
    open(valueDialog, target);
    fields.querySelector<HTMLInputElement>('input')?.focus();
  };
  let reviewedContent = '';
  let reviewedEdits: SourceEdit[] = [];
  const renderDiff = () => {
    if (!session) return;
    diagnostics.flush();
    const diff = get('[data-source-diff]');
    diff.replaceChildren();
    reviewedContent = session.content();
    get('[data-review-empty]').hidden = !!session.count;
    get<HTMLButtonElement>('[data-prepare-update]').disabled =
      !session.count || submissionPending || !!submitted;
    if (!session.count) return;
    let changeIndex = 0;
    reviewedEdits = [];
    const highlighted = highlightSourceDiff(
      sourceDiff(session.originalContent, reviewedContent),
      reviewedEdits,
    );
    for (const group of diffContext(highlighted)) {
      let parent: HTMLElement = diff;
      if (group.collapsed) {
        const details = doc.createElement('details');
        const summary = doc.createElement('summary');
        summary.textContent = `${group.lines.length} unchanged lines`;
        details.append(summary);
        diff.append(details);
        parent = details;
      }
      if (group.lines[0]?.kind !== 'context') {
        const section = doc.createElement('div');
        section.className = 'diff-change';
        const discard = doc.createElement('button');
        discard.type = 'button';
        discard.dataset.reviewDiscard = String(changeIndex++);
        discard.textContent = '↶';
        discard.title = 'Discard this change';
        discard.setAttribute('aria-label', `Discard change ${changeIndex}`);
        section.append(discard);
        diff.append(section);
        parent = section;
      }
      for (const line of group.lines) {
        const span = doc.createElement('span');
        span.className = `diff-${line.kind}`;
        const displayed = displayDiffLine(line);
        span.append(doc.createTextNode(displayed.slice(0, 2)));
        const bodyLength = line.text.replace(/[\r\n]+$/, '').length;
        let offset = 0;
        let endingChanged = false;
        for (const part of line.parts || [
          { text: line.text, changed: false },
        ]) {
          const text = part.text.slice(0, Math.max(0, bodyLength - offset));
          if (text) {
            if (part.changed) {
              const mark = doc.createElement('mark');
              const discard = doc.createElement('button');
              discard.type = 'button';
              discard.dataset.reviewEdit = String(part.editIndex);
              discard.textContent = text;
              discard.title = 'Discard this edit';
              discard.setAttribute('aria-label', `Discard edit: ${text}`);
              mark.append(discard);
              span.append(mark);
            } else span.append(doc.createTextNode(text));
          }
          if (part.changed && offset + part.text.length > bodyLength)
            endingChanged = true;
          offset += part.text.length;
        }
        const ending = displayed.slice(2 + bodyLength);
        if (endingChanged && ending) {
          const mark = doc.createElement('mark');
          mark.textContent = ending;
          span.append(mark);
        } else span.append(doc.createTextNode(ending));
        parent.append(span);
      }
    }
  };
  const review = () => {
    if (canvas && !canvas.finish()) return;
    if (!lineEditor.finish()) return;
    if (!session || blocked || !session.count) return;
    try {
      invalidatePrepared();
      message('[data-review-guide]', title);
      message('[data-review-error]', '');
      renderDiff();
      if (!reviewDialog.open) open(reviewDialog, get('[data-editor-review]'));
    } catch (error) {
      message('[data-editor-error]', failure(error));
    }
  };
  const confirm = (
    text: string,
    action: () => void,
    trigger: HTMLElement,
    heading = 'Discard draft?',
  ) => {
    message('#inline-confirm-title', heading);
    confirmAction = action;
    message('[data-confirm-message]', text);
    open(confirmDialog, trigger);
    get('[data-confirm-cancel]').focus();
  };
  doc.addEventListener(
    'click',
    (event) => {
      const element = event.target as Element;
      if (element.closest('[data-page-canvas]')) return;
      const startButton = element.closest<HTMLElement>(
        '[data-inline-edit-path]',
      );
      if (startButton) {
        if (!lineEditor.finish()) return;
        event.preventDefault();
        void start(startButton);
        return;
      }
      if (
        element.closest(
          '.line-formatting,.inline-line-input,.line-edit-hint,.line-edit-error',
        )
      ) {
        const link = element.closest<HTMLElement>('a');
        if (link?.closest('[data-inline-active]')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (link.dataset.createdLink) lineEditor.editCreatedLink(link);
          else if (!link.dataset.editRef && !link.dataset.editUrl)
            lineEditor.showMessage('This link is read-only in inline editing.');
          else if (lineEditor.suspendForLink()) {
            resumeLineAfterLink = true;
            editTarget(link);
          }
        }
        return;
      }
      const target = element.closest<HTMLElement>(
        '[data-edit-ref], [data-edit-url]',
      );
      if (target?.closest('article[data-inline-active]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const wrapper = target.closest<HTMLElement>('[data-source-line]');
        if (target.tagName === 'A' || target.dataset.editUrl) {
          if (lineEditor.finish()) editTarget(target);
        } else if (wrapper)
          lineEditor.begin(wrapper, {
            x: (event as MouseEvent).clientX,
            y: (event as MouseEvent).clientY,
          });
        else editTarget(target);
        return;
      }
      const wrapper =
        element.closest<HTMLElement>(
          'article[data-inline-active] [data-source-line]',
        ) ||
        element
          .closest('article[data-inline-active] [data-edit-chunk]')
          ?.querySelector<HTMLElement>('[data-source-line]');
      if (wrapper) {
        event.preventDefault();
        lineEditor.begin(wrapper, {
          x: (event as MouseEvent).clientX,
          y: (event as MouseEvent).clientY,
        });
      } else if (!element.closest('dialog,[data-inline-editor]'))
        lineEditor.finish();
    },
    true,
  );
  doc.addEventListener('keydown', (event) => {
    if ((event.target as Element).closest('[data-page-canvas]')) return;
    if (
      (event.target as Element).closest('.inline-line-input,.line-formatting')
    )
      return;
    if (!['Enter', ' '].includes(event.key)) return;
    const target = (event.target as Element).closest<HTMLElement>(
      '[data-source-line], [data-edit-ref], [data-edit-url]',
    );
    if (target?.closest('article[data-inline-active]')) {
      event.preventDefault();
      const wrapper = target.closest<HTMLElement>('[data-source-line]');
      if (wrapper && target.tagName !== 'A') lineEditor.begin(wrapper);
      else if (lineEditor.finish()) editTarget(target);
    }
  });
  get<HTMLFormElement>('[data-value-form]').addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      if (!session) return;
      try {
        const changes: PendingChange[] = [
          ...get('[data-value-fields]').querySelectorAll<HTMLInputElement>(
            'input',
          ),
        ].map((field) => ({
          entryId: field.dataset.entryId!,
          replacement: field.value,
        }));
        session.setChanges(changes);
        update();
        valueDialog.close();
      } catch (error) {
        message('[data-value-error]', failure(error));
      }
    },
  );
  get('[data-value-cancel]').addEventListener('click', () =>
    valueDialog.close(),
  );
  get('[data-value-undo]').addEventListener('click', () => {
    if (!session) return;
    selected.forEach((id) => session!.undo(id));
    update();
    valueDialog.close();
  });
  get('[data-editor-review]').addEventListener('click', review);
  get('[data-review-close]').addEventListener('click', () =>
    reviewDialog.close(),
  );
  get('[data-source-diff]').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-review-discard], [data-review-edit]',
    );
    if (!button || !session || blocked) return;
    message('[data-review-error]', '');
    if (session.content() !== reviewedContent) {
      renderDiff();
      message(
        '[data-review-error]',
        'The draft changed. Review the latest changes before discarding.',
      );
      return;
    }
    const granular = button.dataset.reviewEdit !== undefined;
    const index = Number(
      granular ? button.dataset.reviewEdit : button.dataset.reviewDiscard,
    );
    const change = granular
      ? reviewedEdits[index]
      : sourceDiffChanges(session.originalContent, reviewedContent)[index];
    if (!change) return;
    const currentSession = session;
    const snapshot = reviewedContent;
    confirm(
      granular
        ? 'Discard this highlighted edit? Your other changes will be kept.'
        : 'Discard all edits in this section? Your other changes will be kept.',
      () => {
        if (
          session !== currentSession ||
          blocked ||
          session.content() !== snapshot
        ) {
          renderDiff();
          message(
            '[data-review-error]',
            'The draft changed. Review the latest changes before discarding.',
          );
          return;
        }
        try {
          currentSession.setDocument(
            snapshot.slice(0, change.start) +
              change.original +
              snapshot.slice(change.end),
          );
          update();
          renderDiff();
          const buttons = get(
            '[data-source-diff]',
          ).querySelectorAll<HTMLButtonElement>(
            granular ? '[data-review-edit]' : '[data-review-discard]',
          );
          (
            buttons[Math.min(index, buttons.length - 1)] ||
            get('[data-review-close]')
          ).focus();
        } catch (error) {
          message('[data-review-error]', failure(error));
        }
      },
      button,
      granular ? 'Discard this edit?' : 'Discard this section?',
    );
  });
  get('[data-editor-discard]').addEventListener('click', () =>
    confirm(
      'Discard all pending changes to this guide? The original guide display will be restored.',
      () => {
        lineEditor.cancel();
        session?.discard();
        update();
      },
      get('[data-editor-discard]'),
    ),
  );
  confirmDialog.addEventListener('close', () => {
    confirmAction = undefined;
  });
  get('[data-confirm-cancel]').addEventListener('click', () =>
    confirmDialog.close(),
  );
  get('[data-confirm-discard]').addEventListener('click', () => {
    const action = confirmAction;
    confirmAction = undefined;
    confirmDialog.close();
    action?.();
  });
  get('[data-draft-export]').addEventListener('click', () => {
    if (blocked?.raw) download('pvme-draft-recovery.json', blocked.raw);
  });
  get('[data-draft-discard]').addEventListener('click', () =>
    confirm(
      'Discard the stored draft? Export it first if you want to recover any of its changes.',
      () => {
        if (!session) return;
        const error = options.drafts.discard(session.path);
        if (error) {
          message('[data-editor-error]', error);
          return;
        }
        blocked = undefined;
        showRecovery();
        update(false);
      },
      get('[data-draft-discard]'),
    ),
  );
  get('[data-editor-exit]').addEventListener('click', () => {
    if (loading) return;
    if (canvas && !canvas.finish()) return;
    if (!lineEditor.finish()) return;
    if (session) {
      if (!canvas) updateDraftPreview(doc, session, false);
      if (!blocked) persistenceError = options.drafts.save(session) || '';
      // Keep an unsaved in-memory session reachable rather than losing it on exit.
      if (persistenceError && session.count) {
        if (!canvas) updateDraftPreview(doc, session, true);
        message(
          '[data-editor-error]',
          persistenceError +
            ' Review and export the update, or discard changes before exiting.',
        );
        return;
      }
    }
    const clearDraftView = canvas?.close(
      !!session?.count && !blocked && !submitted,
    );
    if (clearDraftView && activeArticle)
      draftViews.set(activeArticle, clearDraftView);
    canvas = undefined;
    if (session) updateDraftPreview(doc, session, false);
    session = undefined;
    diagnostics.reset();
    blocked = undefined;
    activeArticle = undefined;
    toolbar.hidden = true;
    startTrigger?.focus({ preventScroll: true });
    invalidatePrepared();
    showRecovery();
  });
  get<HTMLFormElement>('[data-prepare-form]').addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();
      if (!session || blocked || !session.count || submissionPending) return;
      if (!diagnostics.canSubmit()) {
        message(
          '[data-prepare-status]',
          'Review and acknowledge the guide errors and warnings before submitting.',
        );
        return;
      }
      invalidatePrepared();
      const currentSession = session,
        generation = prepareGeneration;
      const title = get<HTMLInputElement>(
        '[data-prepare-form] [name="title"]',
      ).value;
      const notes = get<HTMLTextAreaElement>(
        '[data-prepare-form] [name="notes"]',
      ).value;
      message('[data-prepare-status]', 'Rechecking the source snapshot…');
      if (options.submission) {
        submissionPending = true;
        message(
          '[data-prepare-status]',
          'Checking source and submitting your update…',
        );
        get('[data-prepare-update]').textContent = 'Submitting…';
        const lifecycle = lifecycleGeneration;
        get<HTMLButtonElement>('[data-prepare-update]').disabled = true;
        try {
          const receipt = await options.submission.submit(
            currentSession,
            { title, notes },
            options.drafts,
            replacementConsent,
          );
          if (session !== currentSession || lifecycle !== lifecycleGeneration)
            return;
          if ('dryRun' in receipt.result) {
            message(
              '[data-prepare-status]',
              'Dry-run validation passed. No PR was created or updated. Your draft is retained.',
            );
          } else {
            submitted = receipt;
            get('[data-submit-result]').hidden = false;
            get<HTMLAnchorElement>('[data-submit-pr]').href =
              receipt.result.prUrl;
            get('[data-submit-reading]').hidden = false;
            message(
              '[data-prepare-status]',
              `${receipt.result.reusedReview ? 'Updated your existing pull request.' : 'Created your pull request.'} The published guide has not changed. Return to guide to finish; newer edits will be retained.`,
            );
          }
        } catch (error) {
          replacementConsent = undefined;
          get<HTMLInputElement>('[data-replace-review]').checked = false;
          if (session === currentSession && lifecycle === lifecycleGeneration)
            message('[data-prepare-status]', submissionFailure(error));
        } finally {
          submissionPending = false;
          get('[data-prepare-update]').textContent = 'Submit for review';
          get<HTMLButtonElement>('[data-prepare-update]').disabled =
            !!submitted;
        }
        return;
      }
      try {
        const current = await options.provider.load(
          currentSession.path,
          currentSession.loaded.source,
        );
        const payload = await currentSession.prepareUpdate(
          { title, notes },
          current,
        );
        if (session !== currentSession || generation !== prepareGeneration)
          return;
        download('pvme-guide-update.json', JSON.stringify(payload, null, 2));
        message(
          '[data-prepare-status]',
          'Changes downloaded. Your draft is saved locally and has not been published.',
        );
      } catch (error) {
        if (generation === prepareGeneration)
          message('[data-prepare-status]', failure(error));
      }
    },
  );
  get('[data-prepare-form]').addEventListener('input', invalidatePrepared);
  get('[data-replace-review]').addEventListener('change', () => {
    replacementConsent =
      session && get<HTMLInputElement>('[data-replace-review]').checked
        ? { identity: options.drafts.identity, review: reviewIdentity(session) }
        : undefined;
  });
  get('[data-submit-export]').addEventListener('click', async () => {
    if (!session) return;
    try {
      const payload = await session.prepareUpdate(
        {
          title:
            get<HTMLInputElement>('[data-prepare-form] [name="title"]').value ||
            `Update ${session.path}`,
          notes:
            get<HTMLTextAreaElement>('[data-prepare-form] [name="notes"]')
              .value || 'Draft recovery export',
        },
        session.loaded,
      );
      download(
        'pvme-guide-update.json',
        JSON.stringify(
          {
            ...payload,
            recoveryOnly: true,
            ...(session.contributor
              ? { expectedContributor: session.contributor }
              : {}),
            ...(session.loaded.reviewState
              ? { reviewState: session.loaded.reviewState }
              : {}),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      message('[data-prepare-status]', failure(error));
    }
  });
  get('[data-submit-reading]').addEventListener('click', () => {
    if (!submitted || !options.submission || submissionPending) return;
    if (canvas && !canvas.finish()) return;
    if (!lineEditor.finish()) return;
    options.submission.complete(submitted);
    canvas?.close(false);
    canvas = undefined;
    if (session) updateDraftPreview(doc, session, false);
    session = undefined;
    diagnostics.reset();
    activeArticle = undefined;
    blocked = undefined;
    submitted = undefined;
    // Native close events are queued; do not later restore focus to the hidden
    // review toolbar after completion has returned to published reading.
    if (startTrigger) focusReturn.set(reviewDialog, startTrigger);
    reviewDialog.close();
    toolbar.hidden = true;
    invalidatePrepared();
    startTrigger?.focus({ preventScroll: true });
  });
  doc.defaultView?.addEventListener('beforeunload', (event) => {
    if ((session?.count && persistenceError) || canvas?.hasUnappliedChanges) {
      event.preventDefault();
    }
  });
  return {
    checkpoint() {
      if (canvas && !canvas.finish()) return false;
      if (!lineEditor.finish()) return false;
      if (session && !blocked) {
        persistenceError = options.drafts.save(session) || '';
        if (persistenceError) {
          message('[data-editor-error]', persistenceError);
          return false;
        }
      }
      return true;
    },
    suspend() {
      lifecycleGeneration++;
      invalidatePrepared();
      canvas?.finish();
      lineEditor.finish();
      if (session && !blocked) options.drafts.save(session);
      canvas?.close(false);
      canvas = undefined;
      if (session) updateDraftPreview(doc, session, false);
      for (const clear of draftViews.values()) clear();
      draftViews.clear();
      session = undefined;
      diagnostics.reset();
      activeArticle = undefined;
      blocked = undefined;
      submitted = undefined;
      replacementConsent = undefined;
      get<HTMLInputElement>('[data-replace-review]').checked = false;
      get('[data-submit-result]').hidden = true;
      get('[data-submit-reading]').hidden = true;
      get<HTMLAnchorElement>('[data-submit-pr]').removeAttribute('href');
      for (const dialog of [valueDialog, reviewDialog, confirmDialog])
        if (dialog.open) dialog.close();
      get('[data-source-diff]').replaceChildren();
      get('[data-value-fields]').replaceChildren();
      get('[data-review-guide]').textContent = '';
      get<HTMLInputElement>('[data-prepare-form] [name="title"]').value = '';
      get<HTMLTextAreaElement>('[data-prepare-form] [name="notes"]').value = '';
      const notice = doc.querySelector<HTMLElement>('[data-review-source]');
      if (notice) {
        notice.replaceChildren();
        notice.hidden = true;
      }
      toolbar.hidden = true;
    },
    get session() {
      return session;
    },
    get article() {
      return activeArticle;
    },
  };
}
