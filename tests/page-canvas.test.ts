import { createTestGuide, settle, click, mockSelection } from './helpers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { parseGuide } from '@pvme/guide-parser';
import { DraftStorage } from '../src/lib/draft-storage';
import {
  canvasBlocks,
  canvasMessages,
  blockFields,
  changeBlockField,
  replaceCanvasBlock,
  insertCanvasBlock,
  moveCanvasBlock,
  canvasTemplate,
  canvasPalette,
  validatePageSource,
} from '../src/lib/page-canvas';
import { renderCanvasPreview } from '../src/scripts/canvas-preview';
import { PageCanvasEditor } from '../src/scripts/page-canvas-editor';
import { preserveSourceLineEndings } from '../src/lib/source-diff';
import { newEmojiToken } from '../src/lib/emoji-token';

const session = async (source: string) =>
  (await createTestGuide(source, 'test/canvas.txt')).session;
const embed = (eol = '\n') =>
  [
    '.',
    '{',
    '  "content": "Intro",',
    '  "embed": {"title":"Original title","description":"Text with } and \\"quotes\\"", "image":{"url":"https://example.com/old.png"}, "fields":[{"name":"Field","value":"Body","inline":true}], "custom":{"keep":42}}',
    '}',
    '.embed:json',
    '.tag:keep',
    '.',
  ].join(eol);
async function fixture(source: string, hub = false) {
  const s = await session(source);
  const { document, window } = parseHTML(
    '<html><body><article id="guide"><p>Original reading view</p></article></body></html>',
  );
  let changed = 0;
  if (hub) document.getElementById('guide')!.classList.add('hub-page');
  const canvas = new PageCanvasEditor(
    document,
    document.getElementById('guide')!,
    s,
    () => {
      changed++;
    },
  );
  return {
    s,
    canvas,
    document,
    window,
    click: (selector: string) => click(document, selector),
    get changed() {
      return changed;
    },
  };
}

for (const eol of ['\n', '\r\n'])
  test(`canvas source coverage retains metadata, embeds, media, commands and gaps (${JSON.stringify(eol)})`, () => {
    const source = [
      '---',
      'name: Example',
      '---',
      '# Guide',
      '',
      '⬥ Parent',
      '    • Child',
      '.',
      '.img:https://example.com/image.png',
      '.',
      embed(eol),
      '[Preset](https://presets.pvme.io/?id=abc)',
      '[Video](https://youtu.be/abc)',
      '```js',
      'code()',
      '```',
    ].join(eol);
    const blocks = canvasBlocks(source);
    assert.ok(blocks.some((block) => block.kind === 'settings'));
    assert.equal(blocks.filter((block) => block.kind === 'embed').length, 1);
    assert.equal(blocks.filter((block) => block.kind === 'image').length, 1);
    assert.ok(blocks.some((block) => block.kind === 'preset'));
    assert.ok(blocks.some((block) => block.kind === 'video'));
    assert.ok(blocks.some((block) => block.kind === 'code'));
    let cursor = 0,
      reconstructed = '';
    for (const block of blocks) {
      assert.ok(block.start >= cursor);
      assert.equal(block.source, source.slice(block.start, block.end));
      reconstructed += source.slice(cursor, block.start) + block.source;
      cursor = block.end;
    }
    reconstructed += source.slice(cursor);
    assert.equal(reconstructed, source);
    assert.equal(validatePageSource(source, source), source);
  });

test('embed properties edit nested text/images while retaining wrappers, custom JSON, tags and CRLF', () => {
  const source = embed('\r\n');
  let block = canvasBlocks(source).find((block) => block.kind === 'embed')!;
  const title = blockFields(block).find(
    (field) => field.path?.join('.') === 'embed.title',
  )!;
  let updated = replaceCanvasBlock(
    source,
    block,
    changeBlockField(block, title, 'Updated <title>'),
  );
  block = canvasBlocks(updated).find((block) => block.kind === 'embed')!;
  const image = blockFields(block).find(
    (field) => field.path?.join('.') === 'embed.image.url',
  )!;
  updated = replaceCanvasBlock(
    updated,
    block,
    changeBlockField(block, image, 'https://example.com/new.png'),
  );
  const value = parseGuide(updated).embeds[0].value as any;
  assert.equal(value.embed.title, 'Updated <title>');
  assert.equal(value.embed.image.url, 'https://example.com/new.png');
  assert.equal(value.embed.custom.keep, 42);
  assert.equal(value.embed.fields[0].inline, true);
  assert.ok(updated.includes('.tag:keep\r\n.'));
  assert.doesNotMatch(updated.replace(/\r\n/g, ''), /\n/);
  assert.equal(validatePageSource(source, updated), updated);
  const boolean = blockFields(block).find((field) => field.type === 'boolean')!;
  assert.throws(() => changeBlockField(block, boolean, 'maybe'));
});

