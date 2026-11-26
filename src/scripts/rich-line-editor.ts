import type { EditSession, PendingChange } from '../lib/edit-session';
import type { InlineNode } from '@pvme/guide-parser';
import { inlineTokenFromId, newLinkToken } from '../lib/rich-token';
import {
  linkSelection,
  selectionMarkState,
  selectionTokenIds,
  toggleSelectionMark,
} from '../lib/rich-selection';
import {
  normalizeRichLine,
  shiftBulletPrefix,
  bulletLevel,
  bulletPrefixes,
  isBulletPrefix,
  canToggleBullet,
  type LineMark,
  type RichLine,
  type RichPart,
  type SourceLine,
  type LineToken,
} from '../lib/source-lines';

const markTags: Record<LineMark, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strikethrough: 'del',
  spoiler: 'span',
};
const tagMarks: Record<string, LineMark> = {
  STRONG: 'bold',
  B: 'bold',
  EM: 'italic',
  I: 'italic',
  U: 'underline',
  DEL: 'strikethrough',
  S: 'strikethrough',
};
interface LineView {
  line: SourceLine;
  original: Node[];
  tokens: Map<string, Node>;
}
const views = new WeakMap<HTMLElement, LineView>();

const selector = '[data-edit-ref], [data-edit-url]';

function tokenFallback(doc: Document, token: LineToken): Node {
  const node = token.node;
  if (node.type === 'emoji' && node.id) {
    const image = doc.createElement('img');
    image.className = 'emoji';
    image.src = `https://cdn.discordapp.com/emojis/${node.id}.${node.animated ? 'gif' : 'png'}?size=48`;
    image.alt = `:${node.name}:`;
    image.width = 24;
    image.height = 24;
    return image;
  }
  if (node.type === 'link') {
    const label = (nodes: typeof node.children): string =>
      nodes
        .map((child): string =>
          child.type === 'text' || child.type === 'inline-code'
            ? child.value
            : 'children' in child
              ? label(child.children)
              : '',
        )
        .join('');
    if (token.id.startsWith('new-link:')) {
      const link = doc.createElement('a');
      link.href = node.url;
      link.dataset.createdLink = token.id;
      const renderLabel = (
        nodes: typeof node.children,
        parent: HTMLElement,
      ) => {
        for (const child of nodes) {
          if (child.type === 'text')
            parent.append(doc.createTextNode(child.value));
          else if ('children' in child && child.type in markTags) {
            const element = doc.createElement(markTags[child.type as LineMark]);
            if (child.type === 'spoiler') element.className = 'spoiler';
            renderLabel(child.children, element);
            parent.append(element);
          }
        }
      };
      renderLabel(node.children, link);
      return link;
    }
    return doc.createTextNode(label(node.children));
  }
  return doc.createTextNode(
    node.type === 'reference' || node.type === 'mention' ? '' : token.raw,
  );
}

