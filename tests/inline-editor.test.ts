import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { serializeSourceMap } from '../src/lib/source-map';
import { DraftStorage } from '../src/lib/draft-storage';
import { EditSession } from '../src/lib/edit-session';
import {
  initializeInlineEditor,
  type InlineEditorOptions,
} from '../src/scripts/inline-editor';
import { updateDraftPreview } from '../src/scripts/inline-preview';
import {
  mappedSource as source,
  renderMappedGuide as render,
  loadMappedGuide as loaded,
  createMappedSession as create,
  findEntry as entry,
  MemoryStore,
  settle,
  click,
  submit,
  mockSelection,
} from './helpers';

const component = (path: string) =>
  readFileSync(path, 'utf8').replace(/^---[\s\S]*?---/, '');
function fixture(
  storage = new MemoryStore(),
  text = source,
  pageCanvas = false,
  viewport?: { matches: boolean; mobile?: boolean; changed?: () => void },
  overrides: Partial<InlineEditorOptions> = {},
) {
  const rendered = render(text),
    map = rendered.sourceMap!;
  const article = (path = map.path) =>
    `<div class="reader-layout"><button data-inline-edit-path="${path}" data-inline-edit-title="Test guide">Edit</button><article data-guide-source="${path}" data-guide-source-hash="${map.sourceHash}">${rendered.html}<script data-guide-source-map type="application/json">${serializeSourceMap({ ...map, path })}</script></article></div>`;
  const markup = component('src/components/InlineEditor.astro')
    .replace(/<link\b[^>]*>/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace(
      '<ReviewChangesDialog />',
      component('src/components/ReviewChangesDialog.astro'),
    );
  const { document, window } = parseHTML(
    `<html><body>${article()}${article()}${article('other/guide.txt')}${markup}</body></html>`,
  );
  for (const dialog of document.querySelectorAll('dialog')) {
    Object.defineProperty(dialog, 'open', {
      get: () => dialog.hasAttribute('open'),
    });
    (dialog as any).showModal = () => dialog.setAttribute('open', '');
    (dialog as any).close = () => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new window.Event('close'));
    };
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    '[data-edit-ref], [data-edit-url]',
  ))
    element.getBoundingClientRect = () =>
      ({ left: 50, bottom: 100 }) as DOMRect;
  const downloads: string[] = [];
  if (viewport)
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        get matches() {
          return query === '(max-width: 600px)'
            ? !!viewport.mobile
            : viewport.matches;
        },
        addEventListener: (_event: string, listener: () => void) => {
          viewport.changed = listener;
        },
      }),
    });
  const provider = {
    async load(path: string) {
      return loaded(text, path);
    },
  };
  const options: InlineEditorOptions = {
    pageCanvas,
    provider,
    drafts: new DraftStorage(storage),
    download: (_name, value) => downloads.push(value),
    ...overrides,
  };
  const controller = initializeInlineEditor(document, options)!;
  return {
    document,
    window,
    controller,
    storage,
    click: (selector: string) => click(document, selector),
    submit: (selector: string) => submit(document, selector),
    settle,
    downloads,
    map,
    options,
  };
}

test('wide toolbars expose discard while narrow toolbars keep it in overflow', async () => {
  const viewport: { matches: boolean; changed?: () => void } = {
    matches: true,
  };
  const f = fixture(undefined, '# Guide', true, viewport);
  f.click('[data-inline-edit-path]');
  await f.settle();
  const discard = f.document.querySelector<HTMLButtonElement>(
    '[data-editor-discard]',
  )!;
  assert.equal(f.document.querySelector('[data-editor-fallback]'), null);
  assert.ok(discard.closest('[data-editor-secondary]'));
  const finishActions = f.document.querySelector('.inline-editor-actions')!;
  assert.ok(finishActions.firstElementChild!.hasAttribute('data-editor-exit'));
  assert.ok(finishActions.lastElementChild!.hasAttribute('data-editor-review'));
  assert.equal(
    finishActions.lastElementChild!.textContent!.trim(),
    'Submit changes',
  );
  assert.equal(
    finishActions.lastElementChild!.getAttribute('aria-label'),
    'Submit changes',
  );
  assert.equal(f.document.querySelectorAll('[data-editor-discard]').length, 1);
  assert.equal(
    f.document.querySelector<HTMLElement>('[data-editor-options]')!.hidden,
    true,
  );
  f.click('[data-canvas-drop]');
  f.click('[data-canvas-new="text"]');
  assert.equal(discard.disabled, false);
  viewport.matches = false;
  viewport.changed!();
  assert.ok(discard.closest('.inline-editor-menu'));
  assert.equal(
    f.document.querySelector<HTMLElement>('[data-editor-options]')!.hidden,
    false,
  );
  viewport.matches = true;
  viewport.changed!();
  assert.ok(discard.closest('[data-editor-secondary]'));
  assert.ok(f.document.querySelector('[data-editor-discard]') === discard);
  f.click('[data-editor-discard]');
  f.click('[data-confirm-discard]');
  assert.equal(f.controller.session!.count, 0);
  assert.equal(discard.disabled, true);
});