test('image, attachment, preset and video URLs and labels have independent editable source fields', () => {
  for (const source of [
    '![alt](https://example.com/old.png)',
    '.img:https://example.com/old.png',
    '[preset](<https://presets.pvme.io/?id=old> "keep title")',
    '[video](https://youtu.be/old)',
  ]) {
    const block = canvasBlocks(source).find((block) =>
      blockFields(block).some((field) => field.type === 'url'),
    )!;
    const url = blockFields(block).find((field) => field.type === 'url')!;
    const updated = changeBlockField(block, url, 'https://example.com/updated');
    assert.ok(updated.includes('https://example.com/updated'));
    if (source.includes('keep title'))
      assert.ok(updated.includes('"keep title"'));
    assert.throws(() => changeBlockField(block, url, 'javascript:alert(1)'));
    assert.equal(
      parseGuide(updated).diagnostics.filter(
        (item) => item.severity === 'error',
      ).length,
      0,
    );
  }
});

test('all palette types insert valid sections and JSON embeds have isolated message envelopes', () => {
  const source = '# Guide\r\n\r\nOriginal';
  for (const kind of canvasPalette) {
    const updated = insertCanvasBlock(
      source,
      source.length,
      canvasTemplate(kind, source),
    );
    assert.equal(validatePageSource(source, updated), updated, kind);
    assert.ok(updated.startsWith(source));
    assert.doesNotMatch(updated.replace(/\r\n/g, ''), /\n/);
    if (kind === 'embed')
      assert.equal(parseGuide(updated).embeds[0].valid, true);
  }
});

test('block moves retain source and embeds remain valid outside their original message', () => {
  const source = '# One\n\nFirst\n\n# Two\n\nSecond';
  const last = canvasBlocks(source).at(-1)!;
  const moved = moveCanvasBlock(source, last, 0);
  assert.ok(moved.startsWith('Second'));
  assert.equal((moved.match(/Second/g) || []).length, 1);
  assert.ok(moved.includes('# One\n\nFirst\n\n# Two'));
  const withEmbed = source + '\n\n' + embed();
  const block = canvasBlocks(withEmbed).find(
    (block) => block.kind === 'embed',
  )!;
  const changed = moveCanvasBlock(withEmbed, block, 0);
  assert.equal(validatePageSource(withEmbed, changed), changed);
  assert.equal(parseGuide(changed).embeds.length, 1);
});

test('page snapshots compose prior inline edits and restore through verified draft storage', async () => {
  const source = '# Guide\nOriginal';
  const s = await session(source);
  const entry = s.map.entries.find((entry) => entry.value === 'Original')!;
  s.setChanges([{ entryId: entry.id, replacement: 'Edited text' }]);
  const content = insertCanvasBlock(
    s.content(),
    s.content().length,
    '## New section',
  );
  s.setDocument(content);
  assert.equal(s.count, 1);
  assert.equal(s.changes[0].kind, 'document');
  assert.equal(s.content(), content);
  const data = new Map<string, string>();
  const drafts = new DraftStorage({
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  });
  drafts.save(s);
  const restored = await session(source);
  assert.equal(drafts.restore(restored).status, 'restored');
  assert.equal(restored.content(), content);
  assert.throws(() =>
    restored.setDocument(content + '\n.\n{bad json}\n.embed:json'),
  );
  assert.equal(restored.content(), content);
  assert.throws(() =>
    restored.replaceChanges([
      { kind: 'document', entryId: 'wrong', replacement: '' },
    ]),
  );
  assert.equal(restored.content(), content);
  restored.undo('document');
  assert.equal(restored.content(), source);
  assert.equal(restored.count, 0);
});

test('canvas insertion, property changes, undo and redo update the shared session', async () => {
  const f = await fixture('# Guide');
  f.click('[data-canvas-drop]');
  f.click('[data-canvas-new="image"]');
  const url = f.document.querySelector<HTMLInputElement>(
    '[data-canvas-field]',
  )!;
  assert.equal(url.value, 'https://example.com/image.png');
  url.value = 'https://example.com/changed.png';
  url.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(
    f.canvas.finish(),
    false,
    'Unapplied inspector changes cannot disappear on exit',
  );
  f.document
    .querySelector('form[data-canvas-properties-form]')!
    .dispatchEvent(
      new f.window.Event('submit', { bubbles: true, cancelable: true }),
    );
  assert.ok(f.s.content().includes('changed.png'));
  assert.equal(f.canvas.finish(), true);
  f.click('[data-canvas-undo]');
  assert.ok(f.s.content().includes('https://example.com/image.png'));
  f.click('[data-canvas-redo]');
  assert.ok(f.s.content().includes('changed.png'));
  assert.ok(f.changed >= 4);
  f.canvas.close();
  assert.equal(f.document.querySelector('[data-page-canvas]'), null);
  assert.equal(
    f.document.getElementById('guide')!.hasAttribute('data-canvas-active'),
    false,
  );
});

