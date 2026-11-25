import {
  emojiSnapshot,
  emojiCatalogueUrl,
  emojiCatalogue,
  emojiMatches,
  emojiQuery,
  emojiSource,
  emojiImage,
  type EmojiCompletion,
} from '../lib/emoji-autocomplete';
import { newEmojiToken } from '../lib/emoji-token';

type TextField = HTMLInputElement | HTMLTextAreaElement;
interface Context {
  target: HTMLElement;
  match: NonNullable<ReturnType<typeof emojiQuery>>;
  before: string;
  range?: Range;
}

/** One delegated autocomplete covers dynamically created message and embed editors. */
export class EmojiAutocomplete {
  private catalogue = emojiSnapshot;
  private popup?: HTMLElement;
  private context?: Context;
  private matches: EmojiCompletion[] = [];
  private selected = 0;
  private applying = false;
  private dismissed = '';
  private dismissedTarget?: HTMLElement;
  private serial = 0;
  constructor(
    private doc: Document,
    catalogue?: EmojiCompletion[],
  ) {
    if (catalogue) this.catalogue = catalogue;
    doc.addEventListener('input', this.onInput, true);
    doc.addEventListener('compositionend', this.onInput, true);
    doc.addEventListener('compositionstart', () => this.close(), true);
    doc.addEventListener('selectionchange', () => {
      const target = this.context?.target;
      if (target) this.update(target);
    });
    doc.addEventListener('keydown', this.onKey, true);
    doc.addEventListener(
      'pointerdown',
      (event) => {
        if (
          this.popup &&
          !this.popup.contains(event.target as Node) &&
          !this.context?.target.contains(event.target as Node)
        )
          this.close(true);
      },
      true,
    );
    doc.addEventListener('focusin', (event) => {
      if (
        this.context &&
        event.target !== this.context.target &&
        !this.context.target.contains(event.target as Node)
      )
        this.close(true);
    });
    doc.defaultView?.addEventListener('scroll', () => this.position(), true);
    doc.defaultView?.addEventListener('resize', () => this.position());
  }
  async refresh() {
    try {
      const response = await this.doc.defaultView?.fetch?.(emojiCatalogueUrl, {
        credentials: 'omit',
      });
      if (!response?.ok) return;
      const catalogue = emojiCatalogue(await response.json());
      if (catalogue.length) this.catalogue = catalogue;
    } catch {
      /* The bundled snapshot keeps completion usable offline. */
    }
  }
  private target(node: EventTarget | null) {
    const element = node as HTMLElement | null;
    const target = element?.closest?.<HTMLElement>(
      '.inline-line-input,textarea,input:not([type]),input[type="text"]',
    );
    if (
      !target?.closest('[data-page-canvas],.inline-dialog') ||
      target.closest('[hidden]')
    )
      return;
    return target;
  }
  private onInput = (event: Event) => {
    if (this.applying || (event as InputEvent).isComposing) return;
    this.dismissedTarget = undefined;
    const target = this.target(event.target);
    if (target) this.update(target);
    else this.close();
  };
  private read(target: HTMLElement): Context | undefined {
    if (!target.isConnected) return;
    if (target.matches('input,textarea')) {
      const input = target as TextField;
      if (
        input.selectionStart === null ||
        input.selectionStart !== input.selectionEnd
      )
        return;
      const before = input.value.slice(0, input.selectionStart);
      const match = emojiQuery(before);
      return match ? { target, before, match } : undefined;
    }
    const selection = this.doc.defaultView?.getSelection?.();
    if (!selection?.rangeCount) return;
    const caret = selection.getRangeAt(0);
    if (!caret.collapsed || !target.contains(caret.startContainer)) return;
    const node = caret.startContainer;
    if (
      node.nodeType !== 3 ||
      node.parentElement?.closest('[data-line-token],code')
    )
      return;
    const row = node.parentElement?.closest('[data-rich-row]');
    if (!row) return;
    const nodes: Node[] = [];
    const visit = (parent: Node) => {
      for (const child of parent.childNodes) {
        if (
          child.nodeType === 3 ||
          (child.nodeType === 1 &&
            (child as HTMLElement).hasAttribute('data-line-token'))
        )
          nodes.push(child);
        else visit(child);
      }
    };
    visit(row);
    const current = nodes.indexOf(node);
    if (current < 0) return;
    const before =
      nodes
        .slice(0, current)
        .map((part) => (part.nodeType === 3 ? part.textContent : '\ufffc'))
        .join('') + node.textContent!.slice(0, caret.startOffset);
    const match = emojiQuery(before);
    if (!match) return;
    const range = caret.cloneRange();
    let remaining = match.to - match.from;
    for (let index = current; index >= 0; index--) {
      const part = nodes[index];
      if (part.nodeType !== 3) return;
      const size =
        index === current ? caret.startOffset : part.textContent!.length;
      if (remaining <= size) {
        range.setStart(part, size - remaining);
        break;
      }
      remaining -= size;
    }
    return { target, before, match, range };
  }
  private update(target: HTMLElement) {
    const context = this.read(target);
    if (
      !context ||
      (target === this.dismissedTarget && context.before === this.dismissed)
    )
      return this.close();
    const matches = emojiMatches(
      this.catalogue,
      context.match.query,
      context.match.closed,
    );
    if (!matches.length) return this.close();
    const same =
      this.context?.target === target &&
      this.context.match.query === context.match.query;
    this.context = context;
    this.matches = matches;
    if (context.match.closed && matches.length === 1)
      return this.choose(matches[0]);
    this.selected = same ? Math.min(this.selected, matches.length - 1) : 0;
    this.render();
  }
  private render() {
    if (!this.context) return;
    this.popup?.remove();
    const popup = this.doc.createElement('div');
    popup.className = 'emoji-completions';
    popup.id = `emoji-completions-${++this.serial}`;
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', 'Emoji suggestions');
    for (const [index, emoji] of this.matches.entries()) {
      const option = this.doc.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.id = `${popup.id}-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === this.selected));
      const image = this.doc.createElement('img');
      image.src = emojiImage(emoji);
      image.alt = '';
      image.width = image.height = 24;
      option.append(image, this.doc.createTextNode(emoji.id));
      option.addEventListener('pointerdown', (event) => event.preventDefault());
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.choose(emoji);
      });
      popup.append(option);
    }
    (this.context.target.closest('dialog[open]') || this.doc.body).append(
      popup,
    );
    this.popup = popup;
    const target = this.context.target;
    target.setAttribute('aria-autocomplete', 'list');
    target.setAttribute('aria-expanded', 'true');
    target.setAttribute('aria-controls', popup.id);
    this.highlight();
    this.position();
  }
  private highlight() {
    const options = [
      ...(this.popup?.querySelectorAll<HTMLElement>('[role="option"]') || []),
    ];
    options.forEach((option, index) =>
      option.setAttribute('aria-selected', String(index === this.selected)),
    );
    const active = options[this.selected];
    if (active) {
      this.context?.target.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView?.({ block: 'nearest' });
    }
  }
  private position() {
    if (!this.popup || !this.context) return;
    if (
      !this.context.target.isConnected ||
      this.context.target.closest('[hidden]')
    )
      return this.close();
    const rect =
      this.context.range?.getBoundingClientRect?.() ||
      this.context.target.getBoundingClientRect();
    const width = this.doc.defaultView?.innerWidth || 1000;
    const height = this.doc.defaultView?.innerHeight || 800;
    const popupHeight = this.popup.getBoundingClientRect().height || 240;
    this.popup.style.left = `${Math.max(8, Math.min(rect.left, width - 292))}px`;
    this.popup.style.top = `${Math.max(8, rect.bottom + popupHeight + 6 > height ? rect.top - popupHeight - 6 : rect.bottom + 6)}px`;
  }
  private onKey = (event: KeyboardEvent) => {
    if (
      !this.popup ||
      !this.context ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (
      event.target !== this.context.target &&
      !this.context.target.contains(event.target as Node)
    )
      return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key))
      return;
    if (event.key === 'Tab' && event.shiftKey) return this.close(true);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') this.close(true);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      this.selected =
        (this.selected +
          (event.key === 'ArrowDown' ? 1 : -1) +
          this.matches.length) %
        this.matches.length;
      this.highlight();
    } else this.choose(this.matches[this.selected]);
  };
  private choose(emoji: EmojiCompletion) {
    const context = this.context;
    if (!context || !context.target.isConnected) return this.close();
    this.applying = true;
    try {
      const { target, match, range } = context;
      if (range) {
        const token = newEmojiToken(emojiSource(emoji));
        if (!token) return;
        const chip = this.doc.createElement('span');
        chip.dataset.lineToken = token.id;
        chip.className = 'line-protected-token';
        chip.contentEditable = 'false';
        const image = this.doc.createElement('img');
        image.className = 'emoji';
        image.src = emojiImage(emoji);
        image.alt = `:${emoji.id}:`;
        image.width = image.height = 24;
        chip.append(image);
        range.deleteContents();
        range.insertNode(chip);
        const after = this.doc.createTextNode('');
        chip.after(after);
        target.focus({ preventScroll: true });
        range.setStart(after, 0);
        range.collapse(true);
        const selection = this.doc.defaultView?.getSelection?.();
        selection?.removeAllRanges();
        selection?.addRange(range);
      } else {
        const input = target as TextField;
        const replacement = emojiSource(emoji);
        input.value =
          input.value.slice(0, match.from) +
          replacement +
          input.value.slice(match.to);
        input.setSelectionRange(
          match.from + replacement.length,
          match.from + replacement.length,
        );
      }
      this.close();
      target.dispatchEvent(
        new this.doc.defaultView!.Event('input', { bubbles: true }),
      );
    } finally {
      this.applying = false;
    }
  }
  private close(dismiss = false) {
    if (dismiss && this.context) {
      this.dismissed = this.context.before;
      this.dismissedTarget = this.context.target;
    }
    if (this.context)
      for (const attr of [
        'aria-autocomplete',
        'aria-expanded',
        'aria-controls',
        'aria-activedescendant',
      ])
        this.context.target.removeAttribute(attr);
    this.popup?.remove();
    this.popup = undefined;
    this.context = undefined;
  }
}
