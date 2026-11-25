import {
  createTestGuide as session,
  openRichEditor,
  mockSelection,
} from './helpers';
import { linkSelection } from '../src/lib/rich-selection';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuide } from '@pvme/guide-parser';
import { renderGuide } from '../src/lib/renderer';
import { parseHTML } from 'linkedom';
import { DraftStorage } from '../src/lib/draft-storage';
import { newEmojiToken } from '../src/lib/emoji-token';
import {
  readRichLine,
  writeRichLine,
  normalizeRichLine,
  shiftBulletPrefix,
  type RichLine,
} from '../src/lib/source-lines';
import { updateDraftPreview } from '../src/scripts/inline-preview';
import {
  RichLineEditor,
  readEditorModel,
  ensureEditableRow,
} from '../src/scripts/rich-line-editor';

const example =
  'It is **more than likely __user error__ or __cutting corners__**, use <#656898197561802760> if you cannot get it to work.';
test('new emoji tokens compose with formatting and existing protected source and restore from drafts', async () => {
  const original = '## Heading\r\n⬥ Text **bold** <#123456789>\r\n.tag:keep';
  const f = await session(original);
  const token = newEmojiToken('<:necromancy:1127645236454912080>')!;
  assert.ok(token);
  for (const line of f.session.lines) {
    const model = f.session.lineModel(line.id);
    model[0].push({ type: 'token', id: token.id, marks: ['bold'] });
    f.session.setLine(line.id, model);
  }
  assert.match(
    f.session.content(),
    /Heading\*\*<:necromancy:1127645236454912080>\*\*/,
  );
  assert.ok(f.session.content().includes('<#123456789>'));
  assert.ok(f.session.content().endsWith('.tag:keep'));
  const fresh = await session(original);
  fresh.session.replaceChanges(f.session.changes);
  assert.equal(fresh.session.content(), f.session.content());
  assert.ok(!newEmojiToken('<script>bad</script>'));
  assert.ok(!newEmojiToken('<:bad:javascript>'));
});

test('the same emoji can be inserted before an existing emoji without changing protected links', async () => {
  const raw = '<:necromancy:1127645236454912080>';
  const f = await session(`Text ${raw} <#123456789>`);
  const line = f.session.lines[0];
  const model = f.session.lineModel(line.id);
  model[0].unshift({ type: 'token', id: newEmojiToken(raw)!.id, marks: [] });
  f.session.setLine(line.id, model);
  assert.equal((f.session.content().match(/<:necromancy:/g) || []).length, 2);
  assert.ok(f.session.content().endsWith('<#123456789>'));
});

