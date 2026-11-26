import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHTML } from 'linkedom';
import {
  applyInlineEdits,
  parseGuide,
  type InlineEdit,
} from '@pvme/guide-parser';
import { renderGuide, getRendered } from '../src/lib/renderer';
import { getCatalogue } from '../src/lib/catalogue';
import { verifySourceVersion, serializeSourceMap } from '../src/lib/source-map';
import {
  createSourceMapper,
  sourceFingerprint,
} from '../src/lib/source-map-builder';

const guide = { methods: [], sections: [] };
const render = (source: string, path = 'test/guide.txt') =>
  renderGuide(source, guide, '', {}, { sourcePath: path });

function assertMappings(source: string, rendered = render(source)) {
  const map = rendered.sourceMap!;
  assert.equal(map.sourceHash, sourceFingerprint(source));
  const { document } = parseHTML(`<article>${rendered.html}</article>`);
  const elements = [
    ...document.querySelectorAll('[data-edit-ref], [data-edit-url]'),
  ];
  const refs = elements.flatMap((element) =>
    ['data-edit-ref', 'data-edit-url'].flatMap((attribute) =>
      element.hasAttribute(attribute) ? [element.getAttribute(attribute)!] : [],
    ),
  );
  assert.equal(new Set(refs).size, refs.length);
  assert.deepEqual(refs.sort(), map.entries.map((entry) => entry.id).sort());
  let end = -1;
  for (const entry of map.entries) {
    assert.ok(entry.range.start.offset >= end);
    end = entry.range.end.offset;
    assert.ok(end <= source.length && end > entry.range.start.offset);
    const attribute =
      entry.kind === 'link-url' ? 'data-edit-url' : 'data-edit-ref';
    const element = document.querySelector(`[${attribute}="${entry.id}"]`)!;
    assert.equal(
      entry.kind === 'link-url'
        ? element.getAttribute('href')
        : element.textContent,
      entry.value,
    );
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
  );
  return map;
}

for (const eol of ['\n', '\r\n']) {
  test(`text, escapes, Unicode, formatting and nested lists retain original ranges (${JSON.stringify(eol)})`, () => {
    const source = [
      '# Title',
      'Plain 🚀 text <:magic:123> **same** and **same**',
      '**outer *inner*** __under__ ~~strike~~ ||hidden||',
      '⬥ parent',
      '    • child',
      '-# subtext',
      '\\*literal\\*',
    ].join(eol);
    const map = assertMappings(source);
    for (const value of [
      'Title',
      'Plain 🚀 text ',
      'inner',
      'under',
      'strike',
      'hidden',
      'parent',
      'child',
      'subtext',
      '*literal*',
    ])
      assert.ok(
        map.entries.some((entry) => entry.value === value),
        value,
      );
    const repeated = map.entries.filter((entry) => entry.value === 'same');
    assert.equal(repeated.length, 2);
    assert.notEqual(repeated[0].id, repeated[1].id);
    const edits = repeated.map((entry, index) => ({
      kind: entry.kind,
      range: entry.range,
      replacement: index ? 'much longer' : 'x',
    }));
    assert.equal(
      applyInlineEdits(source, edits),
      source
        .replace('**same**', '**x**')
        .replace('**same**', '**much longer**'),
    );
    assert.ok(!map.entries.some((entry) => !entry.value.trim()));
  });
}

test('link components remain independent and preserve wrappers, titles and parentheses', () => {
  const source =
    '[old](<https://example.com/a_(b)> "keep (title)")\nhttps://example.com/bare\n[**complex**](https://example.com/complex)';
  const rendered = render(source);
  const map = assertMappings(source, rendered);
  assert.equal(
    map.entries.filter((entry) => entry.kind === 'link-label').length,
    1,
  );
  assert.equal(
    map.entries.filter((entry) => entry.kind === 'link-url').length,
    3,
  );
  assert.equal(map.entries.filter((entry) => entry.kind === 'text').length, 0);
  const label = map.entries.find((entry) => entry.kind === 'link-label')!;
  const url = map.entries.find((entry) => entry.kind === 'link-url')!;
  assert.equal(
    applyInlineEdits(source, [
      { kind: label.kind, range: label.range, replacement: 'new label' },
    ]),
    source.replace('[old]', '[new label]'),
  );
  assert.equal(
    applyInlineEdits(source, [
      {
        kind: url.kind,
        range: url.range,
        replacement: 'https://new.example/long_(path)',
      },
    ]),
    source.replace(
      'https://example.com/a_(b)',
      'https://new.example/long_(path)',
    ),
  );
});