test('insertion menus are contextual, keyboard dismissible, and insert at their own position', async () => {
  const f = await fixture('# First\n\nLast paragraph');
  assert.equal(f.document.querySelector('.canvas-palette'), null);
  assert.equal(f.document.querySelector('[data-canvas-new]'), null);
  assert.equal(
    f.document.querySelector<HTMLElement>('.canvas-properties')!.hidden,
    true,
  );
  const zones = [...f.document.querySelectorAll('[data-canvas-drop]')];
  zones
    .at(-1)!
    .dispatchEvent(
      new f.window.Event('click', { bubbles: true, cancelable: true }),
    );
  const menu = f.document.querySelector<HTMLElement>(
    '[data-canvas-insert-menu]',
  )!;
  assert.equal(menu.hidden, false);
  const escape = new f.window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(escape, { key: 'Escape' });
  menu.querySelector('button')!.dispatchEvent(escape);
  assert.equal(menu.hidden, true);
  assert.equal(zones.at(-1)!.getAttribute('aria-expanded'), 'false');
  zones
    .at(-1)!
    .dispatchEvent(
      new f.window.Event('click', { bubbles: true, cancelable: true }),
    );
  f.click('[data-canvas-new="heading"]');
  assert.ok(f.s.content().startsWith('# First\n\nLast paragraph'));
  assert.ok(f.s.content().endsWith('## New section'));
  assert.equal(f.document.querySelector('[data-canvas-insert-menu]'), null);
  assert.equal(
    f.document.querySelector<HTMLElement>('.canvas-properties')!.hidden,
    true,
  );
});

test('hidden commands, separators and suppressed content share one insertion boundary per visible gap', async () => {
  const source =
    '---\nname: Example\n---\n# Document\n.\n.\n## First\n.tag:first\nFirst paragraph\n.\n.\n## Second\n.tag:second\nSecond paragraph\n.\n{"embed":{"title":"Table of Contents","description":"Generated"}}\n.embed:json\n.pin:delete';
  const f = await fixture(source, true);
  const offsets = [
    ...f.document.querySelectorAll<HTMLElement>('[data-canvas-drop]'),
  ].map((zone) => Number(zone.dataset.canvasDrop));
  assert.deepEqual(
    offsets,
    ['## First', '## Second']
      .map(
        (text) =>
          canvasMessages(source).find((message) =>
            message.source.includes(text),
          )!.start,
      )
      .concat(source.length),
  );
  assert.equal(f.s.content(), source);
  f.click(
    `[data-canvas-drop="${canvasMessages(source).find((message) => message.source.includes('## Second'))!.start}"]`,
  );
  f.click('[data-canvas-new="text"]');
  assert.ok(f.s.content().includes('.tag:first\nFirst paragraph\n.\n.\n'));
  assert.ok(
    /Write your text here\.\n+## Second\n.tag:second/.test(f.s.content()),
  );
  f.click('[data-canvas-undo]');
  assert.equal(f.s.content(), source);
  const mixed = await fixture(
    '.\n{"embeds":[{"title":"Table of Contents"},{"description":"Visible content"}]}\n.embed:json',
  );
  assert.equal(mixed.document.querySelectorAll('[data-canvas-drop]').length, 2);
});

test('text editing hides properties while explicit properties open a dismissible contextual panel', async () => {
  const f = await fixture('Regular **text**');
  f.click('[data-canvas-preview]');
  await settle();
  assert.ok(f.document.querySelector('.inline-line-input'));
  assert.equal(
    f.document.querySelector<HTMLElement>('.canvas-properties')!.hidden,
    true,
  );
  f.click('[data-line-done]');
  await settle();
  const properties = [
    ...f.document.querySelectorAll('.canvas-block-tools button'),
  ].find((button) => button.textContent === 'Settings')!;
  properties.dispatchEvent(
    new f.window.Event('click', { bubbles: true, cancelable: true }),
  );
  assert.equal(
    f.document.querySelector<HTMLElement>('.canvas-properties')!.hidden,
    false,
  );
  const panel = f.document.querySelector<HTMLElement>('.canvas-properties')!;
  assert.ok(
    parseFloat(panel.style.top) + parseFloat(panel.style.maxHeight) <=
      (f.window.innerHeight || 800),
  );
  f.click('[aria-label="Close properties"]');
  assert.equal(
    f.document.querySelector<HTMLElement>('.canvas-properties')!.hidden,
    true,
  );
});