test('DOM editing preserves formatting/emoji, synchronises repeated instances and leaves other guides alone', async () => {
  const f = fixture();
  f.click('[data-inline-edit-path]');
  await f.settle();
  assert.ok(f.controller.session);
  const old = entry(f.controller.session!, 'old');
  f.click(`[data-edit-ref="${old.id}"]`);
  const input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  assert.ok(input, 'The whole source line edits in place');
  assert.equal(
    f.document
      .querySelector('[data-inline-value-editor]')!
      .hasAttribute('open'),
    false,
  );
  const replacement = '<script>alert(1)</script>';
  input.querySelector('strong')!.textContent = replacement;
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const articles = [...f.document.querySelectorAll('article')];
  for (const article of articles.slice(0, 2)) {
    assert.equal(article.querySelector('strong')!.textContent, replacement);
    assert.equal(article.querySelectorAll('img.emoji').length, 1);
    assert.equal(
      article.querySelectorAll('script:not([data-guide-source-map])').length,
      0,
    );
    assert.ok(
      article.querySelector('[data-source-line][data-edit-modified]'),
      article.outerHTML.slice(0, 2200),
    );
  }
  assert.equal(articles[2].querySelector('strong')!.textContent, 'old');
  f.click('[data-editor-exit]');
  assert.equal(f.controller.session, undefined);
  assert.equal(articles[0].querySelector('strong')!.textContent, 'old');
  const refreshed = fixture(f.storage);
  refreshed.click('[data-inline-edit-path]');
  await refreshed.settle();
  assert.equal(refreshed.controller.session!.count, 1);
  assert.equal(
    refreshed.document.querySelector('strong')!.textContent,
    replacement,
  );
  refreshed.click('[data-editor-discard]');
  refreshed.click('[data-confirm-discard]');
  assert.equal(refreshed.controller.session!.count, 0);
  assert.equal(refreshed.document.querySelector('strong')!.textContent, 'old');
});

test('review has only submission and per-change discard controls', async () => {
  const f = fixture(undefined, 'Original\r\nSecond\r\n');
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  session.setDocument('Updated\r\nSecond\r\n');
  f.click('[data-editor-review]');
  assert.equal(f.document.querySelector('.review-options'), null);
  assert.equal(f.document.querySelector('[data-review-changes]'), null);
  assert.equal(f.document.querySelector('[data-diff-line-endings]'), null);
  assert.equal(f.document.querySelector('[data-prepared-update]'), null);
  assert.equal(
    f.document.querySelector('[data-prepare-update]')!.textContent!.trim(),
    'Submit for review',
  );
  assert.equal(f.document.querySelectorAll('[data-review-discard]').length, 1);
  assert.doesNotMatch(
    f.document.querySelector('[data-source-diff]')!.textContent!,
    /CRLF/,
  );
  assert.equal(session.content(), 'Updated\r\nSecond\r\n');
});

test('discarding sections preserves remaining edits and disables submission when empty', async () => {
  const original = 'First\r\nUnchanged\r\nLast\r\n';
  const f = fixture(undefined, original);
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  session.setDocument('First updated\r\nUnchanged\r\nLast updated\r\n');
  f.click('[data-editor-review]');
  assert.equal(f.document.querySelectorAll('[data-review-discard]').length, 2);
  f.click('[data-review-discard="0"]');
  f.click('[data-confirm-discard]');
  assert.equal(session.content(), 'First\r\nUnchanged\r\nLast updated\r\n');
  assert.equal(f.document.querySelectorAll('[data-review-discard]').length, 1);
  assert.equal(
    f.document.querySelector<HTMLButtonElement>('[data-prepare-update]')!
      .disabled,
    false,
  );
  f.click('[data-review-discard="0"]');
  f.click('[data-confirm-discard]');
  assert.equal(session.content(), original);
  assert.equal(session.count, 0);
  assert.equal(
    f.document.querySelector<HTMLButtonElement>('[data-prepare-update]')!
      .disabled,
    true,
  );
  assert.ok(
    f.document.querySelector('[data-review-dialog]')!.hasAttribute('open'),
  );
  assert.equal(
    f.document.querySelector<HTMLElement>('[data-review-empty]')!.hidden,
    false,
  );
  f.submit('[data-prepare-form]');
  await f.settle();
  assert.equal(f.downloads.length, 0);
});

test('discard refreshes a stale review before changing the draft', async () => {
  const f = fixture(undefined, 'Original');
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  session.setDocument('Updated');
  f.click('[data-editor-review]');
  session.setDocument('Newer update');
  f.click('[data-review-discard]');
  assert.equal(session.content(), 'Newer update');
  assert.match(
    f.document.querySelector('[data-review-error]')!.textContent!,
    /draft changed/,
  );
});

test('review marks exact source edits without highlighting unchanged text', async () => {
  const f = fixture(undefined, 'Cooldown: 3t.');
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  session.setDocument('Cooldown: 6t.');
  f.click('[data-editor-review]');
  const diff = f.document.querySelector('[data-source-diff]')!;
  assert.deepEqual(
    [...diff.querySelectorAll('.diff-remove mark')].map(
      (mark) => mark.textContent,
    ),
    ['3'],
  );
  assert.deepEqual(
    [...diff.querySelectorAll('.diff-add mark')].map(
      (mark) => mark.textContent,
    ),
    ['6'],
  );
  assert.match(diff.textContent!, /Cooldown: 3t/);
  assert.match(diff.textContent!, /Cooldown: 6t/);
  assert.equal(session.content(), 'Cooldown: 6t.');
});

test('review downloads validated changes in one action and retains errors without downloading', async () => {
  const f = fixture(undefined, 'Original');
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  session.setChanges([
    { entryId: session.map.entries[0].id, replacement: 'Updated' },
  ]);
  f.click('[data-editor-review]');
  f.submit('[data-prepare-form]');
  await f.settle();
  assert.equal(f.downloads.length, 0);
  assert.ok(f.document.querySelector('[data-prepare-status]')!.textContent);
  f.document.querySelector<HTMLTextAreaElement>('[name="notes"]')!.value =
    'Clarify the instructions.';
  f.submit('[data-prepare-form]');
  await f.settle();
  assert.equal(f.downloads.length, 1);
  assert.equal(JSON.parse(f.downloads[0]).content, 'Updated');
  assert.match(
    f.document.querySelector('[data-prepare-status]')!.textContent!,
    /not been published/,
  );
  assert.ok(
    f.document.querySelector('[data-review-dialog]')!.hasAttribute('open'),
  );
  assert.equal(session.count, 1);
});