for (const eol of ['\n', '\r\n'])
  test(`one original line spans formatting and preserves protected objects (${JSON.stringify(eol)})`, async () => {
    const fixture = await session(
        `⬥ ${example}${eol}⬥ Untouched 🚀${eol}.tag:unchanged`,
      ),
      s = fixture.session;
    const line = s.lines[0];
    assert.equal(line.bullet, true);
    assert.equal(line.prefix, '⬥ ');
    const model = s.lineModel(line.id);
    assert.ok(
      model[0].some(
        (part) =>
          part.type === 'text' &&
          part.text === 'user error' &&
          part.marks.includes('bold') &&
          part.marks.includes('underline'),
      ),
    );
    const first = model[0][0];
    if (first.type !== 'text') throw Error('Expected text');
    first.text = 'Usually it is ';
    s.setLine(line.id, model);
    assert.equal(s.count, 1);
    assert.match(
      s.content(),
      /Usually it is \*\*more than likely __user error__ or __cutting corners__\*\*/,
    );
    assert.ok(s.content().endsWith(`${eol}⬥ Untouched 🚀${eol}.tag:unchanged`));
    assert.match(s.content(), /<#656898197561802760>/);
    s.undo(line.id);
    assert.equal(s.content(), fixture.source);
  });

test('Enter continuation creates genuine same-level bullets while keeping nested source and immutable ranges', async () => {
  const fixture = await session(
      '⬥ Parent\r\n    • Child **formatted**\r\n    • Next child\r\n⬥ Last',
    ),
    s = fixture.session;
  const line = s.lines.find((line) => line.raw.startsWith('Child'))!;
  assert.equal(line.prefix, '    • ');
  const model = s.lineModel(line.id);
  model.push([]);
  s.setLine(line.id, model); // An empty new bullet is a valid unfinished draft.
  assert.ok(
    s.content().startsWith('⬥ Parent\r\n    • Child **formatted**\r\n    • '),
    'An unchanged original line retains its exact Markdown',
  );
  model[1] = [{ type: 'text', text: 'New 🚀 child', marks: [] }];
  s.setLine(line.id, model);
  assert.equal(s.originalContent, fixture.source);
  assert.equal(
    s.content(),
    '⬥ Parent\r\n    • Child **formatted**\r\n    • New 🚀 child\r\n    • Next child\r\n⬥ Last',
  );
  const doc = parseGuide(s.content());
  const list = doc.messages[0].blocks[0];
  assert.equal(list.type, 'list');
  if (list.type !== 'list') throw Error('Expected list');
  const nested = list.items[0].children.find((block) => block.type === 'list');
  assert.equal(nested?.type === 'list' && nested.items.length, 3);
});

for (const eol of ['\n', '\r\n'])
  test(`bullet indentation composes with text, links and draft restoration (${JSON.stringify(eol)})`, async () => {
    const source = [
      '⬥ Parent',
      '    • Child [label](https://example.com)',
      '        ⬩ Grandchild',
      '    • Sibling',
      '⬥ Last',
      '.tag:untouched',
    ].join(eol);
    const { session: s } = await session(source);
    const child = s.lines.find((line) => line.raw.startsWith('Child'))!;
    const grandchild = s.lines.find((line) => line.raw === 'Grandchild')!;
    const model = s.lineModel(child.id);
    if (model[0][0].type === 'text') model[0][0].text = 'Changed child ';
    model.push([{ type: 'text', text: 'New child', marks: ['bold'] }]);
    s.setChanges([
      s.lineChange(child.id, model, ['⬥ ', '    • ']),
      s.lineChange(grandchild.id, s.lineModel(grandchild.id), ['    • ']),
    ]);
    const label = s.map.entries.find((entry) => entry.kind === 'link-label')!;
    s.setChanges([{ entryId: label.id, replacement: 'updated' }]);
    const expected = [
      '⬥ Parent',
      '⬥ Changed child [updated](https://example.com)',
      '    • **New child**',
      '    • Grandchild',
      '    • Sibling',
      '⬥ Last',
      '.tag:untouched',
    ].join(eol);
    assert.equal(s.content(), expected);
    const store = new Map<string, string>();
    const drafts = new DraftStorage({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    });
    drafts.save(s);
    const { session: restored } = await session(source);
    assert.equal(drafts.restore(restored).status, 'restored');
    assert.equal(restored.content(), expected);
    restored.undo(child.id);
    assert.ok(
      restored.content().includes('    • Child [updated](https://example.com)'),
    );
    restored.discard();
    assert.equal(restored.content(), source);
  });

test('indentation validation rejects forged markers, controls, non-bullets and invalid row counts atomically', async () => {
  const { session: s } = await session(
    '⬥ Parent\n    • Child\nPlain paragraph',
  );
  const child = s.lines[1],
    plain = s.lines[2];
  s.setLine(child.id, s.lineModel(child.id), ['⬥ ']);
  assert.equal(s.content(), '⬥ Parent\n⬥ Child\nPlain paragraph');
  const valid = s.content();
  for (const prefixes of [
    ['    ⬥ '],
    ['            ⬩ '],
    ['    • \n.tag:bad'],
    [],
    [' '.repeat(1025) + '• '],
    [12] as unknown as string[],
  ]) {
    assert.throws(() =>
      s.setChanges([
        { kind: 'line', entryId: child.id, replacement: child.raw, prefixes },
      ]),
    );
    assert.equal(s.content(), valid);
  }
  assert.throws(() => s.setLine(plain.id, s.lineModel(plain.id), ['    ']));
  assert.equal(shiftBulletPrefix('    • ', true), '⬥ ');
  assert.equal(shiftBulletPrefix('• ', true), '• ');
  assert.equal(shiftBulletPrefix('⬥ ', false), '    • ');
});

for (const eol of ['\n', '\r\n'])
  test(`plain/bullet formatting reflows neighbouring paragraphs without changing their content (${JSON.stringify(eol)})`, async () => {
    const source = [
      'Before',
      '⬥ Parent [label](https://example.com)',
      '    • Child **bold**',
      '⬥ Next',
      'After',
    ].join(eol);
    const { session: s } = await session(source);
    const parent = s.lines.find((line) => line.raw.startsWith('Parent'))!;
    const child = s.lines.find((line) => line.raw.startsWith('Child'))!;
    s.setChanges([
      s.lineChange(parent.id, s.lineModel(parent.id), ['']),
      s.lineChange(child.id, s.lineModel(child.id), ['']),
    ]);
    assert.equal(
      s.content(),
      [
        'Before',
        'Parent [label](https://example.com)',
        'Child **bold**',
        '⬥ Next',
        'After',
      ].join(eol),
    );
    const label = s.map.entries.find((entry) => entry.kind === 'link-label')!;
    s.setChanges([{ entryId: label.id, replacement: 'changed label' }]);
    assert.ok(
      s.content().includes('Parent [changed label](https://example.com)'),
    );
    s.setLine(parent.id, s.lineModel(parent.id), [parent.prefix]);
    s.setLine(child.id, s.lineModel(child.id), [child.prefix]);
    assert.equal(s.content(), source.replace('[label]', '[changed label]'));
    s.undo(label.id);
    assert.equal(s.count, 0);
    const before = s.lines[0];
    s.setLine(before.id, s.lineModel(before.id), ['⬥ ']);
    assert.equal(s.content(), '⬥ ' + source);
    s.setLine(before.id, s.lineModel(before.id), ['']);
    assert.equal(s.content(), source);
    assert.equal(s.count, 0);
  });

test('a regular paragraph can contain mixed plain and bullet rows with validated draft restoration', async () => {
  const source = 'Start [label](https://example.com)\r\n\r\nUntouched';
  const { session: s } = await session(source);
  const line = s.lines[0],
    model = s.lineModel(line.id);
  model.push(
    [{ type: 'text', text: 'Bullet', marks: ['bold'] }],
    [{ type: 'text', text: 'Plain again', marks: [] }],
  );
  s.setLine(line.id, model, ['', '⬥ ', '']);
  const expected =
    'Start [label](https://example.com)\r\n⬥ **Bullet**\r\nPlain again\r\n\r\nUntouched';
  assert.equal(s.content(), expected);
  const { session: restored } = await session(source);
  restored.replaceChanges(JSON.parse(JSON.stringify(s.changes)));
  assert.equal(restored.content(), expected);
  assert.deepEqual(restored.linePrefixes(line.id), ['', '⬥ ', '']);
  assert.throws(() =>
    restored.setChanges([
      { kind: 'line', entryId: line.id, replacement: 'Text\n⬥ Injected' },
    ]),
  );
  assert.equal(restored.content(), expected);
});

test('removing list formatting cannot reinterpret source text as commands or nested syntax', async () => {
  for (const source of [
    '⬥ .tag:hidden\n⬥ Next',
    '⬥ ⬥ literal marker\n⬥ Next',
  ]) {
    const { session: s } = await session(source);
    const line = s.lines[0];
    assert.ok(line?.bullet);
    assert.throws(() => s.setLine(line.id, s.lineModel(line.id), ['']));
    assert.equal(s.content(), source);
    assert.equal(s.count, 0);
  }
});

test('one inline editor contains an entire list and shifts the selected parent with its children', async (t) => {
  const source = '⬥ Parent\n    • Child\n        ⬩ Grandchild\n⬥ Last';
  const fixture = await session(source),
    s = fixture.session;
  const { document, editor, root } = openRichEditor(fixture);
  const rows = [...root.querySelectorAll<HTMLElement>('[data-rich-row]')];
  assert.deepEqual(
    rows.map((row) => row.textContent),
    ['Parent', 'Child', 'Grandchild', 'Last'],
  );
  assert.ok(document.querySelector('[data-inline-list-hidden]'));
  rows[0].firstChild!.textContent = 'Changed parent';
  root.dispatchEvent(
    new document.defaultView!.Event('input', { bubbles: true }),
  );
  // Minimal selection mock: indentation keeps the native DOM and Range intact.
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
  mockSelection(t, document, range);
  const key = new document.defaultView!.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(key, { key: 'Tab', shiftKey: false });
  root.dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  assert.equal(s.content(), source.replace('Parent', 'Changed parent'));
  assert.equal(editor.root, root);
  // The subtree already reaches level three: Tab cannot create a fourth level.
  assert.equal(rows[1].style.marginInlineStart, '4ch');
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-bullet-indent="in"]')!
      .disabled,
    true,
  );
  const back = new document.defaultView!.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(back, { key: 'Tab', shiftKey: true });
  root.dispatchEvent(back);
  assert.equal(
    s.content(),
    '⬥ Changed parent\n⬥ Child\n    • Grandchild\n⬥ Last',
  );
  // Nesting the child back under Parent restores both descendant levels and symbols.
  editor.indent();
  assert.equal(s.content(), source.replace('Parent', 'Changed parent'));
  range.startContainer = rows[0].firstChild!;
  range.endContainer = rows[0].firstChild!;
  editor.indent();
  assert.equal(s.content(), source.replace('Parent', 'Changed parent'));
  editor.indent(true);
  assert.equal(s.content(), source.replace('Parent', 'Changed parent'));
  delete (document.defaultView as unknown as { getSelection?: unknown })
    .getSelection;
  assert.equal(editor.finish(), true);
  assert.equal(document.querySelector('[data-inline-list-hidden]'), null);
  assert.ok(document.querySelector('[data-list-draft-preview]'));
  editor.begin(document.querySelector('[data-source-line]')!);
  editor.indent();
  editor.cancel();
  assert.equal(s.content(), source.replace('Parent', 'Changed parent'));
});

