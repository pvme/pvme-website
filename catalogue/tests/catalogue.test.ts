import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyse } from '../src/detect';
import { analyseWithOverrides } from '../src/overrides';
import { parseCollectionDefinitions } from '../src/collection-definitions';
import {
  publicCatalogue,
  serializePublicCatalogue,
} from '../src/public-catalogue';
import { generate } from '../src/catalogue';
import { createLocalService } from '../src/local/service';
import { validateRelative } from '../src/local/filesystem';

test('catalogue detection and overrides retain methods, styles and source anchors', () => {
  const guide = analyse(
    '# Creature\n## Method: Active Melee\n.tag:active\nBody\n## Magic/Melee Hybrid\nBody',
    'slayer/example.txt',
    '/guides',
  );
  assert.equal(guide.methods.length, 2);
  assert.equal(guide.methods[0].tag, 'active');
  assert.deepEqual(guide.methods[0].styles, ['Melee']);
  assert.deepEqual(
    new Set(guide.methods[1].combatSetups![0].components),
    new Set(['Magic', 'Melee']),
  );
  const corrected = analyseWithOverrides(
    '# AFK Blood Reavers\nBody',
    'afk/afk-blood-reavers.txt',
    '/guides',
    { types: ['slayer'], fields: { category: 'Slayer' } },
  );
  assert.deepEqual(corrected.types, ['slayer']);
  assert.equal(corrected.category, 'Slayer');
  const exported = publicCatalogue({
    guides: [guide],
    rulesVersion: 'test',
    generatedAt: 'now',
  } as Parameters<typeof publicCatalogue>[0]);
  assert.deepEqual(JSON.parse(serializePublicCatalogue(exported)), exported);
});

test('collection settings accept any parent and reject invalid membership and navigation', () => {
  const collection = {
    parent: '/tools/',
    subjectId: 'players',
    title: 'Player tools',
    members: [{ name: 'Tool', href: 'https://pvme.io/rotation-builder/' }],
  };
  const parsed = parseCollectionDefinitions({
    schemaVersion: 1,
    collections: [collection],
    cardGroups: [
      { parent: '/tools/', label: 'Players', collection: 'players' },
    ],
  });
  assert.equal(
    parsed.collections[0].members[0].href,
    collection.members[0].href,
  );
  for (const invalid of [
    { ...collection, parent: 'https://example.com/' },
    { ...collection, guidePaths: ['../secret.txt'] },
    { ...collection, members: [{ name: 'Bad', href: 'javascript:alert(1)' }] },
  ])
    assert.throws(
      () =>
        parseCollectionDefinitions({
          schemaVersion: 1,
          collections: [invalid],
        }),
      /collections.json/,
    );
  assert.throws(
    () =>
      parseCollectionDefinitions({
        schemaVersion: 1,
        collections: [collection, collection],
      }),
    /duplicates/,
  );
});

async function temporary(
  run: (base: string, options: Parameters<typeof generate>[0]) => Promise<void>,
) {
  const base = await mkdtemp(join(tmpdir(), 'pvme-test-'));
  const options = {
    root: join(base, 'guides'),
    stateFile: join(base, 'state.json'),
    overridesFile: join(base, 'overrides.json'),
    output: join(base, 'output'),
    cacheDir: join(base, 'cache'),
    reviewFile: join(base, 'reviews.json'),
  };
  try {
    await mkdir(join(options.root, 'slayer'), { recursive: true });
    await writeFile(
      join(options.root, 'slayer/example.txt'),
      '# Creature\n## Method: Melee\n.tag:melee\nOriginal body\n',
    );
    await run(base, options);
  } finally {
    assert.ok(
      resolve(base).startsWith(resolve(tmpdir()) + '/') ||
        resolve(base).startsWith(resolve(tmpdir()) + '\\'),
    );
    await rm(base, { recursive: true, force: true });
  }
}

test('generation reuses unchanged files and refreshes changed or deleted guides', () =>
  temporary(async (_base, options) => {
    assert.equal((await generate(options)).run.parsed, 1);
    assert.equal((await generate(options)).run.reused, 1);
    await writeFile(
      join(options.root, 'slayer/example.txt'),
      '# Creature\n## Method: Necromancy\nBody changed\n',
    );
    const changed = await generate(options);
    assert.equal(changed.run.parsed, 1);
    assert.ok(
      changed.guides[0].methods.some((method) =>
        method.styles.includes('Necromancy'),
      ),
    );
    await rm(join(options.root, 'slayer/example.txt'));
    assert.equal((await generate(options)).guides.length, 0);
  }));

test('local edits require confirmation, reject unsafe paths and preserve guide contents', () =>
  temporary(async (_base, options) => {
    const service = await createLocalService(options);
    await service.refresh();
    for (const path of [
      '../outside.txt',
      '/absolute.txt',
      'C:/outside.txt',
      'slayer/example.txt:stream',
    ])
      assert.throws(() => validateRelative(path));
    await assert.rejects(service.source('../outside.txt'));
    const source = await service.source('slayer/example.txt');
    const preview = await service.preview({
      operation: 'rename',
      path: source.path,
      expectedHash: source.hash,
      filename: 'renamed.txt',
    });
    await assert.rejects(service.apply(preview.id, false), /confirmation/);
    await service.apply(preview.id, true);
    assert.equal(
      await readFile(join(options.root, 'slayer/renamed.txt'), 'utf8'),
      source.text,
    );
    await assert.rejects(service.source('slayer/example.txt'));
  }));