test('link controls edit independent fields, bare URLs update labels and invalid edits keep the dialog open', async () => {
  const f = fixture();
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!,
    url = entry(session, 'https://example.com/a_(b)', 'link-url');
  assert.equal(
    f.click(`[data-edit-url="${url.id}"]`),
    false,
    'Navigation prevented',
  );
  const fields = [
    ...f.document.querySelectorAll<HTMLInputElement>(
      '[data-value-fields] input',
    ),
  ];
  assert.equal(fields.length, 2);
  fields[0].value = 'New label';
  fields[1].value = 'javascript:bad';
  f.submit('[data-value-form]');
  assert.equal(session.count, 0);
  assert.ok(
    f.document
      .querySelector('[data-inline-value-editor]')!
      .hasAttribute('open'),
  );
  assert.ok(f.document.querySelector('[data-value-error]')!.textContent);
  fields[1].value = 'https://new.example/long';
  f.submit('[data-value-form]');
  assert.equal(session.count, 2);
  const bare = entry(session, 'https://example.com/bare', 'link-url');
  f.click(`[data-edit-url="${bare.id}"]`);
  assert.equal(
    f.document.querySelectorAll('[data-value-fields] input').length,
    1,
  );
  f.document.querySelector<HTMLInputElement>(
    '[data-value-fields] input',
  )!.value = 'https://new.example/bare';
  f.submit('[data-value-form]');
  assert.equal(
    f.document.querySelector(`[data-edit-url="${bare.id}"]`)!.textContent,
    'https://new.example/bare',
  );
  f.click('[data-editor-review]');
  assert.match(
    f.document.querySelector('[data-source-diff]')!.textContent!,
    /new\.example/,
  );
  f.document.querySelector<HTMLInputElement>(
    '[data-prepare-form] [name="notes"]',
  )!.value = 'Fix guide';
  f.submit('[data-prepare-form]');
  await f.settle();
  const payload = JSON.parse(f.downloads.at(-1)!);
  assert.equal(payload.content, session.content());
  assert.equal(payload.replaceExistingReview, false);
  assert.equal(f.downloads.length, 1);
  assert.equal(JSON.parse(f.downloads[0]).content, session.content());
});

test('one active file, keyboard target selection, cancellation and blocked draft recovery', async () => {
  const f = fixture();
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  f.click('[data-inline-edit-path="other/guide.txt"]');
  await f.settle();
  assert.equal(f.controller.session, session);
  const target = f.document.querySelector(
    `[data-edit-ref="${entry(session, 'old').id}"]`,
  )!;
  const key = new f.window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(key, { key: 'Enter' });
  target.dispatchEvent(key);
  assert.ok(f.document.querySelector('.inline-line-input'));
  f.click('[data-line-cancel]');
  assert.equal(session.count, 0);
  f.click('[data-editor-exit]');
  const drafts = new DraftStorage(f.storage);
  f.storage.setItem(drafts.key(session.path), '{broken');
  f.click('[data-inline-edit-path]');
  await f.settle();
  assert.equal(
    f.document.querySelectorAll('article[data-inline-active]').length,
    0,
  );
  f.click('[data-draft-export]');
  assert.equal(f.downloads[0], '{broken');
  f.click('[data-draft-discard]');
  f.click('[data-confirm-discard]');
  assert.equal(
    f.document.querySelectorAll('article[data-inline-active]').length,
    2,
  );
});

test('URL-only editing preserves a formatted label even when its displayed text equals the URL', async () => {
  const text = '[**https://example.com/complex**](https://example.com/complex)';
  const rendered = render(text),
    map = rendered.sourceMap!;
  const session = await EditSession.create(map, loaded(text));
  const url = map.entries.find((entry) => entry.kind === 'link-url')!;
  assert.equal(session.isBareUrl(url.id), false);
  const document = parseHTML(
    `<article data-guide-source="${map.path}" data-guide-source-hash="${map.sourceHash}">${rendered.html}</article>`,
  ).document;
  session.setChanges([
    { entryId: url.id, replacement: 'https://new.example/changed' },
  ]);
  updateDraftPreview(document, session, true);
  assert.equal(
    document.querySelector('a')!.getAttribute('href'),
    'https://new.example/changed',
  );
  assert.equal(
    document.querySelector('a strong')!.textContent,
    'https://example.com/complex',
  );
  updateDraftPreview(document, session, false);
  assert.equal(
    document.querySelector('a strong')!.textContent,
    'https://example.com/complex',
  );
  assert.equal(
    document.querySelector('a')!.getAttribute('href'),
    'https://example.com/complex',
  );
});

test('link dialogs preserve an open whole-line panel and refresh its link after saving', async () => {
  const f = fixture();
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!,
    url = entry(session, 'https://example.com/a_(b)', 'link-url');
  const line = f.document
    .querySelector(`[data-edit-url="${url.id}"]`)!
    .closest<HTMLElement>('[data-source-line]')!;
  f.click(`[data-source-line="${line.dataset.sourceLine}"]`);
  const root = f.document.querySelector('.inline-line-input')!;
  f.click(`.inline-line-input [data-edit-url="${url.id}"]`);
  assert.equal(
    f.document.querySelector('.inline-line-input'),
    root,
    'Opening the link dialog must not close the line editor',
  );
  assert.ok(line.hasAttribute('data-line-editing'));
  const fields = [
    ...f.document.querySelectorAll<HTMLInputElement>(
      '[data-value-fields] input',
    ),
  ];
  fields[0].value = 'Updated label';
  fields[1].value = 'https://new.example/updated';
  f.submit('[data-value-form]');
  assert.equal(f.document.querySelector('.inline-line-input'), root);
  assert.equal(root.querySelector('a')!.textContent, 'Updated label');
  assert.equal(
    root.querySelector('a')!.getAttribute('href'),
    'https://new.example/updated',
  );
  f.click('[data-line-done]');
  assert.match(session.content(), /Updated label/);
  assert.match(session.content(), /https:\/\/new.example\/updated/);
});