test('line edits and independent link dialog changes compose in either order without ambiguous patches', async () => {
  for (const linkFirst of [false, true]) {
    const fixture = await session(
        '⬥ Before [label](<https://example.com/a_(b)> "keep") after\n⬥ Elsewhere',
      ),
      s = fixture.session;
    const line = s.lines[0],
      label = s.map.entries.find((entry) => entry.kind === 'link-label')!,
      url = s.map.entries.find((entry) => entry.kind === 'link-url')!;
    const changeLink = () =>
      s.setChanges([
        { entryId: label.id, replacement: 'Longer label' },
        { entryId: url.id, replacement: 'https://new.example/long_(path)' },
      ]);
    if (linkFirst) changeLink();
    const model = s.lineModel(line.id);
    if (model[0][0].type === 'text') model[0][0].text = 'Revised ';
    s.setLine(line.id, model);
    if (!linkFirst) changeLink();
    assert.equal(
      s.content(),
      '⬥ Revised [Longer label](<https://new.example/long_(path)> "keep") after\n⬥ Elsewhere',
    );
    s.undo(url.id);
    assert.match(s.content(), /https:\/\/example.com\/a_\(b\)/);
    assert.match(s.content(), /Revised/);
  }
});

test('whole-line draft persistence restores new bullets and formatting with fresh parser validation', async () => {
  const fixture = await session(`⬥ ${example}\n⬥ Next`),
    s = fixture.session,
    line = s.lines[0];
  const model = s.lineModel(line.id);
  model.push([{ type: 'text', text: 'New bullet', marks: ['bold'] }]);
  s.setLine(line.id, model);
  const data = new Map<string, string>();
  const storage = new DraftStorage({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  });
  storage.save(s);
  const restored = (await session(fixture.source)).session;
  assert.equal(storage.restore(restored).status, 'restored');
  assert.equal(restored.content(), s.content());
  restored.discard();
  assert.equal(restored.content(), fixture.source);
});