test('palette drag/drop creates a new section at the chosen position and existing blocks reorder', async () => {
  const f = await fixture('# Existing\n\nLast paragraph');
  f.click('[data-canvas-drop]');
  const data = new Map<string, string>();
  const transfer = {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) || '',
    effectAllowed: '',
  };
  const drag = new f.window.Event('dragstart', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(drag, { dataTransfer: transfer });
  f.document.querySelector('[data-canvas-new="heading"]')!.dispatchEvent(drag);
  const drop = new f.window.Event('drop', { bubbles: true, cancelable: true });
  Object.assign(drop, { dataTransfer: transfer });
  f.document.querySelector('[data-canvas-drop]')!.dispatchEvent(drop);
  assert.ok(f.s.content().startsWith('## New section'));
  const cards = [...f.document.querySelectorAll('[data-canvas-block]')];
  const move = new f.window.Event('dragstart', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(move, { dataTransfer: transfer });
  cards.at(-1)!.querySelector('button[draggable]')!.dispatchEvent(move);
  const again = new f.window.Event('drop', { bubbles: true, cancelable: true });
  Object.assign(again, { dataTransfer: transfer });
  f.document.querySelector('[data-canvas-drop]')!.dispatchEvent(again);
  assert.ok(f.s.content().startsWith('Last paragraph'));
  assert.equal((f.s.content().match(/Last paragraph/g) || []).length, 1);
});

test('existing rich inline text editing updates the complete page draft', async () => {
  const f = await fixture('⬥ Parent **bold**\n    • Child\n\n## Next');
  f.click('[data-canvas-preview]');
  await settle();
  const input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  assert.ok(input);
  assert.equal(input.querySelectorAll('[data-rich-row]').length, 4);
  const text = input.querySelector('[data-rich-row]')!.firstChild!;
  text.textContent = 'Changed parent ';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.ok(f.s.content().startsWith('⬥ Changed parent **bold**'));
  assert.ok(f.s.content().endsWith('## Next'));
  assert.ok(f.canvas.finish());
});

test('embed text edits directly with exact surrounding JSON preservation, cancellation and undo', async () => {
  const original = embed('\r\n');
  const f = await fixture(original);
  f.click('[data-embed-text=\'["embed","title"]\']');
  await settle();
  const input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  assert.ok(input);
  input.querySelector('[data-rich-row]')!.textContent = 'Changed title';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(
    f.s.content(),
    original.replace('Original title', 'Changed title'),
  );
  f.click('[data-line-cancel]');
  assert.equal(f.s.content(), original);
  assert.equal(
    f.document.querySelector<HTMLButtonElement>('[data-canvas-undo]')!.disabled,
    true,
  );
  f.click('[data-embed-text=\'["embed","fields",0,"value"]\']');
  await settle();
  const field = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  assert.ok(field);
  field.querySelector('[data-rich-row]')!.textContent = 'Updated body';
  field.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.click('[data-line-done]');
  assert.equal(f.s.content(), original.replace('"Body"', '"Updated body"'));
  f.click('[data-canvas-undo]');
  assert.equal(f.s.content(), original);
  f.click('[data-canvas-redo]');
  assert.equal(f.s.content(), original.replace('"Body"', '"Updated body"'));
});

test('emoji insertion saves and renders in headings, paragraphs and embed text fields with undo', async () => {
  const raw = '<:necromancy:1127645236454912080>';
  const token = newEmojiToken(raw)!;
  for (const [source, selector] of [
    [
      '## Heading\r\n.\r\nOther',
      '[data-canvas-kind="heading"] [data-canvas-preview]',
    ],
    [
      'Paragraph\r\n.\r\nOther',
      '[data-canvas-kind="text"] [data-canvas-preview]',
    ],
    [embed('\r\n'), '[data-embed-text=\'["embed","title"]\']'],
    [embed('\r\n'), '[data-embed-text=\'["embed","fields",0,"value"]\']'],
  ]) {
    const f = await fixture(source);
    f.click(selector);
    await settle();
    const input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
    const chip = f.document.createElement('span');
    chip.dataset.lineToken = token.id;
    chip.contentEditable = 'false';
    const image = f.document.createElement('img');
    image.className = 'emoji';
    image.alt = ':necromancy:';
    chip.append(image);
    input.querySelector('[data-rich-row]')!.append(chip);
    input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
    assert.ok(f.s.content().includes(raw), selector);
    f.click('[data-line-done]');
    await settle();
    assert.ok(
      f.document.querySelector('img.emoji[alt=":necromancy:"]'),
      selector,
    );
    const reopened = await fixture(f.s.content());
    assert.ok(
      reopened.document.querySelector('img.emoji[alt=":necromancy:"]'),
      selector,
    );
    f.click('[data-canvas-undo]');
    assert.equal(f.s.content(), source);
    f.canvas.close();
    reopened.canvas.close();
  }
});

test('selecting embed text and using its toolbar retain the active editor', async () => {
  const original = embed();
  const f = await fixture(original);
  f.click('[data-embed-text=\'["embed","title"]\']');
  await settle();
  const input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  assert.ok(input);
  const row = input.querySelector('[data-rich-row]')!;
  // A drag selection ends with a bubbling click in the editable text.
  row.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(f.document.querySelector('.inline-line-input') === input);
  const tools = f.document.querySelector('.line-formatting')!;
  tools.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  await settle();
  assert.ok(f.document.querySelector('.inline-line-input') === input);
  assert.equal(f.s.content(), original);
  // Another field still commits the current editor and opens that field.
  f.click('[data-embed-text=\'["embed","fields",0,"value"]\']');
  await settle();
  assert.ok(f.document.querySelector('.inline-line-input') !== input);
  assert.equal(
    f.document.querySelector('[data-rich-row]')!.textContent,
    'Body',
  );
  f.canvas.close();
});

test('embed fields can be added, reordered and removed with undo', async () => {
  const original = embed();
  const f = await fixture(original);
  f.click('[data-embed-add]');
  assert.equal(
    (parseGuide(f.s.content()).embeds[0].value as any).embed.fields.length,
    2,
  );
  f.click('[aria-label="Move field down"]');
  assert.equal(
    (parseGuide(f.s.content()).embeds[0].value as any).embed.fields[0].name,
    'New field',
  );
  f.click('[aria-label="Remove field"]');
  assert.equal(
    (parseGuide(f.s.content()).embeds[0].value as any).embed.fields.length,
    1,
  );
  for (let n = 0; n < 3; n++) f.click('[data-canvas-undo]');
  assert.equal(f.s.content(), original);
  const block = canvasBlocks(original).find((block) => block.kind === 'embed')!;
  const field = blockFields(block).find(
    (field) => field.label === 'embed › title',
  )!;
  const changed = changeBlockField(
    block,
    field,
    '<script>not executable</script>',
  );
  const preview = renderCanvasPreview(
    f.document,
    canvasBlocks(changed).find((block) => block.kind === 'embed')!,
  );
  assert.equal(preview.querySelector('script'), null);
});

test('captured pointer dragging moves a block and Escape cancels without a draft change', async () => {
  const f = await fixture('First\n\nLast');
  const pointer = (target: Element, type: string, y: number) => {
    const event = new f.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { button: 0, clientX: 300, clientY: y, pointerId: 1 });
    target.dispatchEvent(event);
  };
  let handle = f.document.querySelectorAll('button[draggable]')[1];
  pointer(handle, 'pointerdown', 400);
  const escape = new f.window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(escape, { key: 'Escape' });
  handle.dispatchEvent(escape);
  pointer(handle, 'pointerup', 300);
  assert.equal(f.s.content(), 'First\n\nLast');
  pointer(handle, 'pointerdown', 400);
  pointer(handle, 'pointerup', 300);
  assert.ok(f.s.content().startsWith('Last'));
  f.click('[data-canvas-undo]');
  assert.equal(f.s.content(), 'First\n\nLast');
});