test('derived embed parses, generated content, dynamic links, code and media stay unmapped', () => {
  const source = [
    'Before',
    '.',
    '{"title":"Before","description":"Before **embedded** [label](https://example.com)"}',
    '.embed:json',
    '<:magic:123> <@123> <#123> $data_pvme:Sheet!A1$',
    '[dynamic]($linkmsg_unknown$)',
    '[data]($data_link:123:a$)',
    '[media](https://example.com/picture.png)',
    'https://youtu.be/abc',
    '![alt](https://example.com/alt.png)',
    '`code`',
    '# Ability Bars',
    'Magic',
    '.img:https://example.com/magic.png',
    'Melee',
    '.img:https://example.com/melee.png',
  ].join('\n');
  const rendered = render(source);
  const map = rendered.sourceMap!;
  const { document } = parseHTML(rendered.html);
  assert.ok(document.querySelector('.guide-embed'));
  assert.equal(
    document.querySelectorAll(
      '.guide-embed [data-edit-ref], .guide-embed [data-edit-url]',
    ).length,
    0,
  );
  assert.ok(
    !map.entries.some((entry) =>
      [
        'embedded',
        'label',
        'dynamic',
        'data',
        'media',
        'alt',
        'code',
        'Magic',
        'Melee',
      ].includes(entry.value),
    ),
  );
  assert.ok(map.entries.some((entry) => entry.value === 'Before'));
  const normal = renderGuide(source, guide, '', {});
  const mappedDOM = parseHTML(rendered.html).document;
  mappedDOM
    .querySelectorAll('span[data-edit-ref]')
    .forEach((element) => element.replaceWith(...element.childNodes));
  mappedDOM
    .querySelectorAll('[data-edit-ref], [data-edit-url]')
    .forEach((element) => {
      element.removeAttribute('data-edit-ref');
      element.removeAttribute('data-edit-url');
    });
  assert.equal(
    mappedDOM.toString(),
    parseHTML(normal.html).document.toString(),
  );
});

test('provenance excludes separately parsed and cloned nodes even at identical offsets', () => {
  const doc = parseGuide('original');
  const mapper = createSourceMapper(doc, 'guide.txt');
  const node = doc.messages[0].blocks[0];
  assert.equal(node.type, 'paragraph');
  if (node.type !== 'paragraph') throw Error('Expected paragraph');
  assert.equal(mapper.reference({ ...node.children[0] }, 'text'), '');
  const other = parseGuide('original').messages[0].blocks[0];
  assert.equal(other.type, 'paragraph');
  if (other.type !== 'paragraph') throw Error('Expected paragraph');
  assert.equal(mapper.reference(other.children[0], 'text'), '');
  assert.throws(() => createSourceMapper(doc, '../guide.txt'));
});

test('source verification is exact, browser compatible and fails closed for stale versions', async () => {
  const source = '🚀\\*text\\*\r\n';
  const map = render(source).sourceMap!;
  assert.equal(await verifySourceVersion(source, map), true);
  for (const stale of [
    source.trim(),
    source.replace('\r\n', '\n'),
    source + ' ',
    'changed',
  ])
    assert.equal(await verifySourceVersion(stale, map), false);
  assert.equal(
    await verifySourceVersion(source, { ...map, sourceHash: 'invalid' }),
    false,
  );
  assert.equal(
    await verifySourceVersion(source, { ...map, schemaVersion: 2 as 1 }),
    false,
  );
});