test('raw stored line drafts cannot add commands, embeds, links, new headings or remove protected objects', async () => {
  const fixture = await session(`⬥ ${example}\n⬥ Untouched`),
    s = fixture.session,
    line = s.lines[0];
  const valid = s.lineModel(line.id);
  if (valid[0][0].type === 'text') valid[0][0].text = 'Changed ';
  s.setLine(line.id, valid);
  const previous = s.content();
  for (const replacement of [
    'changed\n.tag:injected',
    'changed\n⬥ # Heading',
    'changed [new](https://example.com)',
    'changed\n⬥ {"title":"bad"}\n.embed:json',
    line.raw.replace('<#656898197561802760>', ''),
    line.raw + '\n⬥ ```js',
  ]) {
    assert.throws(
      () => s.setChanges([{ kind: 'line', entryId: line.id, replacement }]),
      replacement,
    );
    assert.equal(s.content(), previous);
  }
  const removed = s.lineModel(line.id);
  removed[0] = removed[0].filter((part) => part.type !== 'token');
  assert.throws(() => s.setLine(line.id, removed));
  assert.equal(s.content(), previous);
});

test('plain pasted Markdown/HTML remains literal text and source syntax outside the line stays identical', async () => {
  const fixture = await session(
      '⬥ old\n⬥ next\n.img:https://example.com/image.png',
    ),
    s = fixture.session,
    line = s.lines[0];
  const replacement = '<script>alert(1)</script> **literal** $linkmsg_new$';
  s.setLine(line.id, [[{ type: 'text', text: replacement, marks: [] }]]);
  const rendered = renderGuide(
    s.content(),
    { methods: [], sections: [] },
    '',
    {},
  );
  const document = parseHTML(rendered.html).document;
  assert.equal(document.querySelector('script'), null);
  assert.equal(document.querySelector('li p')!.textContent, replacement);
  assert.ok(
    s.content().endsWith('\n⬥ next\n.img:https://example.com/image.png'),
  );
});