test('embed inline links use a small popover and participate in page undo', async () => {
  const source =
    '.\n{"embed":{"description":"Text [link](https://example.com/old) end"}}\n.embed:json';
  const f = await fixture(source);
  f.click('[data-embed-text]');
  await settle();
  f.click('[data-format-link]');
  const input = f.document.querySelector<HTMLInputElement>(
    '[aria-label="Link URL"]',
  )!;
  assert.ok(input);
  input.value = 'https://example.com/new';
  input
    .closest('form')!
    .dispatchEvent(
      new f.window.Event('submit', { bubbles: true, cancelable: true }),
    );
  assert.equal(
    f.s.content(),
    source.replace('https://example.com/old', 'https://example.com/new'),
  );
  f.click('[data-canvas-undo]');
  assert.equal(f.s.content(), source);
});

test('media popovers edit the clicked URL when several links share field labels', async () => {
  const source =
    '⬥ [First](https://youtu.be/first)\n⬥ [Second](https://youtu.be/second)';
  const f = await fixture(source);
  f.click('[data-canvas-preview] a[href="https://youtu.be/second"]');
  const fields = f.document.querySelectorAll('[data-canvas-field]');
  assert.equal(fields.length, 2);
  const url = f.document.querySelector<HTMLInputElement>(
    '[aria-label="YouTube URL"]',
  )!;
  url.value = 'https://youtu.be/replaced';
  url
    .closest('form')!
    .dispatchEvent(
      new f.window.Event('submit', { bubbles: true, cancelable: true }),
    );
  assert.equal(
    f.s.content(),
    source.replace('https://youtu.be/second', 'https://youtu.be/replaced'),
  );
  f.click('[data-canvas-undo]');
  assert.equal(f.s.content(), source);
});