test('safe metadata and repeated guide instances use local references without DOM IDs', () => {
  const source = 'quotes " & </script><script>alert(1)</script> 🚀';
  const rendered = render(source);
  const serialized = serializeSourceMap(rendered.sourceMap!);
  assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(serialized), rendered.sourceMap);
  const instance = `<article data-guide-source="test/guide.txt">${rendered.html}<script type="application/json" data-guide-source-map>${serialized}</script></article>`;
  const { document } = parseHTML(
    instance +
      instance +
      `<article>${render('other', 'other.txt').html}</article>`,
  );
  assert.equal(document.querySelectorAll('script').length, 2);
  for (const article of [...document.querySelectorAll('article')].slice(0, 2)) {
    const map = JSON.parse(article.querySelector('script')!.textContent!);
    for (const entry of map.entries)
      assert.equal(
        article.querySelectorAll(`[data-edit-ref="${entry.id}"]`).length,
        1,
      );
  }
  assert.deepEqual(render(source), rendered);
  assert.equal(document.querySelectorAll('[id]').length, 0);
});

test('a real canonical guide completes the rendered-element to multi-edit round trip', async () => {
  const { guides, root } = getCatalogue();
  for (const g of guides) {
    const source = readFileSync(join(root, g.path), 'utf8');
    const rendered = render(source, g.path);
    const entries = rendered.sourceMap!.entries;
    const selected = (['text', 'link-label', 'link-url'] as const).map((kind) =>
      entries.find(
        (entry) =>
          entry.kind === kind &&
          /^[\w ]+$/.test(kind === 'link-url' ? 'url' : entry.value),
      ),
    );
    if (selected.some((entry) => !entry)) continue;
    const map = assertMappings(source, rendered);
    assert.equal(await verifySourceVersion(source, map), true);
    const edits: InlineEdit[] = selected.map((entry, index) => ({
      kind: entry!.kind,
      range: entry!.range,
      replacement:
        index === 2
          ? 'https://example.com/longer/path'
          : index
            ? 'Updated label'
            : 'Revised',
    }));
    const updated = applyInlineEdits(source, edits);
    // For these plain replacements, verify every character outside the three ranges verbatim.
    let expected = source;
    for (const edit of [...edits].sort(
      (a, b) => b.range.start.offset - a.range.start.offset,
    ))
      expected =
        expected.slice(0, edit.range.start.offset) +
        edit.replacement +
        expected.slice(edit.range.end.offset);
    assert.equal(updated, expected);
    const after = assertMappings(updated);
    for (const edit of edits)
      assert.ok(
        after.entries.some((entry) => entry.value === edit.replacement),
      );
    assert.equal(await verifySourceVersion(updated, map), false);
    return;
  }
  assert.fail('No canonical guide with all three safe target kinds');
});

test('rejected ambiguous text leaves the reading DOM unchanged', () => {
  for (const source of [
    '# a\rb',
    '[label](<https://example.com/path)',
    '> [first\n> second](https://example.com)',
  ]) {
    const document = parseHTML(render(source).html).document;
    document
      .querySelectorAll('span[data-edit-ref]')
      .forEach((element) => element.replaceWith(...element.childNodes));
    document
      .querySelectorAll('[data-edit-ref], [data-edit-url]')
      .forEach((element) => {
        element.removeAttribute('data-edit-ref');
        element.removeAttribute('data-edit-url');
      });
    assert.equal(
      document.toString(),
      parseHTML(renderGuide(source, guide, '', {}).html).document.toString(),
    );
  }
});

test('transformed Discord links, preset cards and reference renderings have no editing targets', () => {
  const source =
    '# Equipment\n[Preset](https://presets.pvme.io/preset/123)\n[guide](https://discord.com/channels/534508796639182860/123/456)';
  const rendered = render(source);
  assert.ok(
    !rendered.sourceMap!.entries.some((entry) => entry.kind !== 'text'),
  );
  const document = parseHTML(rendered.html).document;
  assert.equal(
    document.querySelectorAll(
      '.preset-preview-card [data-edit-ref], .preset-preview-card[data-edit-ref], .preset-preview-card[data-edit-url]',
    ).length,
    0,
  );
  const reference = renderGuide(
    source,
    guide,
    '',
    {},
    { sourcePath: 'commands/test.txt', referenceTitle: 'Equipment' },
  );
  assert.equal(reference.sourceMap, undefined);
  assert.doesNotMatch(reference.html, /data-edit-/);
});