test('inline UI groups the example into one editable line and retains protected Discord/emoji DOM', async () => {
  const fixture = await session(`⬥ ${example} <:magic:123>\n⬥ Next`),
    s = fixture.session;
  const { document, window } = parseHTML(
    `<article data-guide-source="test.txt" data-guide-source-hash="${s.sourceHash}">${fixture.rendered.html}</article>`,
  );
  const refresh = () => updateDraftPreview(document, s, true);
  refresh();
  const wrapper = document.querySelector<HTMLElement>('[data-source-line]')!;
  assert.ok(wrapper.querySelectorAll('[data-edit-ref]').length >= 6);
  assert.equal(wrapper.parentElement!.tagName, 'P');
  const editor = new RichLineEditor(document, () => s, refresh);
  editor.begin(wrapper);
  const root = document.querySelector<HTMLElement>('.inline-line-input')!;
  assert.ok(root.querySelector('strong u'));
  assert.ok(root.querySelector('img.emoji'));
  assert.ok(root.querySelector('[data-line-token] a'));
  assert.equal(document.querySelectorAll('[data-format-mark]').length, 4);
  const text = root.querySelector('[data-rich-row]')!.firstChild!;
  text.textContent = 'Usually it is ';
  root.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(s.count, 1);
  assert.match(s.content(), /Usually it is/);
  editor.cancel();
  assert.equal(s.count, 0);
  assert.equal(s.content(), fixture.source);
  refresh();
  updateDraftPreview(document, s, false);
  assert.equal(document.querySelector('[data-source-line]'), null);
});

test('multiline paragraphs stay split by original source line and formatting tools round-trip', async () => {
  const fixture = await session('First **line**\nSecond __line__'),
    s = fixture.session;
  assert.equal(s.lines.length, 2);
  const { document } = parseHTML(
    `<article data-guide-source="test.txt" data-guide-source-hash="${s.sourceHash}">${fixture.rendered.html}</article>`,
  );
  updateDraftPreview(document, s, true);
  assert.equal(document.querySelectorAll('[data-source-line]').length, 2);
  const line = s.lines[1];
  const model: RichLine = [
    [
      { type: 'text', text: 'Second ', marks: [] },
      { type: 'text', text: 'line', marks: ['bold', 'italic', 'underline'] },
    ],
  ];
  const raw = writeRichLine(line, model, (token) => token.raw);
  assert.deepEqual(
    readRichLine(line, raw, (token) => token.raw),
    normalizeRichLine(model),
  );
  s.setLine(line.id, model);
  assert.ok(s.content().startsWith('First **line**\n'));
  s.setLine(line.id, [
    ...model,
    [{ type: 'text', text: 'New plain line', marks: [] }],
  ]);
  assert.ok(s.content().endsWith('\nNew plain line'));
});

test('controlled DOM reader rejects HTML elements and treats protected objects as atomic', () => {
  const { document } = parseHTML(
    '<span id="editor"><span data-rich-row><strong>Text</strong><span data-line-token="token"><a href="https://example.com">Link</a></span></span></span>',
  );
  assert.deepEqual(readEditorModel(document.getElementById('editor')!), [
    [
      { type: 'text', text: 'Text', marks: ['bold'] },
      { type: 'token', id: 'token', marks: [] },
    ],
  ]);
  document.getElementById('editor')!.append(document.createElement('script'));
  assert.throws(() => readEditorModel(document.getElementById('editor')!));
});

test('formatting selection edges containing spaces are normalised without losing text', async () => {
  const fixture = await session('⬥ first second'),
    s = fixture.session,
    line = s.lines[0];
  const model: RichLine = [
    [
      { type: 'text', text: 'first ', marks: [] },
      { type: 'text', text: 'second ', marks: ['bold', 'underline'] },
    ],
  ];
  s.setLine(line.id, model);
  const rendered = renderGuide(
    s.content(),
    { methods: [], sections: [] },
    '',
    {},
  );
  const document = parseHTML(rendered.html).document;
  assert.equal(document.querySelector('li p')!.textContent, 'first second ');
  assert.equal(document.querySelector('strong u')!.textContent, 'second');
});

test('hidden references do not consume the visible link object in the same line', async () => {
  const fixture = await session(
    '⬥ Before $data_pvme:Sheet!A1$ [label](https://example.com) after',
  );
  const { document } = openRichEditor(fixture);
  const chips = [...document.querySelectorAll('[data-line-token]')];
  assert.equal(chips[0].querySelector('a'), null);
  assert.equal(chips[1].querySelector('a')!.textContent, 'label');
});

test('empty continuation rows are caret-ready even when splitting leaves empty formatting wrappers', () => {
  const { document } = parseHTML(
    '<span id="row"><strong><em></em></strong></span>',
  );
  const row = document.getElementById('row')!;
  ensureEditableRow(row);
  assert.equal(row.childNodes.length, 1);
  assert.ok(row.querySelector('br[data-line-placeholder]'));
  assert.equal(row.querySelector('strong'), null);
  ensureEditableRow(row);
  assert.equal(row.querySelectorAll('br').length, 1);
  row.prepend(document.createTextNode('Typed text'));
  ensureEditableRow(row);
  assert.equal(row.textContent, 'Typed text');
});