test('editing retains cached preset cards whose source URL is on the card itself', async () => {
  const source = '[Preset](https://presets.pvme.io/?id=test)';
  const s = await session(source);
  const { document } = parseHTML(
    '<article id="guide"><a class="preset-preview-card" href="https://presets.pvme.io/?id=test"><img src="/preset-previews/cached.png" alt="Preset preview"></a></article>',
  );
  const canvas = new PageCanvasEditor(
    document,
    document.getElementById('guide')!,
    s,
    () => {},
  );
  assert.equal(
    canvas.root.querySelector('.preset-preview-card img')?.getAttribute('src'),
    '/preset-previews/cached.png',
  );
  assert.equal(s.content(), source);
  canvas.close();
});

test('switching after a text edit selects the correct repeated source block', async () => {
  const f = await fixture('First\n.\nSame\n.\nSame');
  f.click('[data-canvas-preview]');
  await settle();
  let input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  input.querySelector('[data-rich-row]')!.textContent = 'Longer first';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  const last = [...f.document.querySelectorAll('[data-canvas-message]')]
    .at(-1)!
    .querySelector('[data-canvas-preview]')!;
  // The first preview has been replaced by its temporary text surface.
  last.dispatchEvent(
    new f.window.Event('click', { bubbles: true, cancelable: true }),
  );
  await settle();
  input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  input.querySelector('[data-rich-row]')!.textContent = 'Last only';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(f.s.content(), 'Longer first\n.\nSame\n.\nLast only');
});

test('explicit messages retain complete headings, paragraphs, lists and parser-owned separators', () => {
  const source =
    '---\r\nname: Guide\r\n---\r\n## Introduction\r\n.tag:intro\r\n*Note*\r\n\r\nNotes:\r\n⬥ First\r\n    • Child\r\n.\r\n```\r\n..\r\n```\r\nTail';
  const messages = canvasMessages(source);
  assert.equal(messages.length, 2);
  assert.ok(messages[0].source.startsWith('## Introduction'));
  assert.ok(messages[0].source.includes('.tag:intro'));
  assert.ok(messages[0].source.endsWith('    • Child\r\n'));
  assert.ok(messages[1].source.includes('```\r\n..\r\n```'));
  for (const message of messages)
    assert.equal(source.slice(message.start, message.end), message.source);
});

test('one message edits heading, paragraphs and nested bullets together and switches source without losing changes', async () => {
  const message =
    '## Introduction\r\n.tag:intro\r\n*Note: Read this.*\r\n\r\nSome general notes:\r\n⬥ First **bold**\r\n    • Child\r\n⬥ Last';
  const source = message + '\r\n.\r\n## Next\r\nUnchanged';
  const f = await fixture(source);
  assert.equal(f.document.querySelectorAll('[data-canvas-message]').length, 2);
  assert.equal(f.document.querySelectorAll('[data-canvas-drop]').length, 3);
  f.click('[data-canvas-kind="list"] [data-canvas-preview]');
  await settle();
  let input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  assert.equal(input.getAttribute('aria-label'), 'Edit message');
  const rows = [...input.querySelectorAll('[data-rich-row]')];
  assert.equal(rows.length, 7);
  rows[3].textContent = 'Revised notes:';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(
    f.s.content(),
    source.replace('Some general notes:', 'Revised notes:'),
  );
  f.click('[data-message-selected] [data-message-source]');
  const sourceInput = f.document.querySelector<HTMLTextAreaElement>(
    '[data-canvas-message-source]',
  )!;
  assert.ok(sourceInput.value.includes('## Introduction\r\n.tag:intro'));
  assert.ok(sourceInput.value.includes('Revised notes:'));
  assert.ok(!sourceInput.value.includes('Revised notes\\:'));
  assert.ok(!sourceInput.value.includes('## Next'));
  sourceInput.value = sourceInput.value.replace(
    '## Introduction',
    '## Overview',
  );
  sourceInput.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(f.canvas.hasUnappliedChanges, true);
  f.click('[data-message-selected] [data-message-inline]');
  await settle();
  input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  assert.ok(input.textContent!.includes('Overview'));
  assert.equal(input.querySelectorAll('[data-rich-row]').length, 7);
  assert.ok(f.s.content().endsWith('\r\n.\r\n## Next\r\nUnchanged'));
  f.click('[data-line-done]');
  await settle();
  assert.ok(
    f.document
      .querySelector('[data-canvas-message]')!
      .textContent!.includes('Revised notes:'),
  );
  f.click('[data-canvas-undo]');
  assert.ok(f.s.content().startsWith('## Introduction'));
  f.click('[data-canvas-undo]');
  assert.equal(f.s.content(), source);
});