test('the Link toolbar icon edits a link without closing or losing the surrounding line draft', async () => {
  const text = 'Before [old label](<https://example.com/a_(b)> "keep") after';
  const f = fixture(new MemoryStore(), text);
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.click('[data-source-line]');
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  root.querySelector('[data-rich-row]')!.firstChild!.textContent =
    'Changed before ';
  root.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.click('[data-format-link]');
  const fields = [
    ...f.document.querySelectorAll<HTMLInputElement>(
      '[data-value-fields] input',
    ),
  ];
  assert.deepEqual(
    fields.map((field) => field.value),
    ['old label', 'https://example.com/a_(b)'],
  );
  fields[0].value = 'Updated link';
  fields[1].value = 'https://new.example/link';
  f.submit('[data-value-form]');
  assert.equal(f.document.querySelector('.inline-line-input'), root);
  assert.equal(root.querySelector('a')!.textContent, 'Updated link');
  f.click('[data-line-done]');
  const expected =
    'Changed before [Updated link](<https://new.example/link> "keep") after';
  assert.equal(f.controller.session!.content(), expected);
  const restored = await create(text);
  new DraftStorage(f.storage).restore(restored);
  assert.equal(restored.content(), expected);
});

test('Ctrl+K offers links in source order and cancelling keeps the line open', async () => {
  const text =
    'See [First](https://first.example) and [Second](https://second.example).';
  const f = fixture(new MemoryStore(), text);
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.click('[data-source-line]');
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  const shortcut = new f.window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(shortcut, { key: 'k', ctrlKey: true });
  root.dispatchEvent(shortcut);
  assert.equal(shortcut.defaultPrevented, true);
  const choices = [...f.document.querySelectorAll('[data-link-picker] button')];
  assert.deepEqual(
    choices.map((choice) => choice.textContent),
    ['First', 'Second'],
  );
  f.click('[data-link-picker] button:nth-child(2)');
  assert.deepEqual(
    [
      ...f.document.querySelectorAll<HTMLInputElement>(
        '[data-value-fields] input',
      ),
    ].map((field) => field.value),
    ['Second', 'https://second.example'],
  );
  f.click('[data-value-cancel]');
  assert.equal(f.document.querySelector('.inline-line-input'), root);
  assert.equal(f.controller.session!.content(), text);
  f.click('[data-format-link]');
  const escape = new f.window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(escape, { key: 'Escape' });
  f.document.querySelector('[data-link-picker] button')!.dispatchEvent(escape);
  assert.equal(f.document.querySelector('[data-link-picker]'), null);
  assert.equal(f.document.querySelector('.inline-line-input'), root);
});

test('the Link toolbar icon asks for a text selection before creating a link', async () => {
  const f = fixture();
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.click('[data-source-line]');
  const root = f.document.querySelector('.inline-line-input');
  f.click('[data-format-link]');
  assert.match(
    f.document.querySelector('.line-edit-error')!.textContent!,
    /Select the text to link first/,
  );
  assert.equal(f.document.querySelector('.inline-line-input'), root);
  assert.equal(
    f.document
      .querySelector('[data-inline-value-editor]')!
      .hasAttribute('open'),
    false,
  );
});

test('list chunks retain parent and child drafts when editing a child link and cancelling the chunk', async () => {
  const text =
    '⬥ Parent [one](https://one.example)\n    • Child [two](https://two.example)\n⬥ Last';
  const f = fixture(new MemoryStore(), text);
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.click('[data-source-line]');
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  const rows = [...root.querySelectorAll<HTMLElement>('[data-rich-row]')];
  assert.equal(rows.length, 3);
  rows[0].firstChild!.textContent = 'Changed parent ';
  rows[1].firstChild!.textContent = 'Changed child ';
  rows[1].dataset.bulletPrefix = '        ⬩ ';
  root.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const url = entry(f.controller.session!, 'https://two.example', 'link-url');
  f.click(`.inline-line-input [data-edit-url="${url.id}"]`);
  const fields = [
    ...f.document.querySelectorAll<HTMLInputElement>(
      '[data-value-fields] input',
    ),
  ];
  fields[0].value = 'Updated child link';
  fields[1].value = 'https://updated.example/child';
  f.submit('[data-value-form]');
  assert.ok(f.document.querySelector('.inline-line-input') === root);
  assert.equal(rows[1].querySelector('a')!.textContent, 'Updated child link');
  assert.equal(
    f.controller.session!.content(),
    '⬥ Changed parent [one](https://one.example)\n        ⬩ Changed child [Updated child link](https://updated.example/child)\n⬥ Last',
  );
  f.click('[data-line-cancel]');
  assert.equal(f.controller.session!.content(), text);
  assert.equal(f.controller.session!.count, 0);
  assert.equal(f.document.querySelector('[data-inline-list-hidden]'), null);
});

test('Tab still moves focus normally when editing an ordinary paragraph', async () => {
  const f = fixture(new MemoryStore(), 'Ordinary paragraph');
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.click('[data-source-line]');
  const key = new f.window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(key, { key: 'Tab', shiftKey: false });
  f.document.querySelector('.inline-line-input')!.dispatchEvent(key);
  assert.equal(key.defaultPrevented, false);
  assert.equal(f.controller.session!.count, 0);
});

test('the highlighted list section opens as one editor when its surrounding space is clicked', async () => {
  const source = '⬥ Parent\n    • Child\n⬥ Sibling';
  const f = fixture(new MemoryStore(), source);
  f.click('[data-inline-edit-path]');
  await f.settle();
  const chunk = f.document.querySelector('[data-edit-chunk]')!;
  assert.ok(chunk);
  assert.equal(
    chunk.querySelector('[data-edit-chunk]'),
    null,
    'Nested bullets share the outer section highlight',
  );
  f.click('[data-edit-chunk]');
  const root = f.document.querySelector('.inline-line-input')!;
  assert.deepEqual(
    [...root.querySelectorAll('[data-rich-row]')].map((row) => row.textContent),
    ['Parent', 'Child', 'Sibling'],
  );
  f.click('[data-line-cancel]');
  assert.equal(f.controller.session!.count, 0);
  assert.ok(chunk.hasAttribute('data-edit-chunk'));
  f.click('[data-editor-exit]');
  assert.equal(f.document.querySelector('[data-edit-chunk]'), null);
});