test('Done retains continuation rows in their original flow before the next source block', async () => {
  const fixture = await session('⬥ **First bullet**\n⬥ Next block'),
    s = fixture.session;
  const { document } = parseHTML(
    `<article data-guide-source="test.txt" data-guide-source-hash="${s.sourceHash}">${fixture.rendered.html}</article>`,
  );
  const refresh = () => updateDraftPreview(document, s, true);
  refresh();
  const first = document.querySelector<HTMLElement>('[data-source-line]')!;
  const editor = new RichLineEditor(document, () => s, refresh);
  editor.begin(first);
  const root = editor.root!;
  const next = document.createElement('span');
  next.dataset.richRow = '';
  next.dataset.continuationBullet = '⬥';
  next.textContent = 'Typed continuation';
  root.querySelector('[data-rich-row]')!.after(next);
  assert.equal(editor.finish(), true);
  const wrappers = [...document.querySelectorAll('[data-source-line]')];
  assert.equal(wrappers[0], first);
  assert.ok(
    first.hasAttribute('data-multiline-draft'),
    'The entire multi-row draft must form its own layout block',
  );
  assert.deepEqual(
    [...first.querySelectorAll('[data-rich-row]')].map(
      (row) => row.textContent,
    ),
    ['First bullet', 'Typed continuation'],
  );
  assert.equal(wrappers[1].textContent, 'Next block');
  assert.equal(
    s.content(),
    '⬥ **First bullet**\n⬥ Typed continuation\n⬥ Next block',
  );
  assert.equal(document.querySelector('.inline-line-input'), null);
});

test('small text edits preserve untouched punctuation, original escapes and formatting byte for byte', async () => {
  for (const eol of ['\n', '\r\n']) {
    for (const first of [
      'Cooldown: 3t (seconds), [notes]; cost: 20%.',
      '## Cooldown: **3t** (seconds), [notes]; cost: 20%.',
      '⬥ Cooldown: __3t__ (seconds), [notes]; cost: 20%.',
      'Cooldown\\: **3t** (seconds), \\[notes\\]; cost: 20%.',
      'Cooldown: **3t** (seconds), [guide](https://example.com/a); cost: 20%.',
    ]) {
      const source =
        first + eol + '.' + eol + 'Untouched: [brackets], punctuation!';
      const { session: s } = await session(source);
      const line = s.lines[0];
      const model = s.lineModel(line.id);
      for (const part of model[0])
        if (part.type === 'text') part.text = part.text.replace('3t', '6t');
      s.setLine(line.id, model);
      const expected = source.replace('3t', '6t');
      assert.equal(s.content(), expected);
      const { session: restored } = await session(source);
      restored.replaceChanges(s.changes);
      assert.equal(restored.content(), expected);
    }
  }
});

test('only newly inserted syntax is escaped when needed to retain literal text', async () => {
  const source = 'Cooldown: 3t (seconds), [notes]; cost: 20%.';
  const { session: s } = await session(source);
  const line = s.lines[0];
  const model = s.lineModel(line.id);
  const part = model[0][0];
  assert.equal(part.type, 'text');
  if (part.type !== 'text') return;
  part.text = part.text.replace('3t', '**6t**');
  s.setLine(line.id, model);
  assert.equal(s.content(), source.replace('3t', '\\*\\*6t\\*\\*'));
  assert.deepEqual(s.lineModel(line.id), normalizeRichLine(model));
});

test('Discord heading markers stay in source while inline editing only exposes the title', async () => {
  for (const title of [
    '# > Plain title',
    '## > __Core Magic Rotation__',
    '### > **Bold** and plain',
  ]) {
    const source = title + '\r\n.\r\nUntouched';
    const f = await session(source);
    const s = f.session;
    const line = s.lines.find((item) => item.kind === 'heading')!;
    assert.equal(line.botPrefix, '> ');
    const model = s.lineModel(line.id);
    assert.ok(!JSON.stringify(model).includes('> '));
    const unchanged = writeRichLine(line, model, (token) => token.raw);
    assert.equal(unchanged, line.raw);
    const first = model[0].find((part) => part.type === 'text')!;
    if (first.type !== 'text') throw new Error('Missing title text');
    const old = first.text;
    first.text += ' revised';
    s.setLine(line.id, model);
    assert.equal(s.content(), source.replace(old, old + ' revised'));
    const { session: restored } = await session(source);
    restored.replaceChanges(s.changes);
    assert.equal(restored.content(), s.content());
    first.marks = first.marks.includes('italic') ? [] : ['italic'];
    s.setLine(line.id, model);
    assert.ok(s.content().includes('> '));
    assert.ok(!JSON.stringify(s.lineModel(line.id)).includes('> '));
  }
});

