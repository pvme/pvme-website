import {
  initializePresetCarousel,
  initializeStandaloneMedia,
  disposePreviewMedia,
} from './preset-carousel';
import {
  jsonSource,
  patchJsonProperty,
  patchJsonArray,
  embedTextPath,
  type JsonPath,
} from '../lib/json-source';
import { parseGuide } from '@pvme/guide-parser';
import type { EditSession } from '../lib/edit-session';
import {
  canvasBlocks,
  canvasMessages,
  canvasSection,
  canvasLabels,
  canvasPalette,
  canvasTemplate,
  blockFields,
  changeBlockField,
  replaceCanvasBlock,
  insertCanvasBlock,
  moveCanvasBlock,
  sourceEol,
  type CanvasBlock,
  type CanvasKind,
  type CanvasMessage,
} from '../lib/page-canvas';
import { renderCanvasPreview, canvasTextSession } from './canvas-preview';
import { RichLineEditor } from './rich-line-editor';
import { updateDraftPreview } from './inline-preview';
import { preserveSourceLineEndings } from '../lib/source-diff';

export class PageCanvasEditor {
  readonly root: HTMLElement;
  private source: string;
  private renderedSource = '';
  private blocks: CanvasBlock[] = [];
  private selected = -1;
  private insertion?: number;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private board: HTMLElement;
  private inspector: HTMLElement;
  private inspectorAnchor?: HTMLElement;
  private status: HTMLElement;
  private controls: HTMLElement;
  private propertiesOpen = false;
  private propertyTarget?: string;
  private positionProperties = () => this.positionInspector();
  private text?: {
    editor: RichLineEditor;
    session: EditSession;
    block: CanvasBlock;
    base: string;
    recorded: boolean;
    path?: JsonPath;
    redoBefore: string[];
  };
  private generation = 0;
  private restoring = false;
  private propertiesDirty = false;
  private dropTarget?: HTMLElement;
  private scrollFrame?: number;
  private dragY = 0;
  private cancelDrag?: () => void;
  private coverUrls = new Set<string>();
  private mediaPreviews = new Map<string, HTMLElement[]>();
  private previewCleanups: (() => void)[] = [];
  private advancedSource = false;
  private messageSource?: {
    message: CanvasMessage;
    input: HTMLTextAreaElement;
  };
  constructor(
    private doc: Document,
    private article: HTMLElement,
    private session: EditSession,
    private changed: () => void,
  ) {
    this.source = session.content();
    for (const image of article.querySelectorAll<HTMLImageElement>(
      '.guide-cover img',
    ))
      if (image.getAttribute('src'))
        this.coverUrls.add(image.getAttribute('src')!);
    const templates = new Map<HTMLElement, HTMLElement>();
    for (const card of article.querySelectorAll<HTMLElement>(
      '.preset-preview-card,.media-preview-card',
    )) {
      const url = (
        card.matches('a[href]')
          ? card
          : card.querySelector<HTMLAnchorElement>('a[href]')
      )?.getAttribute('href');
      if (!url) continue;
      const owner = card.closest<HTMLElement>('[data-preset-carousel]') || card;
      let template = templates.get(owner);
      if (!template) {
        template = owner.cloneNode(true) as HTMLElement;
        delete template.dataset.carouselReady;
        template
          .querySelectorAll('iframe')
          .forEach((frame) => frame.removeAttribute('src'));
        templates.set(owner, template);
      }
      this.mediaPreviews.set(url, [template]);
    }

    this.root = doc.createElement('section');
    this.root.dataset.pageCanvas = '';
    this.root.className = 'page-canvas';
    this.root.setAttribute('aria-label', 'Guide page canvas');
    this.controls = doc.createElement('div');
    this.controls.className = 'canvas-session-tools';
    this.controls.setAttribute('role', 'group');
    this.controls.setAttribute('aria-label', 'Edit history');
    this.status = doc.createElement('p');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.controls.append(
      this.button('Undo', () => this.history(false), 'canvasUndo'),
      this.button('Redo', () => this.history(true), 'canvasRedo'),
      this.status,
    );
    for (const [selector, path, label] of [
      ['[data-canvas-undo]', 'M9 5 4 10l5 5 M4 10h10a6 6 0 0 1 0 12', 'Undo'],
      ['[data-canvas-redo]', 'm15 5 5 5-5 5 M20 10H10a6 6 0 0 0 0 12', 'Redo'],
    ]) {
      const button = this.controls.querySelector<HTMLButtonElement>(selector)!;
      const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '16');
      icon.setAttribute('height', '16');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.7');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.setAttribute('aria-hidden', 'true');
      const shape = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', path);
      icon.append(shape);
      button.replaceChildren(icon);
      button.title = label;
      button.setAttribute('aria-label', label);
    }
    const layout = doc.createElement('div');
    layout.className = 'canvas-workspace';
    this.board = doc.createElement('div');
    this.board.className = 'canvas-board';
    this.board.setAttribute('aria-label', 'Page content');
    // Snap drops anywhere in the content to the closest source boundary. Thin
    // hover-only insertion lines must not require pixel-perfect native dragging.
    this.board.addEventListener('dragover', (event) => {
      if (!this.root.hasAttribute('data-dragging')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.dragY = event.clientY;
      this.dropTarget?.removeAttribute('data-drop-active');
      const zones = [
        ...this.board.querySelectorAll<HTMLElement>('[data-canvas-drop]'),
      ];
      this.dropTarget = zones.reduce<HTMLElement | undefined>(
        (nearest, zone) =>
          !nearest ||
          Math.abs(zone.getBoundingClientRect().top + 9 - event.clientY) <
            Math.abs(nearest.getBoundingClientRect().top + 9 - event.clientY)
            ? zone
            : nearest,
        undefined,
      );
      this.dropTarget?.setAttribute('data-drop-active', '');
      this.announce('Release to move to the highlighted insertion line.');
      this.autoScroll();
    });
    this.board.addEventListener('drop', (event) => {
      if (!this.dropTarget || !this.root.hasAttribute('data-dragging')) return;
      event.preventDefault();
      const target = this.dropTarget;
      this.dropTarget = undefined;
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: event.dataTransfer,
        }),
      );
    });
    this.inspector = doc.createElement('aside');
    this.inspector.className = 'canvas-properties';
    this.inspector.setAttribute('aria-label', 'Block properties');
    this.inspector.hidden = true;
    this.inspector.setAttribute('role', 'dialog');
    layout.append(this.board, this.inspector);
    const historySlot = doc.querySelector('[data-editor-history]');
    (historySlot || this.root).append(this.controls);
    doc.querySelector('[data-editor-feedback]')?.append(this.status);
    this.root.append(layout);
    this.article.dataset.canvasActive = '';
    this.article.append(this.root);
    this.root.addEventListener('click', (event) => {
      if ((event.target as Element).closest('a')) event.preventDefault();
      event.stopPropagation();
    });
    this.root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.cancelDrag) {
        event.preventDefault();
        this.cancelDrag();
        this.announce('Move cancelled.');
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'z' &&
        !(event.target as Element).closest(
          'input,textarea,[contenteditable=true]',
        )
      ) {
        event.preventDefault();
        this.history(event.shiftKey);
        return;
      }
      if (
        event.key !== 'Escape' ||
        (event.target as Element).closest('.inline-line-input')
      )
        return;
      const menu = (event.target as Element).closest<HTMLElement>(
        '[data-canvas-insert-menu]',
      );
      if (menu) {
        this.closeInsertionMenus();
        menu.parentElement
          ?.querySelector<HTMLElement>('[data-canvas-drop]')
          ?.focus();
        event.stopPropagation();
      } else if (this.propertiesOpen && this.canLeaveProperties()) {
        this.propertiesOpen = false;
        this.inspector.hidden = true;
        this.board.querySelector<HTMLElement>('[data-selected]')?.focus();
      }
    });
    doc.defaultView?.addEventListener('resize', this.positionProperties);
    doc.defaultView?.addEventListener('scroll', this.positionProperties, true);
    this.render();
  }
  private autoScroll() {
    if (this.scrollFrame) return;
    const scroll = () => {
      const view = this.doc.defaultView;
      if (!view || !this.root.hasAttribute('data-dragging')) {
        this.scrollFrame = undefined;
        return;
      }
      if (this.dragY < 110 || this.dragY > view.innerHeight - 90)
        view.scrollBy(0, this.dragY < 110 ? -12 : 12);
      this.scrollFrame = view.requestAnimationFrame(scroll);
    };
    this.scrollFrame = this.doc.defaultView?.requestAnimationFrame?.(scroll);
  }
  private button(label: string, action: () => void, key?: string) {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (key) button.dataset[key] = '';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  }
  private announce(message: string, error = false) {
    this.status.textContent = message;
    this.status.dataset.error = String(error);
  }
  private apply(content: string, record = true) {
    if (content === this.source) return;
    this.session.setDocument(content);
    if (record) {
      this.undoStack.push(this.source);
      this.redoStack = [];
    }
    this.source = content;
    this.status.textContent = '';
    this.changed();
    this.updateHistory();
  }
  private updateHistory() {
    const undo =
      this.controls.querySelector<HTMLButtonElement>('[data-canvas-undo]');
    const redo =
      this.controls.querySelector<HTMLButtonElement>('[data-canvas-redo]');
    if (undo) undo.disabled = !this.undoStack.length;
    if (redo) redo.disabled = !this.redoStack.length;
  }
  sync() {
    const content = this.session.content();
    if (content === this.source) return;
    this.restoring = true;
    this.text?.editor.cancel();
    this.text?.editor.dispose();
    this.text = undefined;
    this.restoring = false;
    this.generation++;
    this.source = content;
    this.undoStack = [];
    this.redoStack = [];
    this.render();
  }
  get hasUnappliedChanges() {
    return (
      this.propertiesDirty ||
      (!!this.messageSource &&
        preserveSourceLineEndings(
          this.messageSource.message.source,
          this.messageSource.input.value,
        ) !== this.messageSource.message.source)
    );
  }
  finish(): boolean {
    return (
      this.finishMessageSource() &&
      this.canLeaveProperties() &&
      this.finishText()
    );
  }
  private canLeaveProperties() {
    if (this.messageSource && this.hasUnappliedChanges) {
      this.announce(
        'Finish or cancel this message source before editing another message.',
        true,
      );
      return false;
    }
    if (!this.propertiesDirty) return true;
    this.announce(
      'Apply or reset your property changes before leaving this block.',
      true,
    );
    return false;
  }
  close(keepDraftPreview = false): (() => void) | undefined {
    let preview: HTMLElement | undefined;
    if (keepDraftPreview) {
      this.render();
      preview = this.doc.createElement('div');
      preview.dataset.localDraftPreview = '';
      const notice = this.doc.createElement('p');
      notice.className = 'local-draft-notice';
      notice.textContent = 'Local draft preview · Unpublished';
      preview.append(notice);
      for (const card of this.board.querySelectorAll<HTMLElement>(
        '[data-canvas-block]',
      )) {
        if (
          ['settings', 'source', 'divider'].includes(
            card.dataset.canvasKind || '',
          )
        )
          continue;
        const content = card
          .querySelector<HTMLElement>('[data-canvas-preview]')
          ?.cloneNode(true) as HTMLElement | undefined;
        if (!content) continue;
        content.classList.remove('canvas-block-preview');
        content.classList.add('guide-message');
        content.removeAttribute('data-canvas-preview');
        content
          .querySelectorAll('.canvas-embed-field-tools,.canvas-embed-add')
          .forEach((element) => element.remove());
        content
          .querySelectorAll<HTMLElement>('[data-embed-text]')
          .forEach((element) => {
            delete element.dataset.embedText;
            element.removeAttribute('tabindex');
            element.removeAttribute('aria-label');
          });
        content
          .querySelectorAll<HTMLElement>('[data-preset-carousel]')
          .forEach((carousel) => {
            delete carousel.dataset.carouselReady;
          });
        content
          .querySelectorAll('iframe[data-media-src]')
          .forEach((frame) => frame.removeAttribute('src'));
        preview.append(content);
      }
    }
    this.cancelDrag?.();
    disposePreviewMedia(this.board);
    this.previewCleanups.splice(0).forEach((cleanup) => cleanup());
    if (this.scrollFrame)
      this.doc.defaultView?.cancelAnimationFrame(this.scrollFrame);
    this.restoring = true;
    this.text?.editor.dispose();
    this.text = undefined;
    this.generation++;
    this.root.remove();
    this.controls.remove();
    this.status.remove();
    this.doc.defaultView?.removeEventListener(
      'resize',
      this.positionProperties,
    );
    this.doc.defaultView?.removeEventListener(
      'scroll',
      this.positionProperties,
      true,
    );
    delete this.article.dataset.canvasActive;
    if (preview) {
      const reading = preview;
      this.article.dataset.localDraftReading = '';
      this.article.append(reading);
      const cleanups = [
        ...reading.querySelectorAll<HTMLElement>('[data-preset-carousel]'),
      ].map(initializePresetCarousel);
      initializeStandaloneMedia(reading);
      return () => {
        cleanups.forEach((cleanup) => cleanup?.());
        disposePreviewMedia(reading);
        reading.remove();
        delete this.article.dataset.localDraftReading;
      };
    }
  }
  private finishText() {
    if (!this.text) return true;
    if (!this.text.editor.finish()) return false;
    this.text.editor.dispose();
    this.text = undefined;
    this.generation++;
    return true;
  }
  private history(redo: boolean) {
    if (!this.canLeaveProperties()) return;
    if (!this.finishText()) return;
    const from = redo ? this.redoStack : this.undoStack,
      to = redo ? this.undoStack : this.redoStack;
    const value = from.at(-1);
    if (value === undefined) return;
    try {
      const current = this.source;
      this.apply(value, false);
      from.pop();
      to.push(current);
      this.render();
      this.announce(redo ? 'Change restored.' : 'Change undone.');
    } catch (error) {
      this.error(error);
    }
  }
  private error(error: unknown) {
    this.announce(
      error instanceof Error ? error.message : 'Unable to change this block',
      true,
    );
  }
  private render() {
    this.messageSource = undefined;
    this.propertiesDirty = false;
    this.blocks = canvasBlocks(this.source);
    this.renderedSource = this.source;
    disposePreviewMedia(this.board);
    this.previewCleanups.splice(0).forEach((cleanup) => cleanup());
    this.board.replaceChildren();
    this.selected = Math.min(this.selected, this.blocks.length - 1);
    this.blocks.forEach((block, index) => {
      const card = this.doc.createElement('section');
      card.className = 'canvas-block';
      card.dataset.canvasBlock = block.id;
      card.dataset.canvasKind = block.kind;
      card.tabIndex = 0;
      card.setAttribute(
        'aria-label',
        `${canvasLabels[block.kind]} block ${index + 1}`,
      );
      card.toggleAttribute('data-selected', this.selected === index);
      const header = this.doc.createElement('header');
      header.className = 'canvas-block-tools';
      const grip = this.button('⠿', () => this.select(index));
      grip.title =
        block.kind === 'heading'
          ? 'Drag complete heading section'
          : 'Drag block';
      grip.draggable = true;
      grip.style.touchAction = 'none';
      // Pointer capture also supports touch and native automation drivers whose
      // HTML drag sequence ends before Chromium dispatches dragover/drop.
      let pointer: { x: number; y: number; moved: boolean } | undefined;
      const pointTarget = (y: number) => {
        const zones = [
          ...this.board.querySelectorAll<HTMLElement>('[data-canvas-drop]'),
        ];
        return zones.reduce<HTMLElement | undefined>(
          (nearest, zone) =>
            !nearest ||
            Math.abs(zone.getBoundingClientRect().top + 9 - y) <
              Math.abs(nearest.getBoundingClientRect().top + 9 - y)
              ? zone
              : nearest,
          undefined,
        );
      };
      grip.addEventListener('pointerdown', (event) => {
        if (
          event.button !== 0 ||
          !this.canLeaveProperties() ||
          !this.finishText()
        )
          return;
        pointer = { x: event.clientX, y: event.clientY, moved: false };
        this.cancelDrag = cancelPointer;
        event.preventDefault();
        grip.focus({ preventScroll: true });
        grip.setPointerCapture?.(event.pointerId);
      });
      grip.addEventListener('pointermove', (event) => {
        if (
          !pointer ||
          Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) < 6
        )
          return;
        pointer.moved = true;
        this.root.dataset.dragging = '';
        this.dropTarget?.removeAttribute('data-drop-active');
        this.dropTarget = pointTarget(event.clientY);
        this.dropTarget?.setAttribute('data-drop-active', '');
        this.dragY = event.clientY;
        this.autoScroll();
        const height = this.doc.defaultView?.innerHeight || 800;
        if (event.clientY < 110 || event.clientY > height - 90)
          this.doc.defaultView?.scrollBy(0, event.clientY < 110 ? -24 : 24);
      });
      const cancelPointer = () => {
        pointer = undefined;
        this.cancelDrag = undefined;
        delete this.root.dataset.dragging;
        this.dropTarget?.removeAttribute('data-drop-active');
        this.dropTarget = undefined;
      };
      grip.addEventListener('pointercancel', cancelPointer);
      grip.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          cancelPointer();
          this.announce('Move cancelled.');
        }
      });
      grip.addEventListener('pointerup', (event) => {
        const dragged =
          pointer &&
          (pointer.moved ||
            Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >=
              6);
        const target = pointTarget(event.clientY);
        cancelPointer();
        if (!dragged || !target) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          const current = this.currentBlock(index);
          if (!current)
            throw new Error('Select this block again before moving it');
          this.apply(
            moveCanvasBlock(
              this.source,
              current,
              this.rebaseOffset(Number(target.dataset.canvasDrop)),
            ),
          );
          this.render();
          this.announce(
            current.kind === 'heading' ? 'Section moved.' : 'Block moved.',
          );
        } catch (error) {
          this.error(error);
        }
      });
      grip.setAttribute(
        'aria-label',
        `Drag ${canvasLabels[block.kind]} block ${index + 1}`,
      );
      grip.addEventListener('dragstart', (event) => {
        if (!this.finishText()) {
          event.preventDefault();
          return;
        }
        const current = this.currentBlock(index);
        if (!current)
          throw new Error('Select this block again before moving it');
        event.dataTransfer?.setData(
          'application/x-pvme-canvas',
          JSON.stringify({ type: 'move', id: current?.id }),
        );
        event.dataTransfer?.setData(
          'text/plain',
          'pvme:' + JSON.stringify({ type: 'move', id: current?.id }),
        );
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        this.announce('Drag to an insertion line. Escape cancels.');
        this.root.dataset.dragging = '';
      });
      grip.addEventListener('dragend', () => {
        if (this.root.hasAttribute('data-dragging'))
          this.announce('Move cancelled.');
        delete this.root.dataset.dragging;
        this.dropTarget?.removeAttribute('data-drop-active');
        this.dropTarget = undefined;
      });
      const up = this.button(
        block.kind === 'heading' ? 'Move section up' : 'Move block up',
        () => this.move(index, -1),
      );
      up.setAttribute('aria-label', 'Move block up');
      up.disabled = index === 0;
      const down = this.button(
        block.kind === 'heading' ? 'Move section down' : 'Move block down',
        () => this.move(index, 1),
      );
      down.setAttribute('aria-label', 'Move block down');
      down.disabled = index === this.blocks.length - 1;
      const more = this.doc.createElement('details');
      more.className = 'canvas-block-menu';
      const summary = this.doc.createElement('summary');
      summary.textContent = '⋯';
      summary.setAttribute('aria-label', 'More block actions');
      const actions = this.doc.createElement('div');
      actions.append(
        up,
        down,
        this.button(
          block.kind === 'heading' ? 'Duplicate section' : 'Duplicate',
          () => this.duplicate(index),
        ),
        this.button(
          block.kind === 'heading' ? 'Remove section' : 'Remove',
          () => this.remove(index),
        ),
      );
      more.append(summary, actions);
      actions.prepend(
        this.button('Settings', () => this.select(index, true)),
        this.button('Advanced source', () => {
          if (!this.select(index, true, undefined, true)) return;
          const details =
            this.inspector.querySelector<HTMLDetailsElement>('.canvas-source');
          if (details) details.open = true;
        }),
      );
      header.append(grip, more);
      const preview = renderCanvasPreview(
        this.doc,
        block,
        undefined,
        this.session.loaded.previewLinks,
      );
      if (block.kind === 'embed') this.embedControls(preview, index);
      preview.dataset.canvasPreview = '';
      if (
        block.kind === 'image' &&
        [...preview.querySelectorAll('img')].some((image) =>
          this.coverUrls.has(image.getAttribute('src') || ''),
        )
      )
        preview.classList.add('guide-cover');
      const appended = new Set<HTMLElement>();
      for (const [url, cards] of this.mediaPreviews)
        if (
          [...preview.querySelectorAll('a')].some(
            (link) => link.getAttribute('href') === url,
          )
        ) {
          for (const media of cards)
            if (!appended.has(media)) {
              appended.add(media);
              preview.append(media.cloneNode(true));
            }
        }
      preview.addEventListener('click', (event) => {
        if (
          (event.target as Element).closest(
            '[data-preset-carousel] button,[data-preset-track]',
          ) &&
          !(event.target as Element).closest('a')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const embedTarget = (event.target as Element).closest<HTMLElement>(
          '[data-embed-text]',
        );
        if (this.text && this.selected === index && !embedTarget) return;
        if (embedTarget) {
          if (!this.finishText() || !this.select(index, false)) return;
          void this.editText(
            this.selected,
            {
              x: (event as MouseEvent).clientX,
              y: (event as MouseEvent).clientY,
            },
            JSON.parse(embedTarget.dataset.embedText!),
          );
          return;
        }
        if (!this.finishText()) return;
        const editable =
          ['text', 'heading', 'list'].includes(block.kind) &&
          !(event.target as Element).closest('a,img');
        const media = (event.target as Element).closest('a,img');
        if (
          !this.select(
            index,
            !editable,
            media?.getAttribute(media.tagName === 'IMG' ? 'src' : 'href') ||
              undefined,
          )
        )
          return;
        if (editable)
          void this.editText(this.selected, {
            x: (event as MouseEvent).clientX,
            y: (event as MouseEvent).clientY,
          });
      });
      card.addEventListener('keydown', (event) => {
        const embedTarget = (event.target as Element).closest<HTMLElement>(
          '[data-embed-text]',
        );
        if (embedTarget && event.key === 'Enter') {
          event.preventDefault();
          void this.editText(
            index,
            undefined,
            JSON.parse(embedTarget.dataset.embedText!),
          );
          return;
        }
        if (event.target !== card) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (['text', 'heading', 'list'].includes(block.kind))
            void this.editText(index);
          else this.select(index);
        }
      });
      card.append(header, preview);
      // Source commands, message separators and reading-view-suppressed content
      // are retained, but must not create extra insertion rows in a visible gap.
      const suppressed =
        ['settings', 'source', 'divider'].includes(block.kind) ||
        (preview.hasAttribute('data-canvas-suppressed') &&
          !preview.childNodes.length) ||
        (!!this.article.closest('.hub-page') &&
          (preview.classList.contains('guide-cover') ||
            !!preview.querySelector('.guide-document-title')));
      if (!suppressed) this.board.append(this.dropZone(block.start));
      this.board.append(card);
    });
    this.board.append(this.dropZone(this.source.length));
    if (!this.blocks.length) {
      const empty = this.doc.createElement('p');
      empty.textContent = 'Use Insert here to start your page.';
      this.board.prepend(empty);
    }
    this.groupMessages();
    this.board
      .querySelectorAll<HTMLElement>('[data-preset-carousel]')
      .forEach((carousel) => {
        const cleanup = initializePresetCarousel(carousel);
        if (cleanup) this.previewCleanups.push(cleanup);
      });
    initializeStandaloneMedia(this.board);
    this.properties();
    this.updateHistory();
  }
  private currentMessage(index: number) {
    const block = this.currentBlock(index);
    return (
      block &&
      canvasMessages(this.source).find(
        (message) => block.start >= message.start && block.end <= message.end,
      )
    );
  }
  private groupMessages() {
    const cards = [
      ...this.board.querySelectorAll<HTMLElement>('[data-canvas-block]'),
    ];
    const messages = canvasMessages(this.source);
    // Insert only between original messages, never between their text chunks.
    this.board
      .querySelectorAll('.canvas-insert-anchor')
      .forEach((anchor) => anchor.remove());
    for (const message of messages) {
      const members = this.blocks
        .map((block, index) => ({ block, index, card: cards[index] }))
        .filter(
          ({ block }) =>
            block.start >= message.start &&
            block.end <= message.end &&
            block.kind !== 'divider',
        );
      const visible = members.some(
        ({ block, card }) =>
          !['settings', 'source'].includes(block.kind) &&
          !card.querySelector('[data-canvas-suppressed]:empty') &&
          !(
            this.article.closest('.hub-page') &&
            card.querySelector('.guide-cover,.guide-document-title')
          ),
      );
      if (!members.length || !visible) continue;
      const group = this.doc.createElement('section');
      group.className = 'canvas-message';
      group.dataset.canvasMessage = message.id;
      group.setAttribute('aria-label', 'Message');
      const index = members[0].index;
      group.toggleAttribute(
        'data-message-selected',
        members.some((member) => member.index === this.selected),
      );
      const controls = this.doc.createElement('div');
      controls.className = 'canvas-message-modes';
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', 'Message editing mode');
      const inline = this.button('Inline', () => {
        if (!this.finishMessageSource() || !this.canLeaveProperties()) return;
        void this.editText(index);
      });
      inline.dataset.messageInline = '';
      inline.setAttribute('aria-pressed', 'true');
      const source = this.button('Source', () => this.openMessageSource(index));
      source.dataset.messageSource = '';
      source.setAttribute('aria-pressed', 'false');
      controls.append(inline, source);
      const content = this.doc.createElement('div');
      content.dataset.messageContent = '';
      members[0].card.before(this.dropZone(message.start), group);
      for (const member of members) content.append(member.card);
      group.append(controls, content);
      group.addEventListener('click', (event) => {
        if (event.target !== group && event.target !== content) return;
        event.preventDefault();
        void this.editText(index);
      });
    }
    this.board.append(this.dropZone(this.source.length));
  }
  private finishMessageSource() {
    const state = this.messageSource;
    if (!state) return true;
    try {
      this.apply(
        replaceCanvasBlock(
          this.source,
          state.message,
          preserveSourceLineEndings(state.message.source, state.input.value),
        ),
      );
      this.messageSource = undefined;
      this.render();
      return true;
    } catch (error) {
      this.error(error);
      state.input.focus({ preventScroll: true });
      return false;
    }
  }
  private openMessageSource(index: number) {
    if (this.messageSource) return;
    if (!this.canLeaveProperties() || !this.finishText()) return;
    const message = this.currentMessage(index);
    if (!message) return;
    this.render();
    const group = [
      ...this.board.querySelectorAll<HTMLElement>('[data-canvas-message]'),
    ].find((group) => group.dataset.canvasMessage === message.id);
    if (!group) return;
    this.selected = this.blocks.findIndex(
      (block) => block.start >= message.start && block.end <= message.end,
    );
    this.propertiesOpen = false;
    this.inspector.hidden = true;
    group.dataset.messageSelected = '';
    group
      .querySelector('[data-message-inline]')
      ?.setAttribute('aria-pressed', 'false');
    group
      .querySelector('[data-message-source]')
      ?.setAttribute('aria-pressed', 'true');
    const form = this.doc.createElement('form');
    form.className = 'canvas-message-source-editor';
    const input = this.doc.createElement('textarea');
    input.value = message.source;
    input.dataset.canvasMessageSource = '';
    input.setAttribute('aria-label', 'Message source');
    input.spellcheck = false;
    input.rows = Math.max(6, Math.min(24, message.source.split('\n').length));
    this.messageSource = { message, input };
    const apply = this.doc.createElement('button');
    apply.type = 'submit';
    apply.textContent = 'Done';
    apply.dataset.messageSourceDone = '';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.finishMessageSource();
    });
    input.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        this.finishMessageSource();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.messageSource = undefined;
        this.render();
      }
    });
    form.append(
      input,
      apply,
      this.button('Cancel', () => {
        this.messageSource = undefined;
        this.render();
      }),
    );
    group.querySelector('[data-message-content]')!.replaceChildren(form);
    input.focus({ preventScroll: true });
  }
  private select(
    index: number,
    showProperties = true,
    target?: string,
    advanced = false,
  ) {
    this.closeInsertionMenus();
    if (this.propertiesDirty)
      return index === this.selected || this.canLeaveProperties();
    if (index !== this.selected) this.generation++;
    if (this.text && this.selected !== index && !this.finishText()) return;
    if (this.renderedSource !== this.source) {
      const target = this.blocks[index];
      const offset = target ? this.rebaseOffset(target.start) : undefined;
      this.render();
      if (target) {
        const matching = this.blocks.findIndex(
          (block) => block.start === offset && block.kind === target.kind,
        );
        if (matching >= 0) index = matching;
      }
    }
    this.selected = index;
    this.inspectorAnchor = undefined;
    this.propertiesOpen = showProperties;
    this.propertyTarget = target;
    this.advancedSource = advanced;
    this.insertion = this.blocks[index]?.end;
    this.root
      .querySelectorAll<HTMLElement>('[data-canvas-block]')
      .forEach((card, position) =>
        card.toggleAttribute('data-selected', position === index),
      );
    this.board
      .querySelectorAll<HTMLElement>('[data-canvas-message]')
      .forEach((group) =>
        group.toggleAttribute(
          'data-message-selected',
          !!group.querySelector('[data-selected]'),
        ),
      );
    this.properties();
    return true;
  }
  private dropZone(offset: number) {
    const anchor = this.doc.createElement('div');
    anchor.className = 'canvas-insert-anchor';
    const zone = this.button('+ Insert here', () => {
      if (!this.canLeaveProperties() || !this.finishText()) return;
      this.insertion = offset;
      const existing = anchor.querySelector<HTMLElement>(
        '[data-canvas-insert-menu]',
      );
      const opening = !existing || existing.hidden;
      this.closeInsertionMenus();
      if (!opening) {
        zone.setAttribute('aria-expanded', 'false');
        return;
      }
      const menu = existing || this.insertionMenu(offset);
      menu.hidden = false;
      anchor.append(menu);
      zone.setAttribute('aria-expanded', 'true');
      menu.querySelector<HTMLElement>('[data-canvas-new]')?.focus();
    });
    zone.setAttribute('aria-expanded', 'false');
    zone.setAttribute('aria-haspopup', 'true');
    zone.className = 'canvas-drop-zone';
    zone.dataset.canvasDrop = String(offset);
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.dataset.dropActive = '';
      const height = this.doc.defaultView?.innerHeight || 800;
      if (event.clientY < 100 || event.clientY > height - 100)
        this.doc.defaultView?.scrollBy({ top: event.clientY < 100 ? -24 : 24 });
    });
    zone.addEventListener('dragleave', () => {
      delete zone.dataset.dropActive;
    });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      if (!this.canLeaveProperties()) return;
      event.stopPropagation();
      delete zone.dataset.dropActive;
      delete this.root.dataset.dragging;
      if (!this.finishText()) return;
      try {
        const raw =
          event.dataTransfer?.getData('application/x-pvme-canvas') ||
          event.dataTransfer?.getData('text/plain')?.replace(/^pvme:/, '');
        if (!raw)
          throw new Error(
            'Drag a block here, or choose a new block from Insert here.',
          );
        const data = JSON.parse(raw);
        if (data.type === 'new' && canvasPalette.includes(data.kind))
          this.insert(data.kind, offset);
        else if (data.type === 'move') {
          const block = canvasBlocks(this.source).find(
            (block) => block.id === data.id,
          );
          if (!block)
            throw new Error('The dragged block changed. Drag it again.');
          this.apply(
            moveCanvasBlock(this.source, block, this.rebaseOffset(offset)),
          );
          this.render();
          this.announce('Block moved.');
        } else throw new Error('Unsupported canvas drop');
      } catch (error) {
        this.error(error);
      }
    });
    anchor.append(zone);
    return anchor;
  }
  private insertionMenu(offset: number) {
    const menu = this.doc.createElement('div');
    menu.className = 'canvas-insert-menu';
    menu.dataset.canvasInsertMenu = '';
    menu.setAttribute('role', 'menu');
    menu.addEventListener('keydown', (event) => {
      const buttons = [
        ...menu.querySelectorAll<HTMLButtonElement>('[data-canvas-new]'),
      ];
      const index = buttons.indexOf(
        this.doc.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === 'ArrowDown'
          ? (index + 1) % buttons.length
          : event.key === 'ArrowUp'
            ? (index - 1 + buttons.length) % buttons.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : -1;
      if (next >= 0) {
        event.preventDefault();
        buttons[next].focus();
      }
    });
    menu.setAttribute('aria-label', 'Insert content');
    for (const kind of canvasPalette) {
      const button = this.button(canvasLabels[kind], () =>
        this.insert(kind, offset),
      );
      button.dataset.canvasNew = kind;
      button.setAttribute('role', 'menuitem');
      const icon = this.doc.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent =
        (
          {
            text: 'T',
            heading: 'H',
            list: '☷',
            image: '▧',
            preset: '▦',
            video: '▷',
            embed: '▣',
            code: '⌘',
            divider: '—',
          } as Partial<Record<CanvasKind, string>>
        )[kind] || '+';
      button.prepend(icon);
      button.draggable = true;
      button.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(
          'application/x-pvme-canvas',
          JSON.stringify({ type: 'new', kind }),
        );
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        this.root.dataset.dragging = '';
      });
      button.addEventListener('dragend', () => {
        delete this.root.dataset.dragging;
      });
      menu.append(button);
    }
    return menu;
  }
  private closeInsertionMenus() {
    this.root
      .querySelectorAll<HTMLElement>('[data-canvas-insert-menu]')
      .forEach((menu) => {
        menu.hidden = true;
      });
    this.root
      .querySelectorAll('[data-canvas-drop]')
      .forEach((zone) => zone.setAttribute('aria-expanded', 'false'));
  }
  private insert(kind: CanvasKind, target?: number) {
    if (!this.canLeaveProperties()) return;
    if (!this.finishText()) return;
    try {
      const offset = Math.min(
        this.rebaseOffset(
          target ?? this.insertion ?? this.renderedSource.length,
        ),
        this.source.length,
      );
      this.apply(
        insertCanvasBlock(
          this.source,
          offset,
          canvasTemplate(kind, this.source),
        ),
      );
      this.render();
      this.selected = this.blocks.findIndex(
        (block) => block.start >= offset && block.kind === kind,
      );
      if (this.selected < 0)
        this.selected = this.blocks.findIndex((block) => block.start >= offset);
      this.select(this.selected, !['text', 'heading', 'list'].includes(kind));
      this.announce(`${canvasLabels[kind]} added.`);
    } catch (error) {
      this.error(error);
    }
  }
  private currentBlock(index: number) {
    const original = this.blocks[index];
    if (!original) return;
    const offset = this.rebaseOffset(original.start);
    return canvasBlocks(this.source).find((block) => block.start === offset);
  }
  private rebaseOffset(offset: number) {
    if (this.renderedSource === this.source) return offset;
    let start = 0,
      suffix = 0;
    while (
      start < this.renderedSource.length &&
      start < this.source.length &&
      this.renderedSource[start] === this.source[start]
    )
      start++;
    while (
      suffix < this.renderedSource.length - start &&
      suffix < this.source.length - start &&
      this.renderedSource[this.renderedSource.length - suffix - 1] ===
        this.source[this.source.length - suffix - 1]
    )
      suffix++;
    return offset <= start
      ? offset
      : offset >= this.renderedSource.length - suffix
        ? offset + this.source.length - this.renderedSource.length
        : start;
  }
  private move(index: number, direction: number) {
    if (!this.canLeaveProperties()) return;
    if (!this.finishText()) return;
    const blocks = canvasBlocks(this.source);
    const current = this.currentBlock(index);
    index = blocks.findIndex((block) => block.id === current?.id);
    const block = blocks[index],
      other =
        block?.node?.type === 'heading'
          ? (direction < 0
              ? blocks.slice(0, index).reverse()
              : blocks.slice(index + 1)
            ).find(
              (candidate) =>
                candidate.node?.type === 'heading' &&
                candidate.node.level <= (block.node as { level: number }).level,
            )
          : blocks[index + direction];
    if (!block || !other) return;
    try {
      this.apply(
        moveCanvasBlock(
          this.source,
          block,
          direction < 0
            ? canvasSection(this.source, other).start
            : canvasSection(this.source, other).end,
        ),
      );
      this.selected = index + direction;
      this.render();
      this.announce('Block moved.');
    } catch (error) {
      this.error(error);
    }
  }
  private duplicate(index: number) {
    if (!this.canLeaveProperties()) return;
    if (!this.finishText()) return;
    const selected = this.currentBlock(index);
    if (!selected) return;
    const block = canvasSection(this.source, selected);
    try {
      const eol = sourceEol(this.source);
      const content =
        block.kind === 'embed' || block.node?.type === 'attachment'
          ? `.${eol}${block.source}${eol}.`
          : block.source;
      this.apply(insertCanvasBlock(this.source, block.end, content));
      this.render();
      this.announce('Block duplicated.');
    } catch (error) {
      this.error(error);
    }
  }
  private remove(index: number) {
    if (!this.canLeaveProperties()) return;
    if (!this.finishText()) return;
    const selected = this.currentBlock(index);
    if (!selected) return;
    const block = canvasSection(this.source, selected);
    try {
      this.apply(replaceCanvasBlock(this.source, block, ''));
      this.render();
      this.announce('Block removed. Use Undo to restore it.');
    } catch (error) {
      this.error(error);
    }
  }
  private properties() {
    this.inspector.replaceChildren();
    const block = canvasBlocks(this.source)[this.selected];
    this.inspector.hidden = !block || !this.propertiesOpen;
    if (!block) return;
    const heading = this.doc.createElement('div');
    heading.className = 'canvas-properties-heading';
    const title = this.doc.createElement('h3');
    title.textContent = this.advancedSource
      ? 'Section source'
      : this.propertyTarget
        ? 'Edit link'
        : canvasLabels[block.kind];
    const close = this.button('×', () => {
      if (!this.canLeaveProperties()) return;
      this.propertiesOpen = false;
      this.inspector.hidden = true;
      this.board.querySelector<HTMLElement>('[data-selected]')?.focus();
    });
    close.setAttribute('aria-label', 'Close properties');
    heading.append(title, close);
    this.inspector.append(heading);
    if (
      !this.propertyTarget &&
      !this.advancedSource &&
      ['text', 'heading', 'list'].includes(block.kind)
    )
      this.inspector.append(
        this.button('Edit text on page', () => {
          void this.editText(this.selected);
        }),
      );
    const allFields = blockFields(block);
    if (block.node?.type === 'embed' && block.node.valid) {
      try {
        for (const [encoded, token] of jsonSource(block.source).tokens) {
          const path: JsonPath = JSON.parse(encoded);
          if (
            path.at(-2) === 'fields' &&
            typeof path.at(-1) === 'number' &&
            token.value &&
            typeof token.value === 'object' &&
            !Object.hasOwn(token.value, 'inline')
          )
            allFields.push({
              label: 'Inline field',
              type: 'boolean',
              value: 'false',
              path: [...path, 'inline'],
            });
        }
      } catch {
        /* Ambiguous JSON remains available in advanced source. */
      }
    }
    const fields = allFields.filter((field) =>
      field.path
        ? !embedTextPath(field.path) &&
          ['color', 'url', 'icon_url', 'inline', 'timestamp'].includes(
            String(field.path.at(-1)),
          )
        : !this.propertyTarget ||
          (field.node &&
            'url' in field.node &&
            field.node.url === this.propertyTarget) ||
          field.value === this.propertyTarget,
    );
    if (fields.length && !this.advancedSource) {
      const form = this.doc.createElement('form');
      form.dataset.canvasPropertiesForm = '';
      fields.forEach((field) => {
        const label = this.doc.createElement('label');
        label.textContent = field.path
          ? field.path
              .filter(
                (key) => !['embed', 'embeds', 'fields'].includes(String(key)),
              )
              .map((key) =>
                typeof key === 'number'
                  ? `Field ${key + 1}`
                  : key.replace(/_/g, ' '),
              )
              .join(' · ')
          : field.label;
        const input = this.doc.createElement(
          field.type === 'text' && !this.propertyTarget ? 'textarea' : 'input',
        );
        if (input.tagName === 'INPUT') {
          (input as HTMLInputElement).type =
            field.path?.at(-1) === 'color' &&
            field.type === 'number' &&
            Number.isInteger(Number(field.value)) &&
            Number(field.value) >= 0 &&
            Number(field.value) <= 0xffffff
              ? 'color'
              : field.type === 'boolean'
                ? 'checkbox'
                : 'text';
          if (field.type === 'url')
            (input as HTMLInputElement).inputMode = 'url';
        }
        input.value =
          (input as HTMLInputElement).type === 'color'
            ? '#' + Number(field.value).toString(16).padStart(6, '0')
            : field.value;
        if ((input as HTMLInputElement).type === 'checkbox')
          (input as HTMLInputElement).checked = field.value === 'true';
        input.dataset.canvasField = String(allFields.indexOf(field));
        input.setAttribute('aria-label', label.textContent || field.label);
        input.addEventListener('input', () => {
          this.propertiesDirty = true;
          const reset = this.inspector.querySelector<HTMLElement>(
            '[data-canvas-reset]',
          );
          if (reset) reset.hidden = false;
          this.announce('Apply properties to save these values to your draft.');
        });
        label.append(input);
        form.append(label);
      });
      const save = this.doc.createElement('button');
      save.type = 'submit';
      save.textContent = 'Apply';
      form.append(save);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!this.finishText()) return;
        try {
          let source = this.source;
          for (const input of form.querySelectorAll<
            HTMLInputElement | HTMLTextAreaElement
          >('[data-canvas-field]')) {
            const current = canvasBlocks(source)[this.selected];
            if (!current) throw new Error('Select this block again');
            const original = allFields[Number(input.dataset.canvasField)];
            const field = original.path
              ? blockFields(current).find(
                  (field) =>
                    JSON.stringify(field.path) ===
                    JSON.stringify(original.path),
                ) || original
              : blockFields(current)[Number(input.dataset.canvasField)];
            const value =
              input.type === 'color'
                ? String(parseInt(input.value.slice(1), 16))
                : input.type === 'checkbox'
                  ? String((input as HTMLInputElement).checked)
                  : input.value;
            if (field && field.value !== value)
              source = replaceCanvasBlock(
                source,
                current,
                changeBlockField(current, field, value),
              );
          }
          this.apply(source);
          if (block.kind !== 'embed') this.propertiesOpen = false;
          this.render();
          this.announce('Properties updated.');
        } catch (error) {
          this.error(error);
        }
      });
      this.inspector.append(form);
    }
    if (block.node?.type === 'embed' && block.node.valid) {
      const add = this.doc.createElement('select');
      add.setAttribute('aria-label', 'Add embed property');
      for (const [label, key] of [
        ['Add property…', ''],
        ['Colour', 'color'],
        ['Image URL', 'image'],
        ['Thumbnail URL', 'thumbnail'],
        ['Author', 'author'],
        ['Footer', 'footer'],
      ]) {
        const option = this.doc.createElement('option');
        option.textContent = label;
        option.value = key;
        add.append(option);
      }
      add.addEventListener('change', () => {
        if (!add.value || !this.canLeaveProperties() || !this.finishText())
          return;
        try {
          const current = canvasBlocks(this.source)[this.selected];
          const mapping = jsonSource(current.source);
          const root = mapping.value as any;
          const path: JsonPath = root.embed
            ? ['embed']
            : root.embeds
              ? ['embeds', 0]
              : [];
          const key = add.value;
          if (mapping.tokens.has(JSON.stringify([...path, key])))
            throw new Error('This property already exists');
          const value =
            key === 'color'
              ? 5793266
              : key === 'author'
                ? { name: 'Author' }
                : key === 'footer'
                  ? { text: 'Footer' }
                  : { url: '' };
          this.apply(
            replaceCanvasBlock(
              this.source,
              current,
              patchJsonProperty(current.source, [...path, key], value),
            ),
          );
          this.render();
        } catch (error) {
          this.error(error);
        }
      });
      this.inspector.append(add);
    }
    const details = this.doc.createElement('details');
    details.className = 'canvas-source';
    const summary = this.doc.createElement('summary');
    summary.textContent = 'Edit section source';
    const input = this.doc.createElement('textarea');
    input.value = block.source;
    input.dataset.canvasSource = '';
    input.setAttribute('aria-label', 'Section source');
    input.spellcheck = false;
    input.addEventListener('input', () => {
      this.propertiesDirty = true;
      const reset = this.inspector.querySelector<HTMLElement>(
        '[data-canvas-reset]',
      );
      if (reset) reset.hidden = false;
      this.announce('Apply source to save this section to your draft.');
    });
    details.append(
      summary,
      input,
      this.button('Apply source', () => {
        if (!this.finishText()) return;
        try {
          const current = canvasBlocks(this.source)[this.selected];
          if (!current) return;
          this.apply(replaceCanvasBlock(this.source, current, input.value));
          this.render();
          this.announce('Section updated.');
        } catch (error) {
          this.error(error);
        }
      }),
    );
    if (
      this.advancedSource ||
      ['settings', 'source', 'code'].includes(block.kind)
    ) {
      details.open = true;
      this.inspector.append(details);
    }
    const reset = this.button('Reset property changes', () => {
      this.propertiesDirty = false;
      this.properties();
      this.announce('Unapplied property changes reset.');
    });
    reset.dataset.canvasReset = '';
    reset.hidden = !this.propertiesDirty;
    reset.textContent = 'Cancel';
    reset.title = 'Discard unapplied property changes';
    this.inspector.append(reset);
    const diagnostics = parseGuide(this.source).diagnostics;
    if (diagnostics.length) {
      const note = this.doc.createElement('p');
      note.className = 'canvas-diagnostics';
      note.textContent = `${diagnostics.length} source notice${diagnostics.length === 1 ? '' : 's'}. Review the source diff before exporting.`;
      this.inspector.append(note);
    }
    this.positionInspector();
  }
  private embedControls(preview: HTMLElement, index: number) {
    const change = (path: JsonPath, operation: (fields: any[]) => void) => {
      if (!this.canLeaveProperties() || !this.finishText()) return;
      try {
        const block = this.currentBlock(index);
        if (!block) throw new Error('Select this embed again');
        const mapping = jsonSource(block.source);
        const original = mapping.tokens.get(JSON.stringify(path))?.value;
        if (original !== undefined && !Array.isArray(original))
          throw new Error('Use advanced source for these fields');
        const fields = JSON.parse(JSON.stringify(original || []));
        operation(fields);
        this.apply(
          replaceCanvasBlock(
            this.source,
            block,
            patchJsonArray(block.source, path, fields),
          ),
        );
        this.render();
        this.announce('Embed fields updated.');
      } catch (error) {
        this.error(error);
      }
    };
    preview
      .querySelectorAll<HTMLElement>('[data-embed-container]')
      .forEach((container) => {
        const path: JsonPath = [
          ...JSON.parse(container.dataset.embedContainer!),
          'fields',
        ];
        const button = this.button('+ Field', () =>
          change(path, (fields) =>
            fields.push({
              name: 'New field',
              value: 'Field content',
              inline: false,
            }),
          ),
        );
        button.className = 'canvas-embed-add';
        button.dataset.embedAdd = JSON.stringify(path);
        container.append(button);
      });
    preview
      .querySelectorAll<HTMLElement>('[data-embed-field]')
      .forEach((field) => {
        const path: JsonPath = JSON.parse(field.dataset.embedField!);
        const position = Number(path.pop());
        const tools = this.doc.createElement('span');
        tools.className = 'canvas-embed-field-tools';
        for (const [label, direction] of [
          ['Move field up', -1],
          ['Move field down', 1],
          ['Remove field', 0],
        ] as const) {
          const button = this.button(
            direction === -1 ? '↑' : direction === 1 ? '↓' : '×',
            () =>
              change(path, (fields) => {
                if (!direction) fields.splice(position, 1);
                else if (
                  position + direction >= 0 &&
                  position + direction < fields.length
                ) {
                  const [item] = fields.splice(position, 1);
                  fields.splice(position + direction, 0, item);
                }
              }),
          );
          button.title = label;
          button.setAttribute('aria-label', label);
          tools.append(button);
        }
        field.append(tools);
      });
  }
  private positionInspector() {
    if (this.inspector.hidden) return;
    const card = this.board.querySelector<HTMLElement>('[data-selected]');
    const target = this.inspectorAnchor?.isConnected
      ? this.inspectorAnchor
      : this.propertyTarget
        ? [...(card?.querySelectorAll<HTMLElement>('a,img,video') || [])].find(
            (element) =>
              element.getAttribute('href') === this.propertyTarget ||
              element.getAttribute('src') === this.propertyTarget,
          )
        : undefined;
    const anchor =
      target ||
      card?.querySelector<HTMLElement>('[data-canvas-preview]') ||
      card;
    const rect = anchor?.getBoundingClientRect();
    const viewportWidth = this.doc.defaultView?.innerWidth || 1000;
    const viewportHeight = this.doc.defaultView?.innerHeight || 800;
    const width = Math.min(380, viewportWidth - 32);
    const toolbarBottom =
      this.doc
        .querySelector<HTMLElement>('.inline-toolbar:not([hidden])')
        ?.getBoundingClientRect().bottom || 64;
    const minimumTop = toolbarBottom + 12;
    this.inspector.style.width = `${width}px`;
    this.inspector.style.left = `${Math.max(16, Math.min(rect?.left || 16, viewportWidth - width - 16))}px`;
    const height = Math.min(
      this.inspector.scrollHeight || 320,
      viewportHeight - minimumTop - 16,
    );
    const below = (rect?.bottom || minimumTop) + 8;
    const above = (rect?.top || minimumTop) - height - 8;
    const preferred =
      below + height <= viewportHeight - 16
        ? below
        : above >= minimumTop
          ? above
          : (rect?.top || minimumTop) + 40;
    const top = Math.max(
      minimumTop,
      Math.min(preferred, viewportHeight - height - 16),
    );
    this.inspector.style.top = `${top}px`;
    this.inspector.style.maxHeight = `${Math.max(80, viewportHeight - top - 16)}px`;
    // Keep the popover attached to its item instead of leaving a detached panel onscreen.
    this.inspector.style.visibility =
      rect && (rect.bottom < minimumTop || rect.top > viewportHeight)
        ? 'hidden'
        : 'visible';
  }
  private editFragmentLink(target: HTMLElement, fragment: EditSession) {
    const state = this.text;
    if (!state || !state.editor.finish()) return;
    const fields = [
      ['Link label', target.dataset.editRef],
      ['Link URL', target.dataset.editUrl],
    ].filter((item) => item[1]);
    if (!fields.length) {
      this.announce('Use advanced source for this generated link.');
      return;
    }
    this.inspectorAnchor = target;
    this.inspector.replaceChildren();
    this.inspector.hidden = false;
    this.propertiesOpen = true;
    const form = this.doc.createElement('form');
    for (const [label, id] of fields) {
      const wrapper = this.doc.createElement('label');
      wrapper.textContent = label!;
      const input = this.doc.createElement('input');
      input.type = label === 'Link URL' ? 'url' : 'text';
      input.value = fragment.value(id!);
      input.dataset.fragmentLink = id!;
      input.setAttribute('aria-label', label!);
      input.addEventListener('input', () => {
        this.propertiesDirty = true;
      });
      wrapper.append(input);
      form.append(wrapper);
    }
    const apply = this.doc.createElement('button');
    apply.type = 'submit';
    apply.textContent = 'Apply';
    form.append(apply);
    const close = () => {
      this.propertiesDirty = false;
      this.propertiesOpen = false;
      state.editor.dispose();
      this.text = undefined;
      this.render();
    };
    form.append(this.button('Cancel', close));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        fragment.setChanges(
          [
            ...form.querySelectorAll<HTMLInputElement>('[data-fragment-link]'),
          ].map((input) => ({
            entryId: input.dataset.fragmentLink!,
            replacement: input.value,
          })),
        );
        const replacement = state.path
          ? patchJsonProperty(
              state.block.source,
              state.path,
              fragment.content(),
            )
          : fragment.content();
        this.apply(replaceCanvasBlock(state.base, state.block, replacement));
        close();
        this.announce('Link updated.');
      } catch (error) {
        this.error(error);
      }
    });
    this.inspector.append(form);
    this.positionInspector();
    form
      .querySelector<HTMLInputElement>('input')
      ?.focus({ preventScroll: true });
  }
  private async editText(
    index: number,
    point?: { x: number; y: number },
    path?: JsonPath,
  ) {
    if (!this.canLeaveProperties()) return;
    if (this.text && this.selected === index) return;
    if (!this.finishText()) return;
    const message = !path ? this.currentMessage(index) : undefined;
    const wholeMessage =
      !!message &&
      message.blocks.every((block) =>
        ['text', 'heading', 'list', 'settings', 'source'].includes(block.kind),
      );
    if (wholeMessage)
      index = this.blocks.findIndex(
        (block) => block.start >= message!.start && block.end <= message!.end,
      );
    if (!this.select(index, false)) return;
    index = this.selected;
    this.render();
    this.select(index, false);
    const block = wholeMessage ? message! : this.blocks[index];
    if (!block) return;
    const generation = ++this.generation;
    try {
      let fragment = block;
      if (path) {
        const mapping = jsonSource(block.source);
        if (
          block.node?.type !== 'embed' ||
          JSON.stringify(mapping.value) !== JSON.stringify(block.node.value)
        )
          throw new Error('Use advanced source for this embed');
        const value = mapping.tokens.get(JSON.stringify(path))?.value;
        if (typeof value !== 'string')
          throw new Error('This field requires advanced source editing');
        fragment = {
          ...block,
          source: value,
          kind: 'text',
          start: 0,
          end: value.length,
        };
      }
      const { session, article } = await canvasTextSession(
        this.doc,
        fragment,
        this.session.loaded.previewLinks,
      );
      if (generation !== this.generation || !this.root.isConnected) return;
      const card = this.board.querySelectorAll<HTMLElement>(
        '[data-canvas-block]',
      )[index];
      if (path) {
        const target = [
          ...card.querySelectorAll<HTMLElement>('[data-embed-text]'),
        ].find((element) => element.dataset.embedText === JSON.stringify(path));
        if (!target) throw new Error('Select this embed text again');
        target.replaceChildren(article);
      } else if (wholeMessage) {
        card
          .closest('[data-canvas-message]')!
          .querySelector('[data-message-content]')!
          .replaceChildren(article);
      } else card.querySelector('[data-canvas-preview]')!.replaceWith(article);
      updateDraftPreview(this.doc, session, true);
      const editor = new RichLineEditor(
        this.doc,
        () => session,
        () => {
          if (this.restoring || !this.text) return;
          try {
            const content = replaceCanvasBlock(
              this.text.base,
              this.text.block,
              this.text.path
                ? patchJsonProperty(
                    this.text.block.source,
                    this.text.path,
                    session.content(),
                  )
                : session.content(),
            );
            const record = content !== this.source && !this.text.recorded;
            this.apply(content, false);
            if (record) {
              this.undoStack.push(this.text.base);
              this.redoStack = [];
              this.text.recorded = true;
            }
            if (content === this.text.base && this.text.recorded) {
              if (this.undoStack.at(-1) === this.text.base)
                this.undoStack.pop();
              this.redoStack = this.text.redoBefore;
              this.text.recorded = false;
            }
            this.updateHistory();
            updateDraftPreview(this.doc, session, true);
            if (!this.text.editor.isActive) {
              const finished = this.text;
              queueMicrotask(() => {
                if (
                  this.text !== finished ||
                  finished.editor.isActive ||
                  !this.root.isConnected
                )
                  return;
                finished.editor.dispose();
                this.text = undefined;
                this.generation++;
                this.render();
              });
            }
          } catch (error) {
            this.error(error);
            return false;
          }
        },
        (target) => this.editFragmentLink(target, session),
      );
      this.text = {
        editor,
        session,
        block,
        base: this.source,
        recorded: false,
        path,
        redoBefore: [...this.redoStack],
      };
      article.addEventListener('click', (event) => {
        // This fragment owns its text and toolbar interactions. In embeds the
        // preview ancestor would otherwise commit and reopen it on mouseup,
        // replacing the selected DOM before formatting can use the range.
        event.stopPropagation();
        if (
          (event.target as Element).closest(
            '[data-line-done],[data-line-cancel]',
          ) &&
          path
        ) {
          if (this.finishText()) this.render();
          return;
        }
        const target = event.target as Element;
        if (target.closest('a')) {
          event.preventDefault();
          event.stopPropagation();
          const link = target.closest<HTMLElement>('a')!;
          if (link.dataset.createdLink) {
            editor.editCreatedLink(link);
            return;
          }
          if (!editor.finish()) return;
          this.editFragmentLink(link, session);
          return;
        }

        if (
          target.closest(
            '.inline-line-input,.line-formatting,.line-edit-hint,.line-edit-error',
          )
        )
          return;
        const wrapper = target.closest<HTMLElement>('[data-source-line]');
        if (wrapper) {
          event.preventDefault();
          editor.begin(wrapper, {
            x: (event as MouseEvent).clientX,
            y: (event as MouseEvent).clientY,
          });
        }
      });
      const first = article.querySelector<HTMLElement>('[data-source-line]');
      if (first)
        editor.begin(
          first,
          point,
          wholeMessage
            ? article.querySelector<HTMLElement>('.canvas-block-preview')!
            : undefined,
        );
      else {
        editor.dispose();
        this.text = undefined;
        this.announce('Edit this section using its source or properties.');
      }
    } catch (error) {
      this.error(error);
    }
  }
}