test('page-canvas changes share review, verified export, exit and draft restoration', async () => {
  const text = '# Guide\n\nOriginal paragraph';
  const f = fixture(new MemoryStore(), text, true);
  f.click('[data-inline-edit-path]');
  await f.settle();
  assert.ok(f.document.querySelector('[data-page-canvas]'));
  assert.ok(
    f.document.querySelector('[data-editor-history] [data-canvas-undo]'),
  );
  assert.equal(
    f.document.querySelector('[data-page-canvas] .canvas-session-tools'),
    null,
  );
  f.click('[data-canvas-drop]');
  f.click('[data-canvas-new="heading"]');
  assert.ok(f.controller.session!.content().includes('## New section'));
  f.click('[data-editor-review]');
  assert.match(
    f.document.querySelector('[data-source-diff]')!.textContent!,
    /New section/,
  );
  f.document.querySelector<HTMLInputElement>(
    '[data-prepare-form] [name="title"]',
  )!.value = 'Add a section';
  f.document.querySelector<HTMLTextAreaElement>(
    '[data-prepare-form] [name="notes"]',
  )!.value = 'Adds the missing section.';
  f.submit('[data-prepare-form]');
  await f.settle();
  const payload = JSON.parse(f.downloads.at(-1)!);
  assert.equal(payload.originalContent, text);
  assert.equal(payload.content, f.controller.session!.content());
  f.click('[data-review-close]');
  f.click('[data-editor-exit]');
  assert.equal(f.document.querySelector('[data-page-canvas]'), null);
  assert.match(
    f.document.querySelector('[data-local-draft-preview]')!.textContent!,
    /New section/,
  );
  assert.equal(f.controller.session, undefined);
  f.click('[data-inline-edit-path]');
  await f.settle();
  assert.ok(f.document.querySelector('[data-page-canvas]'));
  assert.ok(f.controller.session!.content().includes('## New section'));
  f.click('[data-editor-discard]');
  f.click('[data-confirm-discard]');
  assert.equal(f.controller.session!.content(), text);
  assert.equal(f.controller.session!.count, 0);
  assert.doesNotMatch(
    f.document.querySelector('.canvas-board')!.textContent!,
    /New section/,
  );
});

test('plain text above bullets remains visible after exiting, refreshing, reopening and discarding', async () => {
  const original = '⬥ First **bold**\r\n⬥ Second\r\n⬥ Third';
  const storage = new MemoryStore();
  const f = fixture(storage, original, true);
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.click('[data-canvas-preview]');
  await f.settle();
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  const first = root.querySelector<HTMLElement>('[data-rich-row]')!;
  const intro = first.cloneNode(false) as HTMLElement;
  intro.dataset.bulletPrefix = '';
  intro.textContent = 'Some general notes:';
  root.prepend(intro);
  root.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.click('[data-line-done]');
  await f.settle();
  const saved = f.controller.session!.content();
  f.click('[data-editor-exit]');
  const reading = f.document.querySelector('[data-local-draft-preview]')!;
  assert.ok(reading.textContent?.includes('Some general notes:'));
  assert.equal(reading.querySelectorAll('li').length, 3);
  assert.equal(
    reading.querySelector(
      '[data-source-line],.line-formatting,[data-canvas-drop]',
    ),
    null,
  );
  assert.equal(reading.querySelector('button'), null);
  const refreshed = fixture(storage, original, true);
  await refreshed.settle();
  assert.ok(
    refreshed.document
      .querySelector('[data-local-draft-preview]')
      ?.textContent?.includes('Some general notes:'),
  );
  refreshed.click('[data-inline-edit-path]');
  await refreshed.settle();
  assert.ok(!refreshed.document.querySelector('[data-local-draft-preview]'));
  assert.equal(refreshed.controller.session!.content(), saved);
  refreshed.click('[data-editor-discard]');
  refreshed.click('[data-confirm-discard]');
  refreshed.click('[data-editor-exit]');
  assert.ok(!refreshed.document.querySelector('[data-local-draft-preview]'));
  assert.equal(
    storage.getItem(new DraftStorage(storage).key('test/guide.txt')),
    null,
  );
});

test('Bullets toggles ordinary text on and off without losing inline styles or links', async () => {
  const source = 'Regular **bold** [label](https://example.com)';
  const f = fixture(new MemoryStore(), source);
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.click('[data-source-line]');
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  const button = f.document.querySelector('[data-format-bullet]')!;
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(root.getAttribute('aria-multiline'), 'true');
  f.click('[data-format-bullet]');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(f.controller.session!.content(), '⬥ ' + source);
  assert.ok(root.querySelector('strong'));
  assert.equal(root.querySelector('a')!.textContent, 'label');
  f.click('[data-line-done]');
  assert.equal(
    f.document
      .querySelector('[data-rich-row]')!
      .getAttribute('data-continuation-bullet'),
    '⬥',
  );
  f.click('[data-source-line]');
  f.click('[data-format-bullet]');
  assert.equal(f.controller.session!.content(), source);
  assert.equal(f.controller.session!.count, 0);
  f.click('[data-line-done]');
  assert.equal(f.document.querySelector('[data-continuation-bullet]'), null);
});