test('Tab and Shift+Tab use exactly three canonical bullet styles and stop at both limits', async (t) => {
  const source = '⬥ Anchor\n    • Previous child\n⬥ Item';
  const f = await session(source);
  const s = f.session;
  const { document, window, editor, root } = openRichEditor(f);
  const rows = [...root.querySelectorAll<HTMLElement>('[data-rich-row]')];
  const row = rows.at(-1)!;
  const range = {
    startContainer: row.firstChild!,
    endContainer: row.firstChild!,
    commonAncestorContainer: root,
    collapsed: true,
    startOffset: 0,
    endOffset: 0,
    cloneRange() {
      return this;
    },
  };
  mockSelection(t, document, range);
  const tab = (out = false) => {
    const event = new window.Event('keydown', {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key: 'Tab', shiftKey: out });
    root.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  tab();
  assert.ok(s.content().endsWith('    • Item'));
  assert.equal(row.dataset.continuationBullet, '•');
  tab();
  assert.ok(s.content().endsWith('        ⬩ Item'));
  assert.equal(row.dataset.continuationBullet, '⬩');
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-bullet-indent="in"]')!
      .disabled,
    true,
  );
  tab();
  assert.ok(s.content().endsWith('        ⬩ Item'));
  tab(true);
  assert.ok(s.content().endsWith('    • Item'));
  tab(true);
  assert.ok(s.content().endsWith('⬥ Item'));
  tab(true);
  assert.equal(s.content(), source);
  assert.equal(
    document.querySelector<HTMLButtonElement>('[data-bullet-indent="out"]')!
      .disabled,
    true,
  );
  editor.cancel();
});

test('removing a parent bullet promotes its children to valid levels and preserves their text', async () => {
  const source = '⬥ Parent\n    • Child **bold**\n        ⬩ Grandchild\n⬥ Last';
  const f = await session(source);
  const s = f.session;
  const { editor } = openRichEditor(f);
  editor.toggleBullet();
  assert.equal(
    s.content(),
    'Parent\n⬥ Child **bold**\n    • Grandchild\n⬥ Last',
  );
  editor.toggleBullet();
  assert.equal(s.content(), source);
  editor.cancel();
  assert.equal(s.content(), source);
});

test('Backspace deletes an empty bullet row and preserves neighbouring text and draft restoration', async (t) => {
  const source = '⬥ First\r\n⬥ Remove me\r\n⬥ Last';
  const f = await session(source);
  const s = f.session;
  const { document, window, editor, root } = openRichEditor(f);
  const rows = [...root.querySelectorAll<HTMLElement>('[data-rich-row]')];
  const row = rows[1];
  row.textContent = '';
  ensureEditableRow(row);
  root.dispatchEvent(new window.Event('input', { bubbles: true }));
  const range = {
    startContainer: row,
    endContainer: row,
    commonAncestorContainer: root,
    collapsed: true,
    startOffset: 0,
    endOffset: 0,
    cloneRange() {
      return this;
    },
  };
  mockSelection(t, document, range, true);
  const key = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(key, { key: 'Backspace' });
  root.dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  assert.equal(root.querySelectorAll('[data-rich-row]').length, 2);
  assert.equal(s.content(), '⬥ First\r\n⬥ Last');
  const { session: restored } = await session(source);
  restored.replaceChanges(s.changes);
  assert.equal(restored.content(), s.content());
  editor.cancel();
  assert.equal(s.content(), source);
});

