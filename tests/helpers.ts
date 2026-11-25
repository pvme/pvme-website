import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { parseHTML } from 'linkedom';
import { renderGuide } from '../src/lib/renderer';
import { EditSession } from '../src/lib/edit-session';
import type { DraftStore } from '../src/lib/draft-storage';
import type { LoadedGuideSource } from '../src/lib/guide-source-provider';
import { RichLineEditor } from '../src/scripts/rich-line-editor';
import { updateDraftPreview } from '../src/scripts/inline-preview';

export const renderTestGuide = (source: string, path = 'test.txt') =>
  renderGuide(
    source,
    { methods: [], sections: [] },
    '',
    {},
    { sourcePath: path },
  );

export const testSource = (
  source: string,
  path = 'test.txt',
  name = 'Test',
): LoadedGuideSource => ({
  path,
  originalText: source,
  name,
  repo: 'pvme/pvme-guides',
  baseBranch: 'master',
  source: 'master',
  branch: 'master',
});

export async function createTestGuide(source: string, path = 'test.txt') {
  const rendered = renderTestGuide(source, path);
  return {
    source,
    rendered,
    session: await EditSession.create(
      rendered.sourceMap,
      testSource(source, path),
    ),
  };
}

export class MemoryStore implements DraftStore {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

export const settle = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 20));

export function click(document: Document, selector: string) {
  const element = document.querySelector(selector);
  assert.ok(element, selector);
  return element.dispatchEvent(
    new document.defaultView!.Event('click', {
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function submit(document: Document, selector: string) {
  const form = document.querySelector(selector);
  assert.ok(form, selector);
  return form.dispatchEvent(
    new document.defaultView!.Event('submit', {
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function openRichEditor(fixture: {
  session: EditSession;
  rendered: { html: string };
}) {
  const session = fixture.session;
  const { document, window } = parseHTML(
    `<article data-guide-source="${session.path}" data-guide-source-hash="${session.sourceHash}">${fixture.rendered.html}</article>`,
  );
  const refresh = () => updateDraftPreview(document, session, true);
  refresh();
  const editor = new RichLineEditor(document, () => session, refresh);
  editor.begin(document.querySelector('[data-source-line]')!);
  const root = editor.root!;
  return {
    document,
    window,
    refresh,
    editor,
    root,
    rows: [...root.querySelectorAll<HTMLElement>('[data-rich-row]')],
  };
}

interface SelectionRange {
  startContainer: Node;
  endContainer: Node;
  commonAncestorContainer: Node;
  startOffset: number;
  endOffset: number;
  collapsed: boolean;
  cloneRange(): unknown;
}

/** Linkedom has no native selection API; restore mocks to avoid cross-test leaks. */
export function mockSelection(
  t: TestContext,
  document: Document,
  range: SelectionRange,
  caret = false,
) {
  const window = document.defaultView!;
  const selection = Object.getOwnPropertyDescriptor(window, 'getSelection');
  const createRange = Object.getOwnPropertyDescriptor(document, 'createRange');
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    value: () => ({
      rangeCount: 1,
      get anchorNode() {
        return range.startContainer;
      },
      getRangeAt: () => range,
      removeAllRanges() {},
      addRange() {},
    }),
  });
  if (caret)
    Object.defineProperty(document, 'createRange', {
      configurable: true,
      value: () => ({
        ...range,
        setStart(node: Node, offset: number) {
          this.startContainer =
            this.endContainer =
            range.startContainer =
            range.endContainer =
              node;
          this.startOffset =
            this.endOffset =
            range.startOffset =
            range.endOffset =
              offset;
        },
        collapse() {},
      }),
    });
  t.after(() => {
    if (selection) Object.defineProperty(window, 'getSelection', selection);
    else Reflect.deleteProperty(window, 'getSelection');
    if (caret) {
      if (createRange)
        Object.defineProperty(document, 'createRange', createRange);
      else Reflect.deleteProperty(document, 'createRange');
    }
  });
}

export const mappedSource =
  '# Guide\r\n**old** <:magic:123> *inside*\r\n⬥ parent\r\n    • child\r\n[old label](<https://example.com/a_(b)> "keep")\r\nhttps://example.com/bare\r\n$linkmsg_missing$';
export const renderMappedGuide = (
  source = mappedSource,
  path = 'test/guide.txt',
) => renderTestGuide(source, path);
export const loadMappedGuide = (
  source = mappedSource,
  path = 'test/guide.txt',
) => testSource(source, path, 'Test guide');
export const createMappedSession = (source = mappedSource) =>
  EditSession.create(
    renderMappedGuide(source).sourceMap,
    loadMappedGuide(source),
  );
export const findEntry = (session: EditSession, value: string, kind = 'text') =>
  session.map.entries.find(
    (entry) => entry.value === value && entry.kind === kind,
  )!;