test('switching a formatted message between inline and source without edits is an exact no-op', async () => {
  const source =
    '## __Introduction__\r\n.tag:intro\r\n*Note: Use the __**Table of Contents**__ present at the bottom of the channel.*\r\n\r\nSome general notes:\r\n⬥ The game runs on an internal tick system: **1t (tick) = 0.6s (seconds)**.\r\n⬥ The minimum time between abilities is called the global cooldown: **1 gcd = 3t = 1.8s**.\r\n⬥ Some useful sheets and resources are given below.\r\n\r\n.\r\nNext';
  const f = await fixture(source);
  f.click('[data-canvas-kind="list"] [data-canvas-preview]');
  await settle();
  f.click('[data-message-selected] [data-message-source]');
  const textarea = f.document.querySelector<HTMLTextAreaElement>(
    '[data-canvas-message-source]',
  )!;
  textarea.value = textarea.value.replace(/\r\n/g, '\n'); // Native textarea normalization.
  assert.equal(f.canvas.hasUnappliedChanges, false);
  assert.equal(f.s.content(), source);
  f.click('[data-message-selected] [data-message-inline]');
  await settle();
  assert.ok(f.canvas.finish());
  assert.equal(f.s.content(), source);
  assert.equal(f.s.count, 0);
});

test('source textareas preserve mixed line endings, changed rows and final newline state', () => {
  const original = 'First\r\nSecond\nThird\rFourth';
  assert.equal(
    preserveSourceLineEndings(original, 'First\nSecond\nThird\nFourth'),
    original,
  );
  assert.equal(
    preserveSourceLineEndings(original, 'First\nChanged\nThird\nFourth'),
    'First\r\nChanged\nThird\rFourth',
  );
  assert.equal(
    preserveSourceLineEndings(original, 'New\nFirst\nSecond\nThird\nFourth'),
    'New\r\n' + original,
  );
  assert.equal(preserveSourceLineEndings('A\r\n', 'A'), 'A');
  assert.equal(preserveSourceLineEndings('A', 'A\n'), 'A\n');
});