test('Backspace also removes newly added empty continuation bullets', async (t) => {
  const f = await session('⬥ First\n⬥ Last');
  const s = f.session;
  const { document, window, editor, root } = openRichEditor(f);
  const first = root.querySelector<HTMLElement>('[data-rich-row]')!;
  const row = document.createElement('span');
  row.dataset.richRow = '';
  row.dataset.lineOwner = first.dataset.lineOwner;
  row.dataset.bulletPrefix = '⬥ ';
  ensureEditableRow(row);
  first.after(row);
  root.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(root.querySelectorAll('[data-rich-row]').length, 3);
  const range = {
    startContainer: row,
    endContainer: row,
    commonAncestorContainer: root,
    collapsed: true,
    startOffset: 0,
    endOffset: 0,
    cloneRange() {
      return this;
    },
  };
  mockSelection(t, document, range, true);
  const event = new window.Event('beforeinput', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(event, {
    inputType: 'deleteContentBackward',
    isComposing: false,
  });
  root.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(root.querySelectorAll('[data-rich-row]').length, 2);
  assert.equal(s.content(), '⬥ First\n⬥ Last');
  assert.equal(document.querySelector('[data-format-mark="spoiler"]'), null);
  assert.equal(
    document.querySelectorAll('[data-format-bullet] svg circle').length,
    3,
  );
  editor.cancel();
});

test('selected text becomes a new link without changing adjacent formatting or protected links', async () => {
  const source = 'See **word**: [existing](https://old.example), untouched.';
  const f = await session(source);
  const s = f.session;
  const line = s.lines[0];
  const model = linkSelection(
    s.lineModel(line.id),
    4,
    8,
    'https://new.example/path(a)',
  );
  s.setLine(line.id, model);
  const expected =
    'See **[word](<https://new.example/path(a)>)**: [existing](https://old.example), untouched.';
  assert.equal(s.content(), expected);
  assert.deepEqual(s.lineModel(line.id), model);
  const { session: restored } = await session(source);
  restored.replaceChanges(JSON.parse(JSON.stringify(s.changes)));
  assert.equal(restored.content(), expected);
  assert.deepEqual(restored.lineModel(line.id), model);
  const existingLabel = restored.map.entries.find(
    (entry) => entry.kind === 'link-label',
  )!;
  restored.setChanges([{ entryId: existingLabel.id, replacement: 'renamed' }]);
  assert.equal(restored.content(), expected.replace('[existing]', '[renamed]'));
  const extended = restored.lineModel(line.id);
  if (extended[0].at(-1)?.type === 'text')
    (extended[0].at(-1) as { text: string }).text += ' More.';
  restored.setLine(line.id, extended);
  assert.ok(
    restored.content().includes('[word](<https://new.example/path(a)>)'),
  );
  restored.undo(line.id);
  assert.equal(restored.content(), source.replace('[existing]', '[renamed]'));
});

test('new links work in headings and embed text fragments while unsafe destinations are rejected', async () => {
  for (const source of ['## > Heading word', 'Embed description word']) {
    const { session: s } = await session(source);
    const line = s.lines[0];
    const model = s.lineModel(line.id);
    const length = model[0].reduce(
      (sum, part) => sum + (part.type === 'text' ? part.text.length : 1),
      0,
    );
    s.setLine(
      line.id,
      linkSelection(model, length - 4, length, 'https://example.com'),
    );
    assert.ok(s.content().includes('[word](<https://example.com>)'));
    if (source.startsWith('##')) assert.ok(s.content().startsWith('## > '));
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'https://bad.example/\n.inject',
    ])
      assert.throws(() => linkSelection(model, length - 4, length, url));
  }
});

test('Link toolbar creates a link from selected text, rejects unsafe URLs and keeps the inline editor open', async (t) => {
  const f = await session('Select word here.');
  const s = f.session;
  const { document, window, editor, root } = openRichEditor(f);
  const text = root.querySelector('[data-rich-row]')!.firstChild!;
  const range = {
    startContainer: text,
    endContainer: text,
    commonAncestorContainer: root,
    collapsed: false,
    startOffset: 7,
    endOffset: 11,
    cloneRange() {
      return this;
    },
  };
  mockSelection(t, document, range);
  Object.defineProperty(document, 'createRange', {
    configurable: true,
    value: () => {
      let end = 0;
      return {
        selectNodeContents() {},
        setStart() {},
        setEnd(_node: Node, offset: number) {
          end = offset;
        },
        collapse() {},
        cloneRange() {
          return this;
        },
        cloneContents() {
          const fragment = document.createDocumentFragment();
          fragment.append(
            document.createTextNode('Select word here.'.slice(0, end)),
          );
          return fragment;
        },
      };
    },
  });
  const clickLink = () =>
    document
      .querySelector('[data-format-link]')!
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  clickLink();
  const form = document.querySelector<HTMLFormElement>('[data-link-create]')!;
  assert.ok(form);
  const input = form.querySelector<HTMLInputElement>('input')!;
  input.value = 'javascript:alert(1)';
  form.dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  assert.match(
    form.querySelector('[role="alert"]')!.textContent!,
    /valid http/,
  );
  assert.equal(s.content(), 'Select word here.');
  input.value = 'https://example.com';
  form.dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  assert.equal(s.content(), 'Select [word](<https://example.com>) here.');
  assert.equal(editor.root, root);
  assert.equal(root.querySelector('a')!.textContent, 'word');
  assert.equal(document.querySelector('[data-link-create]'), null);
  editor.editCreatedLink(root.querySelector('a')!);
  const update = document.querySelector<HTMLFormElement>('[data-link-create]')!;
  update.querySelector<HTMLInputElement>('input')!.value =
    'https://updated.example';
  update.dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  );
  assert.equal(s.content(), 'Select [word](<https://updated.example>) here.');
  editor.cancel();
  assert.equal(s.content(), 'Select word here.');
});