function attachTargets(article: HTMLElement, session: EditSession) {
  const doc = article.ownerDocument;
  for (const host of article.querySelectorAll<HTMLElement>(
    '[data-empty-source-line]',
  )) {
    if (host.querySelector('[data-source-line]')) continue;
    const line = session.lines.find(
      (line) =>
        !line.raw &&
        line.range.start.offset === Number(host.dataset.emptySourceLine),
    );
    if (!line) continue;
    const wrapper = doc.createElement('span');
    wrapper.dataset.sourceLine = line.id;
    const original = [...host.childNodes].map((node) => node.cloneNode(true));
    wrapper.append(...host.childNodes);
    host.append(wrapper);
    views.set(wrapper, { line, original, tokens: new Map() });
  }
  const byEntry = new Map(
    session.lines.flatMap((line) =>
      line.entryIds.map((id) => [id, line] as const),
    ),
  );
  const hosts = new Set(
    [...article.querySelectorAll<HTMLElement>(selector)]
      .filter((node) => !node.closest('[data-source-line]'))
      .map((node) => node.closest<HTMLElement>('p,h2,h3,h4,h5,h6'))
      .filter((node): node is HTMLElement => !!node),
  );
  for (const host of hosts) {
    if (
      (host.closest('.guide-embed') && !host.closest('.canvas-text-surface')) ||
      host.closest('.preset-preview-card,.media-preview-card,.ability-bar') ||
      host.querySelector(
        'img:not(.emoji),video,iframe,.mechanic-title,.mechanic-examples',
      )
    )
      continue;
    const groups: Node[][] = [[]];
    for (const child of [...host.childNodes]) {
      if (
        child.nodeType === 1 &&
        (child as Element).matches('.heading-permalink')
      )
        continue;
      if (child.nodeType === 1 && (child as Element).tagName === 'BR')
        groups.push([]);
      else groups.at(-1)!.push(child);
    }
    for (const group of groups) {
      const ids = new Set<SourceLine>();
      for (const node of group) {
        if (node.nodeType !== 1) continue;
        const element = node as HTMLElement;
        for (const target of [
          element,
          ...element.querySelectorAll<HTMLElement>(selector),
        ]) {
          const line = byEntry.get(
            target.dataset.editRef || target.dataset.editUrl || '',
          );
          if (line) ids.add(line);
        }
      }
      if (ids.size !== 1 || !group.length) continue;
      const line = [...ids][0];
      const wrapper = doc.createElement('span');
      wrapper.dataset.sourceLine = line.id;
      host.insertBefore(wrapper, group[0]);
      group.forEach((child) => wrapper.append(child));
      const candidates = [
        ...wrapper.querySelectorAll<HTMLElement>(
          'a,img.emoji,code,time,.spacer',
        ),
      ].filter((element) => !element.parentElement?.closest('a,code,time'));
      const used = new Set<Node>();
      const tokens = new Map<string, Node>();
      for (const token of line.tokens) {
        const node = token.node,
          type = node.type;
        const mapped =
          node.type === 'link'
            ? candidates.find(
                (element) =>
                  node.urlRange &&
                  element.dataset.editUrl ===
                    `link-url-${node.urlRange.start.offset}-${node.urlRange.end.offset}`,
              )
            : undefined;
        const candidate =
          mapped ||
          candidates.find(
            (element) =>
              !used.has(element) &&
              (type === 'link'
                ? element.tagName === 'A' &&
                  node.type === 'link' &&
                  (/^https?:\/\//.test(node.url) || node.destination.length > 0)
                : node.type === 'mention'
                  ? node.kind === 'channel' && element.tagName === 'A'
                  : node.type === 'reference'
                    ? node.kind === 'tag' &&
                      element.tagName === 'A' &&
                      ((element.getAttribute('href') || '') ===
                        `#${node.target}` ||
                        (element.getAttribute('href') || '').endsWith(
                          `--${node.target}`,
                        ))
                    : type === 'emoji'
                      ? element.tagName === 'IMG' &&
                        node.type === 'emoji' &&
                        !!node.id &&
                        (element.getAttribute('src') || '').includes(
                          `/${node.id}.`,
                        )
                      : type === 'inline-code'
                        ? element.tagName === 'CODE'
                        : type === 'timestamp'
                          ? element.tagName === 'TIME'
                          : type === 'spacer'
                            ? element.classList.contains('spacer')
                            : false),
          );
        if (candidate) used.add(candidate);
        tokens.set(
          token.id,
          candidate?.cloneNode(true) || tokenFallback(doc, token),
        );
      }
      views.set(wrapper, {
        line,
        original: [...wrapper.childNodes].map((node) => node.cloneNode(true)),
        tokens,
      });
    }
  }
}

function tokenElement(
  doc: Document,
  view: LineView,
  token: LineToken,
  session: EditSession,
  editing: boolean,
): Node {
  const original =
    view.tokens.get(token.id)?.cloneNode(true) || tokenFallback(doc, token);
  const node = token.node;
  if (node.type === 'link' && original.nodeType === 1) {
    const element = original as HTMLElement;
    const label = element.dataset.editRef,
      url = element.dataset.editUrl;
    if (label) element.textContent = session.value(label);
    if (url) {
      element.setAttribute('href', session.value(url));
      if (session.isBareUrl(url)) element.textContent = session.value(url);
    }
  }
  if (!editing) return original;
  const chip = doc.createElement('span');
  chip.dataset.lineToken = token.id;
  chip.contentEditable = 'false';
  chip.className = 'line-protected-token';
  chip.title =
    node.type === 'link'
      ? 'Link · click to edit supported fields'
      : 'Protected source content';
  chip.append(original);
  if (!chip.textContent && !chip.querySelector('img'))
    chip.append(doc.createTextNode(`${node.type} (read-only)`));
  return chip;
}

/** Empty text/style nodes do not provide a usable browser caret line. */
export function ensureEditableRow(row: HTMLElement) {
  if (row.textContent || row.querySelector('[data-line-token]')) return;
  row.replaceChildren();
  const placeholder = row.ownerDocument.createElement('br');
  placeholder.dataset.linePlaceholder = '';
  row.append(placeholder);
}

function fillModel(
  root: HTMLElement,
  model: RichLine,
  view: LineView,
  session: EditSession,
  editing: boolean,
) {
  const doc = root.ownerDocument;
  root.replaceChildren();
  model.forEach((parts, index) => {
    const row = doc.createElement('span');
    row.dataset.richRow = '';
    row.dataset.lineOwner = view.line.id;
    row.dataset.bulletPrefix = session.linePrefixes(view.line.id, model.length)[
      index
    ];
    row.dataset.rowBullet = String(isBulletPrefix(row.dataset.bulletPrefix));
    const originalIndent = view.line.prefix.match(/^[ \t]*/)?.[0].length || 0;
    const indent = row.dataset.bulletPrefix.match(/^[ \t]*/)?.[0].length || 0;
    row.style.marginInlineStart = `${indent - originalIndent}ch`;
    if (
      isBulletPrefix(row.dataset.bulletPrefix) &&
      (index || !view.line.bullet)
    )
      row.dataset.continuationBullet = row.dataset.bulletPrefix.trim();
    for (const part of parts) {
      let leaf: Node =
        part.type === 'text'
          ? doc.createTextNode(part.text)
          : tokenElement(
              doc,
              view,
              (view.line.tokens.find((token) => token.id === part.id) ||
                inlineTokenFromId(part.id))!,
              session,
              editing,
            );
      for (const mark of [...part.marks].reverse()) {
        const wrapper = doc.createElement(markTags[mark]);
        if (mark === 'spoiler') wrapper.dataset.lineMark = 'spoiler';
        if (mark === 'spoiler' && !editing) {
          wrapper.className = 'spoiler';
          wrapper.tabIndex = 0;
        }
        wrapper.append(leaf);
        leaf = wrapper;
      }
      row.append(leaf);
    }
    if (editing) ensureEditableRow(row);
    root.append(row);
  });
}

function listMembers(
  list: HTMLElement,
): { wrapper: HTMLElement; view: LineView }[] | undefined {
  const candidates = [
    ...list.querySelectorAll<HTMLElement>('[data-source-line]'),
  ].map((wrapper) => ({ wrapper, view: views.get(wrapper)! }));
  const remainder = list.cloneNode(true) as HTMLElement;
  remainder
    .querySelectorAll('[data-source-line]')
    .forEach((node) => node.remove());
  return candidates.length &&
    candidates.every(({ view }) => view?.line.bullet) &&
    candidates.length === list.querySelectorAll('li').length &&
    !remainder.textContent?.trim() &&
    !remainder.querySelector('img,pre,code,video,iframe,table')
    ? candidates
    : undefined;
}

export function syncSourceLines(
  doc: Document,
  session: EditSession,
  editing: boolean,
) {
  for (const article of doc.querySelectorAll<HTMLElement>(
    'article[data-guide-source]',
  )) {
    if (
      article.dataset.guideSource !== session.path ||
      article.dataset.guideSourceHash !== session.sourceHash
    )
      continue;
    if (!editing)
      article
        .querySelectorAll('[data-inline-bullet-hidden]')
        .forEach((li) => li.removeAttribute('data-inline-bullet-hidden'));
    if (editing) attachTargets(article, session);
    for (const wrapper of article.querySelectorAll<HTMLElement>(
      '[data-source-line]',
    )) {
      const view = views.get(wrapper);
      if (!view || wrapper.dataset.lineEditing) continue;
      if (!editing) {
        wrapper.replaceWith(
          ...view.original.map((node) => node.cloneNode(true)),
        );
        continue;
      }
      wrapper.tabIndex = 0;
      if (view.line.bullet)
        wrapper
          .closest('li')
          ?.toggleAttribute(
            'data-inline-bullet-hidden',
            !isBulletPrefix(session.linePrefixes(view.line.id)[0]),
          );
      wrapper.setAttribute('role', 'group');
      if (session.isLineChanged(view.line.id))
        fillModel(
          wrapper,
          session.lineModel(view.line.id),
          view,
          session,
          false,
        );
      else if (wrapper.querySelector('[data-rich-row]'))
        wrapper.replaceChildren(
          ...view.original.map((node) => node.cloneNode(true)),
        );
      wrapper.toggleAttribute(
        'data-edit-modified',
        session.isLineChanged(view.line.id),
      );
      wrapper.toggleAttribute(
        'data-multiline-draft',
        session.lineModel(view.line.id).length > 1,
      );
      wrapper.setAttribute(
        'aria-label',
        `Edit line ${view.line.range.startLine}: ${wrapper.textContent?.slice(0, 100) || ''}`,
      );
    }
    for (const list of article.querySelectorAll<HTMLElement>('ul,ol')) {
      if (list.parentElement?.closest('ul,ol')) continue;
      const members = listMembers(list);
      // Use exactly the same eligibility check as begin(), so the affordance
      // covers the section that clicking it will actually open.
      list.toggleAttribute('data-edit-chunk', editing && !!members);
      const preview =
        editing &&
        members?.some(({ view }) => session.isLineChanged(view.line.id));
      list.toggleAttribute('data-list-draft-preview', !!preview);
      if (!preview || list.hasAttribute('data-inline-list-hidden')) continue;
      for (const { wrapper, view } of members!) {
        fillModel(
          wrapper,
          session.lineModel(view.line.id),
          view,
          session,
          false,
        );
        for (const row of wrapper.querySelectorAll<HTMLElement>(
          '[data-rich-row]',
        )) {
          if (isBulletPrefix(row.dataset.bulletPrefix || ''))
            row.dataset.continuationBullet = row.dataset.bulletPrefix!.trim();
          else delete row.dataset.continuationBullet;
          row.style.marginInlineStart = `${row.dataset.bulletPrefix?.match(/^[ \t]*/)?.[0].length || 0}ch`;
        }
      }
    }
  }
}

/** Reads only a tiny controlled vocabulary; pasted HTML never supplies source syntax. */
export function readEditorModel(root: ParentNode): RichLine {
  const read = (parent: ParentNode, marks: LineMark[] = []): RichPart[] =>
    [...parent.childNodes].flatMap((node): RichPart[] => {
      if (node.nodeType === 3)
        return [{ type: 'text', text: node.textContent || '', marks }];
      if (node.nodeType !== 1) return [];
      const element = node as HTMLElement;
      if (element.dataset.lineToken)
        return [{ type: 'token', id: element.dataset.lineToken, marks }];
      if (element.tagName === 'BR') {
        if (element.hasAttribute('data-line-placeholder')) return [];
        throw new Error('Use Enter to create a continuation bullet');
      }
      const mark =
        tagMarks[element.tagName] ||
        (element.dataset.lineMark === 'spoiler' ? 'spoiler' : undefined);
      if (
        !['SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'DEL', 'S'].includes(
          element.tagName,
        )
      )
        throw new Error(
          'Unsupported pasted content. Paste plain text instead.',
        );
      return read(element, mark ? [...marks, mark] : marks);
    });
  const rows = [...root.childNodes].filter(
    (node) =>
      node.nodeType === 1 &&
      (node as HTMLElement).hasAttribute('data-rich-row'),
  );
  if (
    rows.length &&
    [...root.childNodes].some(
      (node) =>
        !rows.includes(node) && (node.nodeType === 1 || !!node.textContent),
    )
  )
    throw new Error('Content must remain inside its editable line');
  return normalizeRichLine(
    rows.length ? rows.map((row) => read(row as HTMLElement)) : [read(root)],
  );
}

const length = (model: RichLine) =>
  model.reduce(
    (total, row) =>
      total +
      row.reduce(
        (sum, part) => sum + (part.type === 'text' ? part.text.length : 1),
        0,
      ),
    model.length - 1,
  );

export class RichLineEditor {
  private bulletPromotions = new WeakMap<
    HTMLElement,
    { parent: HTMLElement; original: string; promoted: string }
  >();
  private onSelectionChange: () => void;
  private onOutsidePointer = (event: Event) => {
    const active = this.active;
    if (!active) return;
    for (const popup of active.wrapper.querySelectorAll<HTMLElement>(
      '[data-link-create],[data-link-picker]',
    )) {
      if (
        popup.contains(event.target as Node) ||
        active.wrapper
          .querySelector('[data-format-link]')
          ?.contains(event.target as Node)
      )
        continue;
      popup.remove();
      active.wrapper
        .querySelector('[data-format-link]')
        ?.setAttribute('aria-expanded', 'false');
    }
  };
  private active?: {
    wrapper: HTMLElement;
    root: HTMLElement;
    error: HTMLElement;
    view: LineView;
    members: { wrapper: HTMLElement; view: LineView }[];
    list?: HTMLElement;
    initial: PendingChange[];
    selection?: Range;
    linkSelection?: { start: number; end: number };
  };
  constructor(
    private doc: Document,
    private getSession: () => EditSession | undefined,
    private changed: () => void | boolean,
    private editLink?: (target: HTMLElement) => void,
  ) {
    this.onSelectionChange = () => {
      const selection = doc.defaultView?.getSelection?.();
      if (
        this.active &&
        selection?.rangeCount &&
        this.active.root.contains(selection.anchorNode)
      ) {
        this.active.selection = selection.getRangeAt(0).cloneRange();
        this.updateFormattingState();
      }
    };
    doc.addEventListener('selectionchange', this.onSelectionChange);
    doc.addEventListener('pointerdown', this.onOutsidePointer, true);
  }
  dispose() {
    this.doc.removeEventListener('selectionchange', this.onSelectionChange);
    this.doc.removeEventListener('pointerdown', this.onOutsidePointer, true);
  }
  get isActive() {
    return !!this.active;
  }
  get root() {
    return this.active?.root;
  }
  begin(
    wrapper: HTMLElement,
    point?: { x: number; y: number },
    message?: HTMLElement,
  ) {
    if (this.active?.members.some((member) => member.wrapper === wrapper))
      return;
    if (!this.finish()) return;
    const session = this.getSession(),
      view = views.get(wrapper);
    if (!session || !view) return;
    const doc = this.doc;
    let list = view.line.bullet ? wrapper.closest<HTMLElement>('ul,ol') : null;
    while (list?.parentElement?.closest('ul,ol'))
      list = list.parentElement.closest<HTMLElement>('ul,ol');
    let members = [{ wrapper, view }];
    if (list) {
      const candidates = listMembers(list);
      if (candidates) members = candidates;
      else list = null;
    }
    if (message) {
      members = [...message.querySelectorAll<HTMLElement>('[data-source-line]')]
        .map((wrapper) => ({ wrapper, view: views.get(wrapper)! }))
        .filter((member) => !!member.view);
      // Reuse the chunk lifecycle: hide the rendered message while one rich
      // editor owns all its source-backed text rows, including child bullets.
      list = message;
    }
    const targetLine = view.line.id;
    if (list) {
      const container = doc.createElement('div');
      container.dataset.listChunkEditor = '';
      list.before(container);
      list.dataset.inlineListHidden = '';
      wrapper = container;
    }
    const root = doc.createElement('span');
    root.className = 'inline-line-input';
    root.contentEditable = 'true';
    root.setAttribute('role', 'textbox');
    root.setAttribute(
      'aria-multiline',
      message || view.line.kind === 'paragraph' ? 'true' : 'false',
    );
    root.setAttribute(
      'aria-label',
      message
        ? 'Edit message'
        : list
          ? 'Edit bullet list and its children'
          : `Edit whole ${view.line.bullet ? 'bullet' : 'line'} ${view.line.range.startLine}`,
    );
    for (const member of members) {
      const segment = doc.createElement('span');
      fillModel(
        segment,
        session.lineModel(member.view.line.id),
        member.view,
        session,
        true,
      );
      root.append(...segment.childNodes);
      member.wrapper.dataset.lineEditing = 'true';
    }
    const tools = doc.createElement('span');
    tools.className = 'line-formatting';
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', 'Line formatting');
    const error = doc.createElement('span');
    error.className = 'line-edit-error';
    error.setAttribute('role', 'alert');
    this.active = {
      wrapper,
      root,
      error,
      view,
      members,
      list: list || undefined,
      initial: session.changes,
    };
    this.decorateRows();
    for (const [mark, label] of [
      ['bold', 'Bold'],
      ['italic', 'Italic'],
      ['underline', 'Underline'],
      ['strikethrough', 'Strikethrough'],
    ] as const) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = {
        bold: 'B',
        italic: 'I',
        underline: 'U',
        strikethrough: 'S',
        spoiler: '◩',
      }[mark];
      button.title =
        label +
        (['bold', 'italic', 'underline'].includes(mark)
          ? ' (Ctrl+' + label[0] + ')'
          : '');
      button.dataset.formatMark = mark;
      button.setAttribute('aria-label', `Toggle ${label.toLowerCase()}`);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('pointerdown', (event) => event.preventDefault());
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => this.format(mark));
      tools.append(button);
    }
    const link = doc.createElement('button');
    link.type = 'button';
    link.textContent = '🔗';
    link.dataset.formatLink = '';
    link.title = 'Add or edit link (Ctrl+K)';
    link.setAttribute('aria-label', 'Add or edit link');
    link.setAttribute('aria-pressed', 'false');
    link.setAttribute('aria-expanded', 'false');
    link.setAttribute('aria-keyshortcuts', 'Control+k Meta+k');
    link.addEventListener('pointerdown', (event) => event.preventDefault());
    link.addEventListener('mousedown', (event) => event.preventDefault());
    link.addEventListener('click', () => this.link());
    tools.append(link);
    if (members.some((member) => canToggleBullet(member.view.line))) {
      const bullet = doc.createElement('button');
      bullet.type = 'button';
      const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '18');
      icon.setAttribute('height', '18');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      for (const y of [6, 12, 18]) {
        const dot = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', '4');
        dot.setAttribute('cy', String(y));
        dot.setAttribute('r', '1.5');
        dot.setAttribute('fill', 'currentColor');
        const line = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', `M9 ${y}h12`);
        line.setAttribute('stroke', 'currentColor');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-linecap', 'round');
        icon.append(dot, line);
      }
      bullet.append(icon);
      bullet.title = 'Toggle bullet list';
      bullet.dataset.formatBullet = '';
      bullet.setAttribute('aria-label', 'Toggle bullet list');
      bullet.setAttribute(
        'aria-pressed',
        String(isBulletPrefix(session.linePrefixes(view.line.id)[0])),
      );
      bullet.addEventListener('pointerdown', (event) => event.preventDefault());
      bullet.addEventListener('mousedown', (event) => event.preventDefault());
      bullet.addEventListener('click', () => this.toggleBullet());
      tools.append(bullet);
      for (const [outdent, label] of [
        [false, 'Indent'],
        [true, 'Outdent'],
      ] as const) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = outdent ? '⇤' : '⇥';
        button.setAttribute('aria-label', label);
        button.dataset.bulletIndent = outdent ? 'out' : 'in';
        button.title = `${label} bullet (${outdent ? 'Shift+Tab' : 'Tab'})`;
        button.addEventListener('pointerdown', (event) =>
          event.preventDefault(),
        );
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', () => this.indent(outdent));
        tools.append(button);
      }
    }
    const done = doc.createElement('button');
    done.type = 'button';
    done.textContent = '✓';
    done.title = 'Done (Ctrl+Enter)';
    done.setAttribute('aria-label', 'Done');
    done.dataset.lineDone = '';
    done.addEventListener('click', () => this.finish());
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '×';
    cancel.title = 'Cancel (Escape)';
    cancel.setAttribute('aria-label', 'Cancel');
    cancel.dataset.lineCancel = '';
    cancel.addEventListener('click', () => this.cancel());
    tools.append(done, cancel);
    const hint = doc.createElement('span');
    hint.className = 'line-edit-hint';
    hint.textContent =
      view.line.kind === 'paragraph'
        ? 'Enter starts a new line · Bullets toggles list formatting · Tab / Shift+Tab changes bullet level · Ctrl+Enter finishes · Escape cancels'
        : 'Ctrl+Enter finishes · Escape cancels';
    wrapper.dataset.lineEditing = 'true';
    wrapper.removeAttribute('role');
    wrapper.removeAttribute('tabindex');
    tools.title = hint.textContent;
    wrapper.replaceChildren(tools, root, error);
    this.updateBulletState();
    root.addEventListener('input', (event) => {
      if (!(event as InputEvent).isComposing) this.commit();
    });
    root.addEventListener('compositionend', () => this.commit());
    root.addEventListener('keydown', (event) => {
      if (
        event.key === 'Tab' &&
        this.selectedRows().some((row) =>
          isBulletPrefix(row.dataset.bulletPrefix || ''),
        ) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.indent(event.shiftKey);
      } else if (
        ['Backspace', 'Delete'].includes(event.key) &&
        !(event as KeyboardEvent).isComposing &&
        this.deleteEmptyLine(event.key === 'Delete')
      ) {
        event.preventDefault();
        event.stopPropagation();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        if (
          event.ctrlKey ||
          event.metaKey ||
          this.currentLine()?.kind !== 'paragraph'
        )
          this.finish();
        else this.newLine();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'k'
      ) {
        event.preventDefault();
        this.link();
      } else if (
        (event.ctrlKey || event.metaKey) &&
        ['b', 'i', 'u'].includes(event.key.toLowerCase())
      ) {
        event.preventDefault();
        this.format(
          ({ b: 'bold', i: 'italic', u: 'underline' } as const)[
            event.key.toLowerCase() as 'b'
          ],
        );
      }
    });
    root.addEventListener('beforeinput', (event) => {
      const input = event as InputEvent;
      if (
        !input.isComposing &&
        ['deleteContentBackward', 'deleteContentForward'].includes(
          input.inputType,
        ) &&
        this.deleteEmptyLine(input.inputType === 'deleteContentForward')
      ) {
        event.preventDefault();
        return;
      }
      if (!input.isComposing && input.inputType.startsWith('delete')) {
        const range = this.range();
        if (range) {
          const row = this.rowAt(range.startContainer);
          const crossesRows = row !== this.rowAt(range.endContainer);
          const removesToken =
            !range.collapsed &&
            [...root.querySelectorAll('[data-line-token]')].some((token) =>
              range.intersectsNode(token),
            );
          if (crossesRows || removesToken) {
            event.preventDefault();
            this.showMessage(
              'Keep original bullets and protected objects; edit their text or indentation instead.',
            );
            return;
          }
          if (range.collapsed && row && view.line.kind === 'paragraph') {
            const edge = range.cloneRange();
            edge.selectNodeContents(row);
            if (input.inputType.endsWith('Backward'))
              edge.setEnd(range.startContainer, range.startOffset);
            else edge.setStart(range.endContainer, range.endOffset);
            if (!length(readEditorModel(edge.cloneContents()))) {
              event.preventDefault();
              if (
                input.inputType.endsWith('Backward') &&
                isBulletPrefix(row.dataset.bulletPrefix || '')
              ) {
                if (/^[ \t]+/.test(row.dataset.bulletPrefix || ''))
                  this.indent(true);
                else this.toggleBullet();
              }
              return;
            }
          }
        }
      }
      if (
        input.inputType === 'insertText' &&
        input.data !== null &&
        !input.isComposing
      ) {
        event.preventDefault();
        this.insertText(input.data);
        return;
      }
      if (
        ['insertParagraph', 'insertLineBreak'].includes(
          (event as InputEvent).inputType,
        )
      ) {
        event.preventDefault();
        if (this.currentLine()?.kind === 'paragraph') this.newLine();
        else this.finish();
      }
    });
    root.addEventListener('paste', (event) => {
      event.preventDefault();
      const value = event.clipboardData?.getData('text/plain') || '';
      this.insertText(value);
    });
    root.addEventListener('drop', (event) => {
      event.preventDefault();
      this.insertText(event.dataTransfer?.getData('text/plain') || '');
    });
    root.focus({ preventScroll: true });
    const position =
      point &&
      (
        doc as Document & {
          caretPositionFromPoint?: (
            x: number,
            y: number,
          ) => { offsetNode: Node; offset: number } | null;
        }
      ).caretPositionFromPoint?.(point.x, point.y);
    const caret = position ? doc.createRange() : undefined;
    if (caret && position) {
      caret.setStart(position.offsetNode, position.offset);
      caret.collapse(true);
    }
    if (
      caret &&
      root.contains(caret.startContainer) &&
      !this.tokenAncestor(caret.startContainer)
    )
      this.select(caret);
    else
      this.selectPoint(
        [...root.querySelectorAll<HTMLElement>('[data-rich-row]')].find(
          (row) => row.dataset.lineOwner === targetLine,
        ) || root,
        0,
      );
  }
  private tokenAncestor(node: Node) {
    return (
      node.nodeType === 1 ? (node as Element) : node.parentElement
    )?.closest('[data-line-token]');
  }
  private select(range: Range) {
    const selection = this.doc.defaultView?.getSelection?.();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (this.active) this.active.selection = range.cloneRange();
    this.updateFormattingState();
  }
  private selectPoint(node: Node, offset: number) {
    if (!this.doc.defaultView?.getSelection) return;
    const range = this.doc.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    this.select(range);
  }
  private restoreSelection(start: number, end: number) {
    const root = this.active?.root;
    if (!root || !this.doc.defaultView?.getSelection) return;
    const pointAt = (offset: number): { node: Node; offset: number } => {
      let position = 0;
      const visit = (
        node: Node,
      ): { node: Node; offset: number } | undefined => {
        if (node.nodeType === 3) {
          const size = node.textContent?.length || 0;
          if (offset <= position + size)
            return { node, offset: Math.max(0, offset - position) };
          position += size;
          return;
        }
        if (node.nodeType === 1 && (node as HTMLElement).dataset.lineToken) {
          const index = [...node.parentNode!.childNodes].indexOf(
            node as ChildNode,
          );
          if (offset <= position + 1)
            return {
              node: node.parentNode!,
              offset: index + (offset > position ? 1 : 0),
            };
          position++;
          return;
        }
        for (const child of node.childNodes) {
          const point = visit(child);
          if (point) return point;
        }
      };
      const rows = [...root.children];
      for (const [index, row] of rows.entries()) {
        if (index) position++;
        if (offset === position) return { node: row, offset: 0 };
        const point = visit(row);
        if (point) return point;
      }
      const last = rows.at(-1) || root;
      return { node: last, offset: last.childNodes.length };
    };
    const a = pointAt(start),
      b = pointAt(end),
      range = this.doc.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    this.select(range);
  }
  private range(): Range | undefined {
    const active = this.active,
      selection = this.doc.defaultView?.getSelection?.();
    const range = selection?.rangeCount
      ? selection.getRangeAt(0)
      : active?.selection;
    return range && active?.root.contains(range.commonAncestorContainer)
      ? range
      : active?.selection;
  }
  private rowAt(node: Node): HTMLElement | null {
    return (
      (node.nodeType === 1
        ? (node as Element)
        : node.parentElement
      )?.closest<HTMLElement>('[data-rich-row]') || null
    );
  }
  private currentLine() {
    const active = this.active;
    if (!active) return;
    const row = this.selectedRows()[0];
    return (
      active.members.find(
        (member) => member.view.line.id === row?.dataset.lineOwner,
      )?.view.line || active.view.line
    );
  }
  private decorateRows() {
    const active = this.active;
    if (!active) return;
    for (const row of active.root.querySelectorAll<HTMLElement>(
      '[data-rich-row]',
    )) {
      const prefix = row.dataset.bulletPrefix ?? active.view.line.prefix;
      const owner = active.members.find(
        (member) => member.view.line.id === row.dataset.lineOwner,
      )?.view.line;
      if (owner) row.dataset.lineKind = owner.kind;
      row.dataset.rowBullet = String(isBulletPrefix(prefix));
      if (!isBulletPrefix(prefix)) delete row.dataset.continuationBullet;
      else if (active.list || !active.view.line.bullet)
        row.dataset.continuationBullet = prefix.trim();
      if (active.list)
        row.style.marginInlineStart = `${prefix.match(/^[ \t]*/)?.[0].length || 0}ch`;
      else {
        const member =
          active.members.find(
            (member) => member.view.line.id === row.dataset.lineOwner,
          ) || active.members[0];
        row.style.marginInlineStart = `${(prefix.match(/^[ \t]*/)?.[0].length || 0) - (member.view.line.prefix.match(/^[ \t]*/)?.[0].length || 0)}ch`;
      }
    }
    this.updateBulletState();
  }
  private selectedRows(): HTMLElement[] {
    const active = this.active;
    if (!active) return [];
    const rows = [
      ...active.root.querySelectorAll<HTMLElement>('[data-rich-row]'),
    ];
    const range = this.range();
    if (!range) return rows.slice(0, 1);
    const start = rows.indexOf(this.rowAt(range.startContainer)!);
    let end = rows.indexOf(this.rowAt(range.endContainer)!);
    if (
      end > start &&
      range.endOffset === 0 &&
      (range.endContainer === rows[end] ||
        range.endContainer === rows[end].firstChild)
    )
      end--;
    return start < 0 || end < start ? [] : rows.slice(start, end + 1);
  }
  private updateBulletState() {
    const active = this.active;
    if (!active) return;
    const rows = this.selectedRows(),
      states = rows.map((row) =>
        isBulletPrefix(row.dataset.bulletPrefix || ''),
      );
    const state =
      states.length && states.every(Boolean)
        ? 'true'
        : states.some(Boolean)
          ? 'mixed'
          : 'false';
    active.wrapper
      .querySelector('[data-format-bullet]')
      ?.setAttribute('aria-pressed', state);
    const bullet = active.wrapper.querySelector<HTMLButtonElement>(
      '[data-format-bullet]',
    );
    if (bullet)
      bullet.disabled =
        !rows.length ||
        rows.some((row) => {
          const line = active.members.find(
            (member) => member.view.line.id === row.dataset.lineOwner,
          )?.view.line;
          return !line || !canToggleBullet(line);
        });
    for (const button of active.wrapper.querySelectorAll<HTMLButtonElement>(
      '[data-bullet-indent]',
    ))
      button.disabled =
        state !== 'true' ||
        !this.indentRows(button.dataset.bulletIndent === 'out').length;
  }
  toggleBullet() {
    const active = this.active;
    if (!active) return;
    const rows = this.selectedRows();
    if (
      !rows.length ||
      rows.some((row) => {
        const line = active.members.find(
          (member) => member.view.line.id === row.dataset.lineOwner,
        )?.view.line;
        return !line || !canToggleBullet(line);
      })
    )
      return;
    const remove = rows.every((row) =>
      isBulletPrefix(row.dataset.bulletPrefix || ''),
    );
    const allRows = [
      ...active.root.querySelectorAll<HTMLElement>('[data-rich-row]'),
    ];
    const before = allRows.map((row) => row.dataset.bulletPrefix ?? '');
    rows.forEach((row) => {
      const member =
        active.members.find(
          (member) => member.view.line.id === row.dataset.lineOwner,
        ) || active.members[0];
      if (remove) {
        row.dataset.savedBulletPrefix = row.dataset.bulletPrefix;
        row.dataset.bulletPrefix = '';
      } else if (!isBulletPrefix(row.dataset.bulletPrefix || ''))
        row.dataset.bulletPrefix =
          bulletPrefixes[
            Math.min(
              2,
              bulletLevel(
                row.dataset.savedBulletPrefix ||
                  (member.view.line.bullet ? member.view.line.prefix : '⬥ '),
              ),
            )
          ];
    });
    if (remove) {
      const removedLevels: { row: HTMLElement; level: number }[] = [];
      allRows.forEach((row, index) => {
        if (!isBulletPrefix(before[index])) {
          removedLevels.length = 0;
          return;
        }
        const level = bulletLevel(before[index]);
        while (removedLevels.length && removedLevels.at(-1)!.level >= level)
          removedLevels.pop();
        if (rows.includes(row)) removedLevels.push({ row, level });
        else if (removedLevels.length) {
          const promoted =
            bulletPrefixes[Math.max(0, level - removedLevels.length)];
          this.bulletPromotions.set(row, {
            parent: removedLevels.at(-1)!.row,
            original: before[index],
            promoted,
          });
          row.dataset.bulletPrefix = promoted;
        }
      });
    }
    if (!remove)
      allRows.forEach((row) => {
        const promotion = this.bulletPromotions.get(row);
        if (
          promotion &&
          rows.includes(promotion.parent) &&
          row.dataset.bulletPrefix === promotion.promoted
        ) {
          row.dataset.bulletPrefix = promotion.original;
          this.bulletPromotions.delete(row);
        }
      });
    if (!this.commit())
      allRows.forEach((row, index) => {
        row.dataset.bulletPrefix = before[index];
      });
    this.decorateRows();
    const range = this.range();
    active.root.focus({ preventScroll: true });
    if (range) this.select(range);
  }
  private applyEditorModel(model: RichLine) {
    const active = this.active!,
      session = this.getSession()!;
    const rows = [
      ...active.root.querySelectorAll<HTMLElement>('[data-rich-row]'),
    ];
    if (rows.length !== model.length)
      throw new Error('Keep each bullet on its own row');
    let index = 0;
    const changes: PendingChange[] = [];
    for (const member of active.members) {
      const parts: RichLine = [],
        prefixes: string[] = [];
      while (
        index < rows.length &&
        (rows[index].dataset.lineOwner || active.view.line.id) ===
          member.view.line.id
      ) {
        parts.push(model[index]);
        prefixes.push(
          rows[index].dataset.bulletPrefix ?? member.view.line.prefix,
        );
        index++;
      }
      changes.push(session.lineChange(member.view.line.id, parts, prefixes));
    }
    if (index !== rows.length)
      throw new Error('Keep message lines in their original order');
    session.setChanges(changes);
  }
  private refill() {
    const active = this.active!,
      session = this.getSession()!;
    active.root.replaceChildren();
    for (const member of active.members) {
      const segment = this.doc.createElement('span');
      fillModel(
        segment,
        session.lineModel(member.view.line.id),
        member.view,
        session,
        true,
      );
      active.root.append(...segment.childNodes);
    }
    this.decorateRows();
  }
  private indentRows(outdent: boolean): HTMLElement[] {
    const active = this.active;
    const selected = this.selectedRows();
    if (
      !active ||
      !selected.length ||
      selected.some((row) => !isBulletPrefix(row.dataset.bulletPrefix || ''))
    )
      return [];
    const rows = [
      ...active.root.querySelectorAll<HTMLElement>('[data-rich-row]'),
    ];
    const first = rows.indexOf(selected[0]);
    let last = rows.indexOf(selected.at(-1)!);
    const depth = (row: HTMLElement) =>
      bulletLevel(row.dataset.bulletPrefix || '');
    const parentDepth = Math.min(...selected.map(depth));
    while (
      last + 1 < rows.length &&
      isBulletPrefix(rows[last + 1].dataset.bulletPrefix || '') &&
      depth(rows[last + 1]) > parentDepth
    )
      last++;
    const affected = rows.slice(first, last + 1);
    if (outdent) return parentDepth > 0 ? affected : [];
    // A bullet nests under an earlier sibling; the first item cannot indent.
    const previous = rows[first - 1];
    if (
      !previous ||
      !isBulletPrefix(previous.dataset.bulletPrefix || '') ||
      depth(previous) < depth(rows[first]) ||
      affected.some((row) => depth(row) >= 2)
    )
      return [];
    return affected;
  }
  indent(outdent = false) {
    const active = this.active;
    if (!active) return;
    const range = this.range();
    const rows = this.indentRows(outdent);
    if (!rows.length) {
      this.updateBulletState();
      return;
    }
    const previous = rows.map((row) => row.dataset.bulletPrefix);
    rows.forEach((row) => {
      row.dataset.bulletPrefix = shiftBulletPrefix(
        row.dataset.bulletPrefix || '',
        outdent,
      );
    });
    if (!this.commit())
      rows.forEach((row, index) => {
        row.dataset.bulletPrefix = previous[index];
      });
    this.decorateRows();
    active.root.focus({ preventScroll: true });
    if (range) this.select(range);
  }
  private insertText(value: string) {
    const active = this.active,
      range = this.range();
    if (!active || !range) return;
    if (this.rowAt(range.startContainer) !== this.rowAt(range.endContainer)) {
      this.showMessage(
        'Replace text within one bullet at a time; formatting can span the whole list.',
      );
      return;
    }
    if (
      this.tokenAncestor(range.startContainer) ||
      this.tokenAncestor(range.endContainer)
    )
      return;
    if (
      !range.collapsed &&
      [...active.root.querySelectorAll('[data-line-token]')].some((token) =>
        range.intersectsNode(token),
      )
    ) {
      active.error.textContent =
        'Protected objects cannot be replaced. Select the text beside them instead.';
      return;
    }
    const rows = value.split(/\r\n|\r|\n/);
    if (this.currentLine()?.kind !== 'paragraph') {
      rows.splice(0, rows.length, rows.join(' '));
    }
    rows.forEach((text, index) => {
      if (index) this.newLine(false);
      const current = this.range();
      if (!current) return;
      current.deleteContents();
      const node = this.doc.createTextNode(text);
      current.insertNode(node);
      if (text)
        node.parentElement
          ?.closest('[data-rich-row]')
          ?.querySelectorAll('[data-line-placeholder]')
          .forEach((placeholder) => placeholder.remove());
      this.selectPoint(node, text.length);
    });
    active.root.dispatchEvent(
      new this.doc.defaultView!.Event('input', { bubbles: true }),
    );
  }
  private deleteEmptyLine(forward = false): boolean {
    const active = this.active,
      range = this.range();
    if (!active || !range?.collapsed) return false;
    const row = this.rowAt(range.startContainer);
    if (
      !row ||
      this.active?.members.find(
        (member) => member.view.line.id === row.dataset.lineOwner,
      )?.view.line.kind !== 'paragraph' ||
      row.textContent ||
      row.querySelector('[data-line-token]')
    )
      return false;
    const previous = row.previousElementSibling as HTMLElement | null;
    const next = row.nextElementSibling as HTMLElement | null;
    row.remove();
    if (!this.commit()) {
      if (next) next.before(row);
      else active.root.append(row);
      return true;
    }
    this.decorateRows();
    const target = forward ? next || previous : previous || next;
    if (target) {
      active.root.focus({ preventScroll: true });
      this.selectPoint(
        target,
        target === previous ? target.childNodes.length : 0,
      );
    } else this.finish();
    return true;
  }
  newLine(exitEmptyBullet = true) {
    const active = this.active,
      range = this.range();
    if (!active || !range || this.currentLine()?.kind !== 'paragraph') return;
    if (
      this.tokenAncestor(range.startContainer) ||
      this.tokenAncestor(range.endContainer)
    )
      return;
    const row = (
      range.startContainer.nodeType === 1
        ? (range.startContainer as Element)
        : range.startContainer.parentElement
    )?.closest<HTMLElement>('[data-rich-row]');
    if (!row || !active.root.contains(row)) return;
    if (this.rowAt(range.endContainer) !== row) return;
    if (
      exitEmptyBullet &&
      !row.textContent &&
      !row.querySelector('[data-line-token]') &&
      isBulletPrefix(row.dataset.bulletPrefix || '')
    ) {
      row.dataset.savedBulletPrefix = row.dataset.bulletPrefix;
      row.dataset.bulletPrefix = '';
      this.commit();
      this.decorateRows();
      return;
    }
    // Do not let a range spanning protected objects delete or duplicate their source tokens.
    if (
      !range.collapsed &&
      [...active.root.querySelectorAll('[data-line-token]')].some((token) =>
        range.intersectsNode(token),
      )
    ) {
      active.error.textContent =
        'Protected content cannot be removed. Move the caret beside it to continue the bullet.';
      return;
    }
    range.deleteContents();
    const tail = range.cloneRange();
    tail.setEnd(row, row.childNodes.length);
    const next = this.doc.createElement('span');
    next.dataset.richRow = '';
    next.dataset.lineOwner = row.dataset.lineOwner || active.view.line.id;
    next.dataset.bulletPrefix =
      row.dataset.bulletPrefix ?? active.view.line.prefix;
    next.dataset.continuationBullet = next.dataset.bulletPrefix.trim();
    next.style.marginInlineStart = row.style.marginInlineStart;
    next.append(tail.extractContents());
    row.after(next);
    this.decorateRows();
    ensureEditableRow(next);
    this.commit();
    active.root.focus({ preventScroll: true });
    this.selectPoint(next, 0);
  }
  private updateFormattingState() {
    this.updateBulletState();
    const active = this.active,
      range = this.range();
    if (!active || !range) return;
    try {
      const start = this.offset(range),
        end = this.offset(range, true),
        model = readEditorModel(active.root);
      for (const button of active.wrapper.querySelectorAll<HTMLButtonElement>(
        '[data-format-mark]',
      ))
        button.setAttribute(
          'aria-pressed',
          selectionMarkState(
            model,
            start,
            end,
            button.dataset.formatMark as LineMark,
          ),
        );
      active.wrapper
        .querySelector('[data-format-link]')
        ?.setAttribute('aria-pressed', String(this.selectedLinks().length > 0));
    } catch {
      /* An in-progress native selection may not yet lie inside a row. */
    }
  }
  private selectedLinks(): HTMLElement[] {
    const active = this.active,
      range = this.range();
    if (!active || !range) return [];
    const ids = selectionTokenIds(
      readEditorModel(active.root),
      this.offset(range),
      this.offset(range, true),
    );
    return [...active.root.querySelectorAll<HTMLElement>('[data-line-token]')]
      .filter((chip) => ids.includes(chip.dataset.lineToken!))
      .flatMap((chip) => [...chip.querySelectorAll<HTMLElement>('a')]);
  }
  editCreatedLink(target: HTMLElement) {
    if (!target.dataset.createdLink) return;
    this.active?.wrapper.querySelector('[data-link-create]')?.remove();
    this.linkForm(target.dataset.createdLink);
  }
  private linkForm(existingId?: string) {
    const active = this.active;
    if (!active) return;
    active.wrapper.querySelector('[data-link-create]')?.remove();
    const model = readEditorModel(active.root);
    const snapshot = JSON.stringify(model);
    const range = this.range();
    const start = range ? this.offset(range) : 0,
      end = range ? this.offset(range, true) : 0;
    if (!existingId && start === end) {
      this.showMessage('Select the text to link first.');
      return;
    }
    const token = existingId ? inlineTokenFromId(existingId) : undefined;
    const form = this.doc.createElement('form');
    form.className = 'line-link-picker line-link-form';
    form.dataset.linkCreate = '';
    const label = this.doc.createElement('label');
    label.textContent = 'Link URL';
    const input = this.doc.createElement('input');
    input.type = 'url';
    input.required = true;
    input.setAttribute('aria-label', 'Link URL');
    input.placeholder = 'https://example.com';
    input.value = token?.node.type === 'link' ? token.node.url : '';
    label.append(input);
    const textOf = (nodes: InlineNode[]): string =>
      nodes
        .map((node) =>
          'children' in node
            ? textOf(node.children)
            : 'value' in node
              ? node.value
              : node.raw,
        )
        .join('');
    const originalText =
      token?.node.type === 'link'
        ? textOf(token.node.children)
        : model
            .map((row) =>
              row
                .map((part) => (part.type === 'text' ? part.text : '\uFFFC'))
                .join(''),
            )
            .join('\n')
            .slice(start, end)
            .trim();
    const displayLabel = this.doc.createElement('label');
    displayLabel.textContent = 'Display text';
    const display = this.doc.createElement('input');
    display.type = 'text';
    display.setAttribute('aria-label', 'Display text');
    display.value = originalText;
    displayLabel.append(display);
    const save = this.doc.createElement('button');
    save.type = 'submit';
    save.textContent = existingId ? 'Save link' : 'Add link';
    const cancel = this.doc.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const error = this.doc.createElement('span');
    error.setAttribute('role', 'alert');
    const close = () => {
      form.remove();
      active.wrapper
        .querySelector('[data-format-link]')
        ?.setAttribute('aria-expanded', 'false');
      active.root.focus({ preventScroll: true });
      this.restoreSelection(start, end);
    };
    cancel.addEventListener('click', close);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        if (
          this.active !== active ||
          JSON.stringify(readEditorModel(active.root)) !== snapshot
        )
          throw new Error(
            'The text changed. Select it again before adding a link.',
          );
        let updated: RichLine;
        if (token?.node.type === 'link') {
          const node = token.node;
          const labelText = display.value.trim() ? display.value : originalText;
          const rawLabel =
            labelText === originalText
              ? token.raw.slice(
                  node.labelRange!.start.offset,
                  node.labelRange!.end.offset,
                )
              : labelText.replace(/[\\[\]<>*_~`|]/g, '\\$&');
          const replacement = newLinkToken(
            `[${rawLabel}](<${input.value.trim()}>)`,
          );
          if (!replacement) throw new Error('Enter a valid http or https URL.');
          updated = model.map((row) =>
            row.map((part) =>
              part.type === 'token' && part.id === existingId
                ? { ...part, id: replacement.id }
                : part,
            ),
          );
        } else
          updated = linkSelection(
            model,
            start,
            end,
            input.value,
            display.value,
          );
        this.applyEditorModel(updated);
        this.refill();
        form.remove();
        active.wrapper
          .querySelector('[data-format-link]')
          ?.setAttribute('aria-expanded', 'false');
        active.root.focus({ preventScroll: true });
        active.error.textContent = '';
        this.changed();
      } catch (failure) {
        error.textContent =
          failure instanceof Error ? failure.message : 'Unable to add link';
      }
    });
    form.append(label, displayLabel, save, cancel, error);
    active.wrapper.querySelector('.line-formatting')!.append(form);
    active.wrapper
      .querySelector('[data-format-link]')
      ?.setAttribute('aria-expanded', 'true');
    input.focus();
  }
  link() {
    const active = this.active;
    if (!active) return;
    try {
      const range = this.range();
      if (range && !range.collapsed && !this.selectedLinks().length) {
        active.wrapper.querySelector('[data-link-create]')?.remove();
        this.linkForm();
        return;
      }
      const selected = this.selectedLinks();
      const links = selected.length
        ? selected
        : [...active.root.querySelectorAll<HTMLElement>('a')];
      const picker = active.wrapper.querySelector('[data-link-picker]');
      picker?.remove();
      const button =
        active.wrapper.querySelector<HTMLElement>('[data-format-link]')!;
      button.setAttribute('aria-expanded', 'false');
      const open = (target: HTMLElement) => {
        if (target.dataset.createdLink) {
          this.linkForm(target.dataset.createdLink);
          return;
        }
        if (
          !target.dataset.editRef &&
          !target.dataset.editUrl &&
          !(this.editLink && target.dataset.canvasChannelIndex !== undefined)
        ) {
          this.showMessage('This link is read-only in inline editing.');
          return;
        }
        if (this.suspendForLink()) this.editLink?.(target);
      };
      if (links.length === 1) {
        open(links[0]);
        return;
      }
      if (!links.length) {
        this.showMessage('Select the text to link first.');
        return;
      }
      // Multiple links remain easy to reach without requiring precise chip selection.
      if (picker) return;
      const choices = this.doc.createElement('span');
      choices.dataset.linkPicker = '';
      choices.className = 'line-link-picker';
      choices.setAttribute('role', 'group');
      choices.setAttribute('aria-label', 'Choose a link to edit');
      choices.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          choices.remove();
          button.setAttribute('aria-expanded', 'false');
          button.focus();
        }
      });
      for (const target of links) {
        const choice = this.doc.createElement('button');
        choice.type = 'button';
        choice.textContent =
          target.textContent || target.getAttribute('href') || 'Link';
        choice.addEventListener('click', (event) => {
          event.stopPropagation();
          choices.remove();
          button.setAttribute('aria-expanded', 'false');
          open(target);
        });
        choices.append(choice);
      }
      active.wrapper.querySelector('.line-formatting')!.append(choices);
      button.setAttribute('aria-expanded', 'true');
      choices.querySelector('button')?.focus();
    } catch (error) {
      this.showMessage(
        error instanceof Error ? error.message : 'Unable to edit link',
      );
    }
  }
  private offset(range: Range, end = false) {
    const prefix = this.doc.createRange();
    prefix.selectNodeContents(this.active!.root);
    prefix.setEnd(
      end ? range.endContainer : range.startContainer,
      end ? range.endOffset : range.startOffset,
    );
    return length(readEditorModel(prefix.cloneContents()));
  }
  format(mark: LineMark) {
    const active = this.active,
      session = this.getSession(),
      range = this.range();
    if (!active || !session || !range) return;
    if (range.collapsed) {
      active.error.textContent = 'Select the text you want to format first.';
      return;
    }
    try {
      const start = this.offset(range),
        end = this.offset(range, true),
        model = readEditorModel(active.root);
      const formatted = toggleSelectionMark(model, start, end, mark);
      this.applyEditorModel(formatted);
      this.refill();
      active.error.textContent = '';
      active.root.focus({ preventScroll: true });
      this.restoreSelection(start, end);
      this.changed();
    } catch (error) {
      active.error.textContent =
        error instanceof Error ? error.message : 'Unable to apply formatting';
    }
  }
  suspendForLink(): boolean {
    if (!this.active || !this.commit()) return false;
    const range = this.range();
    if (range)
      try {
        this.active.linkSelection = {
          start: this.offset(range),
          end: this.offset(range, true),
        };
      } catch {
        /* Focus may already be on the protected link. */
      }
    return true;
  }
  resumeAfterLink() {
    const active = this.active,
      session = this.getSession();
    if (!active || !session) return;
    for (const chip of active.root.querySelectorAll<HTMLElement>(
      '[data-line-token]',
    )) {
      const view = active.members.find((member) =>
        member.view.line.tokens.some(
          (token) => token.id === chip.dataset.lineToken,
        ),
      )?.view;
      const token = view?.line.tokens.find(
        (token) => token.id === chip.dataset.lineToken,
      );
      if (!token) continue;
      const replacement = tokenElement(this.doc, view!, token, session, true);
      chip.replaceChildren(...replacement.childNodes);
    }
    active.root.focus({ preventScroll: true });
    if (active.linkSelection)
      this.restoreSelection(
        active.linkSelection.start,
        active.linkSelection.end,
      );
    else
      this.selectPoint(
        active.root.querySelector('[data-rich-row]') || active.root,
        0,
      );
    delete active.linkSelection;
  }
  showMessage(message: string) {
    if (this.active) this.active.error.textContent = message;
  }
  commit(): boolean {
    const active = this.active,
      session = this.getSession();
    if (!active || !session) return true;
    try {
      this.applyEditorModel(
        active.root.querySelector('[data-rich-row]')
          ? readEditorModel(active.root)
          : [],
      );
      active.wrapper.toggleAttribute(
        'data-edit-modified',
        session.isLineChanged(active.view.line.id),
      );
      active.error.textContent = '';
      if (this.changed() === false)
        throw new Error(
          'This edit could not be saved. Correct the highlighted source issue or cancel the edit.',
        );
      return true;
    } catch (error) {
      active.error.textContent =
        error instanceof Error ? error.message : 'Invalid line edit';
      return false;
    }
  }
  finish(): boolean {
    const active = this.active;
    if (!active) return true;
    if (!this.commit()) {
      active.root.focus({ preventScroll: true });
      return false;
    }
    this.release();
    this.active = undefined;
    this.changed();
    return true;
  }
  cancel() {
    const active = this.active,
      session = this.getSession();
    if (!active || !session) return;
    session.replaceChanges(active.initial);
    this.release();
    this.active = undefined;
    this.changed();
    active.members[0].wrapper.focus();
  }
  private release() {
    const active = this.active!;
    delete active.wrapper.dataset.lineEditing;
    for (const member of active.members)
      delete member.wrapper.dataset.lineEditing;
    if (active.list) {
      delete active.list.dataset.inlineListHidden;
      active.wrapper.remove();
    }
  }
}