test('Bullets converts selected rows with mixed state and Cancel restores the whole chunk', async (t) => {
  const source = '⬥ First\n    • Child\n⬥ Last';
  const f = fixture(new MemoryStore(), source);
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.click('[data-source-line]');
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  const rows = [...root.querySelectorAll<HTMLElement>('[data-rich-row]')];
  const range = {
    startContainer: rows[1].firstChild!,
    endContainer: rows[1].firstChild!,
    commonAncestorContainer: root,
    collapsed: true,
    startOffset: 0,
    endOffset: 0,
    cloneRange() {
      return this;
    },
  };
  mockSelection(t, f.document, range);
  f.click('[data-format-bullet]');
  assert.equal(f.controller.session!.content(), '⬥ First\nChild\n⬥ Last');
  assert.equal(rows[1].hasAttribute('data-continuation-bullet'), false);
  range.startContainer = rows[0].firstChild!;
  range.endContainer = rows[2].firstChild!;
  range.endOffset = 4;
  range.collapsed = false;
  f.document.dispatchEvent(new f.window.Event('selectionchange'));
  assert.equal(
    f.document
      .querySelector('[data-format-bullet]')!
      .getAttribute('aria-pressed'),
    'mixed',
  );
  f.click('[data-format-bullet]');
  assert.equal(
    f.document
      .querySelector('[data-format-bullet]')!
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(f.controller.session!.content(), source);
  f.click('[data-format-bullet]');
  assert.equal(f.controller.session!.content(), 'First\nChild\nLast');
  f.click('[data-line-cancel]');
  assert.equal(f.controller.session!.content(), source);
});

test('read-only links inside the open panel cannot navigate or close it', async () => {
  const f = fixture();
  f.click('[data-inline-edit-path]');
  await f.settle();
  const url = entry(
    f.controller.session!,
    'https://example.com/a_(b)',
    'link-url',
  );
  const line = f.document
    .querySelector(`[data-edit-url="${url.id}"]`)!
    .closest<HTMLElement>('[data-source-line]')!;
  f.click(`[data-source-line="${line.dataset.sourceLine}"]`);
  const root = f.document.querySelector('.inline-line-input')!;
  const link = root.querySelector('a')!;
  link.removeAttribute('data-edit-ref');
  link.removeAttribute('data-edit-url');
  const navigated = link.dispatchEvent(
    new f.window.Event('click', { bubbles: true, cancelable: true }),
  );
  assert.equal(navigated, false);
  assert.equal(f.document.querySelector('.inline-line-input'), root);
  assert.equal(
    f.document
      .querySelector('[data-inline-value-editor]')!
      .hasAttribute('open'),
    false,
  );
});

test('a stale provider snapshot leaves the guide read-only', async () => {
  const f = fixture();
  // Initialise a fresh DOM controller with an injectable stale source provider.
  delete f.document.querySelector<HTMLElement>('[data-inline-editor]')!.dataset
    .ready;
  // Separate document avoids retaining event handlers from the fixture's controller.
  const { document } = parseHTML(f.document.toString());
  const controller = initializeInlineEditor(document, {
    provider: {
      async load() {
        return loaded(source + 'changed');
      },
    },
    drafts: new DraftStorage(new MemoryStore()),
  })!;
  document
    .querySelector('[data-inline-edit-path]')!
    .dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await f.settle();
  assert.equal(controller.session, undefined);
  assert.equal(document.querySelectorAll('[data-inline-active]').length, 0);
  assert.match(
    document.querySelector('[data-editor-error]')!.textContent!,
    /older source/,
  );
  assert.equal(document.querySelector('[data-editor-fallback]'), null);
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-editor-review]')!.disabled,
    true,
  );
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-editor-discard]')!
      .disabled,
    true,
  );
});

test('clicking either highlighted side discards only that edit on a line', async () => {
  const f = fixture(undefined, 'Cooldown: 3t; cost: 20%.');
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  session.setDocument('Cooldown: 6t; cost: 25%.');
  f.click('[data-editor-review]');
  assert.equal(f.document.querySelectorAll('[data-review-discard]').length, 1);
  assert.equal(
    f.document.querySelectorAll('.diff-add [data-review-edit]').length,
    2,
  );
  f.click('.diff-add [data-review-edit="1"]');
  f.click('[data-confirm-discard]');
  assert.equal(session.content(), 'Cooldown: 6t; cost: 20%.');
  assert.equal(
    f.document.querySelectorAll('.diff-add [data-review-edit]').length,
    1,
  );
  f.click('.diff-remove [data-review-edit="0"]');
  f.click('[data-confirm-discard]');
  assert.equal(session.content(), 'Cooldown: 3t; cost: 20%.');
  assert.equal(
    f.document.querySelector<HTMLButtonElement>('[data-prepare-update]')!
      .disabled,
    true,
  );
});

test('review discard requires confirmation and Cancel preserves the draft', async () => {
  const f = fixture(undefined, 'Cooldown: 3t; cost: 20%.');
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  const edited = 'Cooldown: 6t; cost: 25%.';
  session.setDocument(edited);
  f.click('[data-editor-review]');
  f.click('.diff-add [data-review-edit="1"]');
  assert.equal(session.content(), edited);
  assert.ok(
    f.document.querySelector('[data-editor-confirm]')!.hasAttribute('open'),
  );
  assert.equal(
    f.document.querySelector('#inline-confirm-title')!.textContent,
    'Discard this edit?',
  );
  f.click('[data-confirm-cancel]');
  assert.equal(session.content(), edited);
  assert.ok(
    f.document.querySelector('[data-review-dialog]')!.hasAttribute('open'),
  );
  f.click('[data-review-discard]');
  assert.equal(session.content(), edited);
  assert.equal(
    f.document.querySelector('#inline-confirm-title')!.textContent,
    'Discard this section?',
  );
  f.click('[data-confirm-cancel]');
  assert.equal(session.content(), edited);
});

test('confirmation cannot discard an edit from a stale draft snapshot', async () => {
  const f = fixture(undefined, 'Original');
  f.click('[data-inline-edit-path]');
  await f.settle();
  const session = f.controller.session!;
  session.setDocument('Updated');
  f.click('[data-editor-review]');
  f.click('[data-review-discard]');
  session.setDocument('Newer update');
  f.click('[data-confirm-discard]');
  assert.equal(session.content(), 'Newer update');
  assert.match(
    f.document.querySelector('[data-review-error]')!.textContent!,
    /draft changed/,
  );
});

