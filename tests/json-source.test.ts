import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonSource,
  patchJsonProperty,
  patchJsonArray,
} from '../src/lib/json-source';
import {
  canvasBlocks,
  canvasSection,
  moveCanvasBlock,
  insertCanvasBlock,
  validatePageSource,
} from '../src/lib/page-canvas';
import { sourceDiff, diffContext } from '../src/lib/source-diff';

test('JSON token patches preserve escaped strings, wrappers, unknown keys and mixed line endings', () => {
  const source =
    '.\r\n{ "embed" : {\n\t"title": "A\\u0020title", "description":"braces } \\"quotes\\"", "unknown": [true,null,{"keep":1}] } }\r\n.embed:json\n.tag:test';
  assert.equal(
    patchJsonProperty(source, ['embed', 'title'], 'A title'),
    source,
  );
  const value = 'New "title"\\path\n<:magic:123> 🔥';
  const changed = patchJsonProperty(source, ['embed', 'title'], value);
  assert.equal(
    changed,
    source.replace('"A\\u0020title"', JSON.stringify(value)),
  );
  assert.equal((jsonSource(changed).value as any).embed.title, value);
  assert.equal(
    patchJsonProperty(source, ['embed', 'color'], 42).includes(
      '"unknown": [true,null,{"keep":1}]',
    ),
    true,
  );
  assert.throws(() => jsonSource('{"title":"one","title":"two"}'), /Duplicate/);
  assert.throws(() => patchJsonProperty(source, ['missing', 'value'], 'x'));
  const prototype = patchJsonProperty(
    '{"__proto__":{"text":"original"}}',
    ['__proto__', 'text'],
    'changed',
  );
  assert.equal(JSON.parse(prototype).__proto__.text, 'changed');
  assert.equal(({} as any).text, undefined);
});

test('complete heading moves preserve child headings, tags, attachments, references and raw whitespace', () => {
  const yaml = '---\r\nname: Guide\r\n---\r\n';
  const first =
    '.\r\n## One\n.tag:one\r\n⬥ Parent <:magic:123> {$data}\n    • Child\r\n.\n### Child heading\n.img:https://example.com/a.png\r\n\r\n';
  const second = '.\n## Two\n.tag:two\nSecond\n';
  const source = yaml + first + second;
  const heading = canvasBlocks(source).find(
    (block) => block.kind === 'heading',
  )!;
  assert.equal(canvasSection(source, heading).source, first);
  const changed = moveCanvasBlock(source, heading, source.length);
  assert.equal(changed, yaml + second + first);
  assert.equal(validatePageSource(source, changed), changed);
  assert.throws(
    () => validatePageSource(source, insertCanvasBlock(source, 0, 'Text')),
    /frontmatter/,
  );
  assert.throws(
    () =>
      validatePageSource(
        source,
        insertCanvasBlock(source, source.length, first),
      ),
    /error/,
  );
  assert.throws(
    () =>
      moveCanvasBlock(
        source,
        canvasBlocks(source).find(
          (block) =>
            block.source.includes('.tag:one') && block.kind === 'settings',
        )!,
        source.length,
      ),
    /complete heading/,
  );
});

test('review context collapses unchanged runs without dropping exact source diff tokens', () => {
  const before = Array.from({ length: 50 }, (_, i) => `Line ${i}\r\n`).join('');
  const after = before.replace('Line 25', 'Changed');
  const diff = sourceDiff(before, after),
    groups = diffContext(diff);
  assert.deepEqual(
    groups.flatMap((group) => group.lines),
    diff,
  );
  assert.ok(groups.some((group) => group.collapsed));
  assert.ok(
    groups.filter((group) => !group.collapsed).flatMap((group) => group.lines)
      .length < 15,
  );
});

test('field reordering preserves surviving object tokens and unknown properties', () => {
  const source =
    '{ "fields": [\r\n  { "name" : "A\\u0020B", "value":"text", "unknown": {"a":1} },\r\n  {"name":"Second","value":"body"}\r\n], "keep" : true }';
  const fields = (jsonSource(source).value as any).fields;
  assert.equal(patchJsonArray(source, ['fields'], fields), source);
  const changed = patchJsonArray(source, ['fields'], [...fields].reverse());
  assert.ok(
    changed.includes(
      '{ "name" : "A\\u0020B", "value":"text", "unknown": {"a":1} }',
    ),
  );
  assert.ok(changed.endsWith('], "keep" : true }'));
  assert.deepEqual(
    (jsonSource(changed).value as any).fields,
    [...fields].reverse(),
  );
});