test('message source includes embed envelopes and invalid source remains editable until cancelled', async () => {
  const source = embed('\r\n') + '\r\nFollowing message';
  const f = await fixture(source);
  f.click('[data-embed-text]');
  await settle();
  f.click('[data-message-selected] [data-message-source]');
  const input = f.document.querySelector<HTMLTextAreaElement>(
    '[data-canvas-message-source]',
  )!;
  assert.ok(input.value.includes('.embed:json'));
  assert.ok(input.value.includes('.tag:keep'));
  input.value = input.value.replace('"Original title"', 'invalid');
  assert.equal(f.canvas.finish(), false);
  assert.ok(f.document.querySelector('[data-canvas-message-source]') === input);
  assert.equal(f.s.content(), source);
  const escape = new f.window.Event('keydown', {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(escape, { key: 'Escape' });
  input.dispatchEvent(escape);
  assert.ok(!f.document.querySelector('[data-canvas-message-source]'));
  assert.equal(f.s.content(), source);
});

test('a plain introduction before existing bullets survives Done, re-editing and draft restoration', async () => {
  const source =
    '⬥ The game runs on an internal tick system: **1t = 0.6s**.\n⬥ The minimum time between abilities is **1 gcd = 3t = 1.8s**.\n⬥ Some useful sheets and resources are given below.';
  const f = await fixture(source);
  f.click('[data-canvas-preview]');
  await settle();
  const input = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  const first = input.querySelector<HTMLElement>('[data-rich-row]')!;
  const intro = f.document.createElement('span');
  intro.dataset.richRow = '';
  intro.dataset.lineOwner = first.dataset.lineOwner;
  intro.dataset.bulletPrefix = '';
  intro.textContent = 'Some general notes:';
  input.prepend(intro);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.match(f.s.content(), /^Some general notes/);
  f.click('[data-line-done]');
  await settle();
  assert.ok(f.canvas.root.textContent?.includes('Some general notes:'));
  assert.equal(
    f.canvas.root.querySelectorAll('[data-canvas-kind="text"]').length,
    1,
  );
  assert.match(f.s.content(), /^Some general notes/);
  const draft = f.s.content();
  assert.ok(f.canvas.finish());
  f.canvas.close();
  const restored = await fixture(draft);
  assert.ok(restored.canvas.root.textContent?.includes('Some general notes:'));
  restored.click('[data-canvas-kind="list"] [data-canvas-preview]');
  await settle();
  restored.click('[data-line-done]');
  assert.equal(restored.s.content(), draft);
});

test('an original empty bullet remains editable after reparsing a draft', async () => {
  const source = '⬥ \r\n⬥ First **bold**\r\n⬥ Second';
  const f = await fixture(source);
  f.click('[data-canvas-preview]');
  await settle();
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  const rows = root.querySelectorAll<HTMLElement>('[data-rich-row]');
  assert.equal(rows.length, 3);
  rows[0].dataset.bulletPrefix = '';
  rows[0].textContent = 'Some general notes:';
  root.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.click('[data-line-done]');
  await settle();
  assert.match(f.s.content(), /^Some general notes/);
  assert.ok(f.s.content().endsWith('\r\n⬥ First **bold**\r\n⬥ Second'));
  assert.equal(f.canvas.root.querySelectorAll('li').length, 2);
});

test('a parent save rejection keeps the text editor open and preserves the last saved source', async () => {
  const source = '⬥ Original';
  const f = await fixture(source);
  f.click('[data-canvas-preview]');
  await settle();
  f.s.setDocument = () => {
    throw new Error('Parent validation rejected this edit');
  };
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  root.querySelector('[data-rich-row]')!.textContent = 'Visible edit';
  root.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.click('[data-line-done]');
  await settle();
  assert.equal(f.document.querySelector('.inline-line-input'), root);
  assert.match(
    f.document.querySelector('.line-edit-error')!.textContent!,
    /could not be saved/,
  );
  assert.equal(f.s.content(), source);
  f.click('[data-line-cancel]');
  await settle();
  assert.equal(f.document.querySelector('.inline-line-input'), null);
});

test('properties popovers anchor to the item and follow it on scroll within the viewport', async () => {
  const f = await fixture('Regular text');
  Object.defineProperty(f.window, 'innerWidth', {
    configurable: true,
    value: 1024,
  });
  Object.defineProperty(f.window, 'innerHeight', {
    configurable: true,
    value: 900,
  });
  const preview = f.document.querySelector<HTMLElement>(
    '[data-canvas-preview]',
  )!;
  let rect = {
    left: 160,
    right: 850,
    top: 180,
    bottom: 260,
    width: 690,
    height: 80,
  };
  preview.getBoundingClientRect = () => rect as DOMRect;
  const settings = [
    ...f.document.querySelectorAll('.canvas-block-tools button'),
  ].find((button) => button.textContent === 'Settings')!;
  settings.dispatchEvent(new f.window.Event('click', { bubbles: true }));
  const panel = f.document.querySelector<HTMLElement>('.canvas-properties')!;
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.left, '160px');
  assert.equal(panel.style.top, '268px');
  rect = { ...rect, left: 340, top: 220, bottom: 300 };
  f.window.dispatchEvent(new f.window.Event('scroll'));
  assert.equal(panel.style.left, '340px');
  assert.equal(panel.style.top, '308px');
  Object.defineProperty(f.window, 'innerWidth', {
    configurable: true,
    value: 640,
  });
  f.window.dispatchEvent(new f.window.Event('resize'));
  assert.equal(panel.style.left, '244px');
  assert.ok(
    parseFloat(panel.style.left) + parseFloat(panel.style.width) <= 624,
  );
  rect = { ...rect, top: -130, bottom: -50 };
  f.window.dispatchEvent(new f.window.Event('scroll'));
  assert.equal(panel.style.visibility, 'hidden');
  f.canvas.close();
});

test('Delete and Backspace remove existing blank message rows without changing neighbouring text or CRLF', async (t) => {
  const f = await fixture('First\r\n\r\n\r\nLast');
  f.click('[data-canvas-preview]');
  await settle();
  const root = f.document.querySelector<HTMLElement>('.inline-line-input')!;
  const rows = [...root.querySelectorAll<HTMLElement>('[data-rich-row]')];
  assert.deepEqual(
    rows.map((row) => row.textContent),
    ['First', '', '', 'Last'],
  );
  const range = {
    startContainer: rows[1],
    endContainer: rows[1],
    commonAncestorContainer: root,
    collapsed: true,
    startOffset: 0,
    endOffset: 0,
    cloneRange() {
      return this;
    },
  };
  mockSelection(t, f.document, range, true);
  const press = (key: string) => {
    const event = new f.window.Event('keydown', {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(event, { key });
    root.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  press('Delete');
  assert.equal(f.s.content(), 'First\r\n\r\nLast');
  assert.equal(root.querySelectorAll('[data-rich-row]').length, 3);
  assert.equal(range.startContainer, rows[2]);
  press('Backspace');
  assert.equal(f.s.content(), 'First\r\nLast');
  assert.equal(root.querySelectorAll('[data-rich-row]').length, 2);
  assert.equal(f.canvas.finish(), true);
  assert.equal(f.s.content(), 'First\r\nLast');
});