test('Discord heading prefixes stay hidden entering, editing, leaving and reopening the editor', async () => {
  for (const pageCanvas of [false, true]) {
    const original =
      '# > __Magic DPM Advice__\n.\n## > Core Rotation\nSettings > Interfaces';
    const f = fixture(undefined, original, pageCanvas);
    const visibleHeadings = () =>
      [...f.document.querySelectorAll('article h2, article h3')].map(
        (node) => node.textContent,
      );
    assert.ok(visibleHeadings().every((text) => !text?.startsWith('> ')));
    f.click('[data-inline-edit-path]');
    await f.settle();
    assert.ok(visibleHeadings().every((text) => !text?.startsWith('> ')));
    f.click(
      pageCanvas
        ? '[data-canvas-kind="heading"] [data-canvas-preview]'
        : 'article h2 [data-source-line]',
    );
    await f.settle();
    const row = f.document.querySelector<HTMLElement>(
      '.inline-line-input [data-rich-row]',
    )!;
    assert.equal(row.textContent, 'Magic DPM Advice');
    row.textContent = 'Arcane DPM Advice';
    f.document
      .querySelector('.inline-line-input')!
      .dispatchEvent(new f.window.Event('input', { bubbles: true }));
    f.click('[data-line-done]');
    await f.settle();
    assert.ok(visibleHeadings().every((text) => !text?.startsWith('> ')));
    assert.ok(
      f.controller.session!.content().includes('# > Arcane DPM Advice'),
    );
    const edited = f.controller.session!.content();
    f.click('[data-editor-exit]');
    assert.ok(visibleHeadings().every((text) => !text?.startsWith('> ')));
    f.click('[data-inline-edit-path]');
    await f.settle();
    assert.ok(visibleHeadings().every((text) => !text?.startsWith('> ')));
    assert.equal(f.controller.session!.content(), edited);
  }
});

test('mobile places Discard, Done and Submit together and keeps discard confirmation', async () => {
  const viewport: { matches: boolean; mobile: boolean; changed?: () => void } =
    { matches: false, mobile: true };
  const f = fixture(undefined, '# Guide', true, viewport);
  f.click('[data-inline-edit-path]');
  await f.settle();
  const actions = f.document.querySelector('.inline-editor-actions')!;
  assert.deepEqual(
    [...actions.children].map((button) => button.textContent!.trim()),
    ['Discard', 'Done', 'Submit'],
  );
  assert.equal(f.document.querySelectorAll('[data-editor-discard]').length, 1);
  f.click('[data-canvas-drop]');
  f.click('[data-canvas-new="text"]');
  const content = f.controller.session!.content();
  f.click('[data-editor-discard]');
  assert.equal(f.controller.session!.content(), content);
  f.click('[data-confirm-cancel]');
  assert.equal(f.controller.session!.content(), content);
  viewport.mobile = false;
  viewport.matches = true;
  viewport.changed!();
  assert.ok(
    f.document.querySelector('[data-editor-secondary] [data-editor-discard]'),
  );
  assert.equal(
    f.document.querySelector('[data-editor-discard]')!.textContent,
    'Discard draft',
  );
  assert.equal(
    f.document.querySelector('[data-editor-review] span')!.textContent,
    'Submit changes',
  );
});

test('account suspension removes private canvas and Done previews while retaining isolated drafts', async () => {
  const store = new MemoryStore();
  const f = fixture(store, '# Guide\nA paragraph', true, undefined, {
    drafts: new DraftStorage(store, 'github:42'),
    restoreReadingDrafts: false,
  });
  f.click('[data-inline-edit-path]');
  await f.settle();
  const first = f.controller.session!;
  f.click('[data-canvas-drop]');
  f.click('[data-canvas-new="heading"]');
  const privateContent = first.content();
  assert.equal(f.controller.checkpoint(), true);
  f.click('[data-editor-exit]');
  assert.match(f.document.body.textContent!, /New section/);
  f.controller.suspend();
  assert.doesNotMatch(f.document.body.textContent!, /New section/);
  f.options.drafts = new DraftStorage(store, 'discord:42');
  f.click('[data-inline-edit-path]');
  await f.settle();
  assert.equal(f.controller.session!.count, 0);
  assert.ok(new DraftStorage(store, 'github:42').hasDraft(first.path));
  f.controller.suspend();
  f.options.drafts = new DraftStorage(store, 'github:42');
  f.click('[data-inline-edit-path]');
  await f.settle();
  assert.equal(f.controller.session!.content(), privateContent);
});