test('built individual, boss and Slayer layouts associate each article with its own metadata', () => {
  const { root } = getCatalogue();
  for (const directory of ['guides', 'bosses', 'slayer']) {
    const slug = readdirSync(`dist/${directory}`, { withFileTypes: true }).find(
      (entry) => entry.isDirectory(),
    )!.name;
    const document = parseHTML(
      readFileSync(`dist/${directory}/${slug}/index.html`, 'utf8'),
    ).document;
    const articles = [
      ...document.querySelectorAll('article[data-guide-source]'),
    ];
    assert.ok(articles.length, directory);
    for (const article of articles) {
      const scripts = article.querySelectorAll('script[data-guide-source-map]');
      assert.equal(scripts.length, 1);
      const map = JSON.parse(scripts[0].textContent!);
      assert.equal(map.path, article.getAttribute('data-guide-source'));
      assert.equal(
        map.sourceHash,
        article.getAttribute('data-guide-source-hash'),
      );
      assert.equal(
        map.sourceHash,
        sourceFingerprint(readFileSync(join(root, map.path), 'utf8')),
      );
      for (const entry of map.entries) {
        const attribute =
          entry.kind === 'link-url' ? 'data-edit-url' : 'data-edit-ref';
        assert.equal(
          article.querySelectorAll(`[${attribute}="${entry.id}"]`).length,
          1,
        );
      }
    }
  }
});

test('render cache refreshes source and fingerprint together', () => {
  const root = mkdtempSync(join(tmpdir(), 'pvme-source-map-'));
  try {
    const g = {
      ...getCatalogue().guides[0],
      path: 'guide.txt',
      methods: [],
      sections: [],
    };
    writeFileSync(join(root, g.path), 'first');
    const first = getRendered(g, root);
    assert.equal(getRendered(g, root), first);
    writeFileSync(join(root, g.path), 'other');
    const next = getRendered(g, root);
    assert.notEqual(next.sourceMap!.sourceHash, first.sourceMap!.sourceHash);
    assert.match(next.html, /other/);
    assert.equal(next.sourceMap!.entries[0].value, 'other');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const style of ['mage', 'necro', 'range']) {
  test(`DPM ${style} headings do not map hidden quote prefixes`, () => {
    const path = `dpm-advice/dpm-advice-${style}.txt`;
    const source = readFileSync(
      join(process.env.GUIDES_DIR || '../pvme-guides', path),
      'utf8',
    );
    const rendered = render(source, path);
    const map = assertMappings(source, rendered);
    assert.ok(map.entries.length);
    assert.ok(!map.entries.some((entry) => entry.value === '> '));
  });
}
test('heading quote presentation leaves structural syntax unmapped without changing the reading DOM', () => {
  for (const source of [
    '# > __Visible__\r\n> quoted\r\n> \r\n> more',
    '# > Plain heading\nOrdinary > inline text\n',
  ]) {
    const mapped = render(source);
    const map = assertMappings(source, mapped);
    assert.ok(!map.entries.some((entry) => entry.value.startsWith('> ')));
    const document = parseHTML(mapped.html).document;
    document
      .querySelectorAll('span[data-edit-ref]')
      .forEach((element) => element.replaceWith(...element.childNodes));
    document
      .querySelectorAll('[data-edit-ref],[data-edit-url]')
      .forEach((element) => {
        element.removeAttribute('data-edit-ref');
        element.removeAttribute('data-edit-url');
      });
    assert.equal(
      document.toString(),
      parseHTML(renderGuide(source, guide, '', {}).html).document.toString(),
    );
    assert.ok(
      mapped.html.includes('<blockquote>') || source.includes('Plain heading'),
    );
  }
});
