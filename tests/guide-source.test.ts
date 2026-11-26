import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { loadGuideSource } from '../src/lib/guide-source';

import { mappedSource as source } from './helpers';

test('published source access is catalogue-limited, read-only and rejects symlink escapes', () => {
  const directory = mkdtempSync(resolve('.local/guide-source-'));
  const root = join(directory, 'guides'),
    outside = join(directory, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'guide.txt'), source);
  writeFileSync(join(outside, 'secret.txt'), 'private');
  const guides = [
    { path: 'guide.txt', title: 'Guide' },
    { path: 'linked/secret.txt', title: 'Escape' },
  ];
  try {
    assert.equal(
      loadGuideSource('guide.txt', root, guides).originalText,
      source,
    );
    for (const path of [
      '../outside/secret.txt',
      '/guide.txt',
      'C:/secret.txt',
      'unknown.txt',
      'linked\\secret.txt',
    ])
      assert.throws(() => loadGuideSource(path, root, guides));
    symlinkSync(
      outside,
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(
      () => loadGuideSource('linked/secret.txt', root, guides),
      /Missing or inaccessible/,
    );
    assert.equal(readFileSync(join(root, 'guide.txt'), 'utf8'), source);
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'private');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