test('session expiry cancels an in-flight source load before any canvas or draft restoration', async () => {
  let resolve: ((value: ReturnType<typeof loaded>) => void) | undefined;
  const f = fixture(undefined, source, true, undefined, {
    restoreReadingDrafts: false,
    provider: {
      load: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  });
  f.click('[data-inline-edit-path]');
  await f.settle();
  assert.ok(resolve);
  f.controller.suspend();
  resolve(loaded(source));
  await f.settle();
  assert.equal(f.controller.session, undefined);
  assert.equal(f.document.querySelector('[data-inline-active]'), null);
});

test('eligibility gate leaves anonymous reading unchanged and does not fetch guide source', async () => {
  let loads = 0;
  const f = fixture(undefined, source, true, undefined, {
    beforeEnter: async () => {
      throw new Error('Sign in to edit');
    },
    provider: {
      async load() {
        loads++;
        return loaded(source);
      },
    },
    restoreReadingDrafts: false,
  });
  f.click('[data-inline-edit-path]');
  await f.settle();
  assert.equal(loads, 0);
  assert.equal(f.controller.session, undefined);
  assert.match(
    f.document.querySelector('[data-editor-error]')!.textContent!,
    /Sign in to edit/,
  );
  assert.equal(f.document.querySelector('[data-inline-active]'), null);
});

async function submissionFixture(
  text = 'Original\r\nSecond\n',
  existing = false,
  dryRun = false,
  delayed = false,
) {
  const { GuideApi } = await import('../src/lib/guide-api');
  const { GuideSubmission } = await import('../src/lib/guide-submission');
  const user = {
    provider: 'github' as const,
    githubId: '42',
    githubLogin: 'mock',
    username: 'mock',
    globalName: '',
    displayName: 'Mock',
    avatar: '',
    csrfToken: 'csrf',
    canReviewPrs: false,
  };
  const branch = 'guide-editor/github-42/test';
  let posts = 0;
  let release!: () => void;
  const gate = delayed
    ? new Promise<void>((resolve) => (release = resolve))
    : Promise.resolve();
  const api = new GuideApi(
    true,
    (async (url, init) => {
      if (String(url).endsWith('/auth/me'))
        return new Response(JSON.stringify({ user }));
      posts++;
      await gate;
      const payload = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify(
          dryRun
            ? {
                dryRun: true,
                contractVersion: 2,
                contributor: 'github:42',
                reviewStateVerified: false,
                message: 'Validated',
                title: payload.title,
                path: payload.path,
                source: payload.source,
                branch: payload.branch,
                reviewBranch: branch,
                user,
                contentBytes: Buffer.byteLength(payload.content),
                originalContentBytes: Buffer.byteLength(
                  payload.originalContent,
                ),
              }
            : {
                contractVersion: 2,
                contributor: 'github:42',
                prUrl: 'https://github.com/pvme/pvme-guides/pull/123',
                branch,
                path: payload.path,
                reusedReview: existing,
              },
        ),
        { status: existing || dryRun ? 200 : 201 },
      );
    }) as typeof fetch,
    true,
  );
  await api.restore();
  const store = new MemoryStore();
  const provider = {
    async load(path: string) {
      return {
        ...loaded(text, path),
        contributor: 'github:42' as const,
        reviewState: existing
          ? {
              state: 'present' as const,
              repository: 'mock/pvme-guides',
              branch,
              headSha: 'a'.repeat(40),
              prId: 1001,
              prNumber: 123,
              prUrl: 'https://github.com/pvme/pvme-guides/pull/123',
            }
          : { state: 'none' as const },
        ...(existing
          ? {
              existingReviewBranch: branch,
              existingReviewUrl: 'https://github.com/pvme/pvme-guides/pull/123',
            }
          : {}),
      };
    },
  };
  const f = fixture(store, text, false, undefined, {
    provider,
    drafts: new DraftStorage(store, 'github:42'),
    submission: new GuideSubmission(api, provider),
    restoreReadingDrafts: false,
  });
  f.click('[data-inline-edit-path]');
  await f.settle();
  f.controller.session!.setDocument(text.replace('Original', 'Edited'));
  f.options.drafts.save(f.controller.session!);
  f.click('[data-editor-review]');
  f.document.querySelector<HTMLInputElement>(
    '[data-prepare-form] [name="title"]',
  )!.value = 'Update';
  f.document.querySelector<HTMLTextAreaElement>(
    '[data-prepare-form] [name="notes"]',
  )!.value = 'Reason';
  return {
    ...f,
    get posts() {
      return posts;
    },
    release: () => release?.(),
  };
}
test('authenticated review shows real pending/success, keeps recovery export, and returns to published reading', async () => {
  const f = await submissionFixture(undefined, false, false, true);
  f.submit('[data-prepare-form]');
  f.submit('[data-prepare-form]');
  await f.settle();
  assert.equal(f.posts, 1);
  assert.equal(
    f.document.querySelector<HTMLButtonElement>('[data-prepare-update]')!
      .disabled,
    true,
  );
  assert.equal(
    f.document.querySelector<HTMLElement>('[data-submit-export]')!.hidden,
    false,
  );
  f.release();
  await f.settle();
  assert.match(
    f.document.querySelector('[data-prepare-status]')!.textContent!,
    /Created your pull request/,
  );
  assert.equal(
    f.document.querySelector('[data-submit-pr]')!.getAttribute('href'),
    'https://github.com/pvme/pvme-guides/pull/123',
  );
  assert.ok(f.options.drafts.hasDraft(f.map.path));
  let focused: HTMLElement | undefined;
  for (const element of f.document.querySelectorAll<HTMLElement>('button'))
    element.focus = () => {
      focused = element;
    };
  f.click('[data-submit-reading]');
  // Browsers queue dialog close; its return target must survive completion.
  f.document
    .querySelector('dialog[data-review-dialog]')
    ?.dispatchEvent(new f.window.Event('close'));
  assert.equal(focused, f.document.querySelector('[data-inline-edit-path]'));
  assert.equal(f.controller.session, undefined);
  assert.equal(f.options.drafts.hasDraft(f.map.path), false);
  assert.match(f.document.querySelector('article')!.textContent!, /Original/);
  assert.equal(f.document.querySelector('[data-local-draft-preview]'), null);
});
test('master replacement requires a checkbox; dry-run remains clearly unpublished with its draft', async () => {
  const f = await submissionFixture(undefined, true, true);
  assert.equal(
    f.document.querySelector<HTMLElement>('[data-replacement-consent]')!.hidden,
    false,
  );
  f.submit('[data-prepare-form]');
  await f.settle();
  assert.equal(f.posts, 0);
  assert.match(
    f.document.querySelector('[data-prepare-status]')!.textContent!,
    /Confirm replacement/,
  );
  const input = f.document.querySelector<HTMLInputElement>(
    '[data-replace-review]',
  )!;
  input.checked = true;
  input.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  f.submit('[data-prepare-form]');
  await f.settle();
  assert.equal(f.posts, 1);
  assert.match(
    f.document.querySelector('[data-prepare-status]')!.textContent!,
    /No PR was created or updated/,
  );
  assert.ok(f.options.drafts.hasDraft(f.map.path));
  assert.equal(
    f.document.querySelector<HTMLElement>('[data-submit-reading]')!.hidden,
    true,
  );
});
test('account suspension hides a late success and never retires the previous contributor draft', async () => {
  const f = await submissionFixture(undefined, false, false, true);
  f.submit('[data-prepare-form]');
  await f.settle();
  f.controller.suspend();
  f.options.drafts = new DraftStorage(f.storage, 'github:99');
  f.release();
  await f.settle();
  assert.equal(f.controller.session, undefined);
  assert.equal(
    f.document.querySelector<HTMLElement>('[data-submit-result]')!.hidden,
    true,
  );
  assert.ok(new DraftStorage(f.storage, 'github:42').hasDraft(f.map.path));
  assert.equal(f.options.drafts.hasDraft(f.map.path), false);
});
