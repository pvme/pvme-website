import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { applyInlineEdits } from '@pvme/guide-parser';
import { renderGuide } from '../src/lib/renderer';
import { sourceFingerprint } from '../src/lib/source-map-builder';

const root = resolve(process.env.GUIDES_DIR || '../pvme-guides');
const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.name === '.git' || entry.name === 'node_modules'
      ? []
      : entry.isDirectory()
        ? walk(join(directory, entry.name))
        : entry.name.endsWith('.txt')
          ? [join(directory, entry.name)]
          : [],
  );
const result = {
  guides: 0,
  text: 0,
  'link-label': 0,
  'link-url': 0,
  invalid: [] as { path: string; error: string }[],
};
for (const file of walk(root)) {
  const path = relative(root, file).replace(/\\/g, '/');
  result.guides++;
  try {
    const source = readFileSync(file, 'utf8');
    const rendered = renderGuide(
      source,
      { methods: [], sections: [] },
      '',
      {},
      { sourcePath: path },
    );
    const map = rendered.sourceMap!;
    assert.equal(map.path, path);
    assert.equal(map.sourceHash, sourceFingerprint(source));
    const document = parseHTML(rendered.html).document;
    const references = [
      ...document.querySelectorAll('[data-edit-ref], [data-edit-url]'),
    ].flatMap((element) =>
      ['data-edit-ref', 'data-edit-url'].flatMap((key) =>
        element.hasAttribute(key) ? [element.getAttribute(key)!] : [],
      ),
    );
    assert.equal(
      new Set(references).size,
      references.length,
      'Repeated reference',
    );
    assert.deepEqual(
      references.sort(),
      map.entries.map((entry) => entry.id).sort(),
    );
    let end = -1;
    for (const entry of map.entries) {
      assert.ok(entry.range.start.offset >= end, 'Overlapping ranges');
      end = entry.range.end.offset;
      const attribute =
        entry.kind === 'link-url' ? 'data-edit-url' : 'data-edit-ref';
      const element = document.querySelector(`[${attribute}="${entry.id}"]`)!;
      assert.equal(
        entry.kind === 'link-url'
          ? element.getAttribute('href')
          : element.textContent,
        entry.value,
        'Displayed value differs',
      );
      assert.equal(
        element.closest(
          '.guide-embed, .preset-preview-card, .media-preview-card, .ability-bar',
        ),
        null,
      );
      result[entry.kind]++;
    }
    assert.equal(
      applyInlineEdits(
        source,
        map.entries.map((entry) => ({
          kind: entry.kind,
          range: entry.range,
          replacement: entry.value,
        })),
      ),
      source,
      'Batch no-op changed source',
    );
    // Mapping must preserve the pre-existing DOM after annotation spans are removed.
    document
      .querySelectorAll('span[data-edit-ref]')
      .forEach((element) => element.replaceWith(...element.childNodes));
    document
      .querySelectorAll('[data-edit-ref], [data-edit-url]')
      .forEach((element) => {
        element.removeAttribute('data-edit-ref');
        element.removeAttribute('data-edit-url');
      });
    const normal = parseHTML(
      renderGuide(source, { methods: [], sections: [] }, '', {}).html,
    ).document;
    assert.equal(document.toString(), normal.toString(), 'Reading DOM changed');
  } catch (error) {
    result.invalid.push({ path, error: String(error) });
  }
}
console.log(JSON.stringify(result, null, 2));
if (result.invalid.length) process.exitCode = 1;
