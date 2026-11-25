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
import { loadDevelopmentSource } from '../src/lib/dev-guide-source';
import { developmentInlineEditing } from '../scripts/dev-inline-editing.mjs';
import { mappedSource as source, loadMappedGuide as loaded } from './helpers';

test('development source access is catalogue-limited, read-only and rejects symlink escapes', () => {
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
      loadDevelopmentSource('guide.txt', root, guides).originalText,
      source,
    );
    for (const path of [
      '../outside/secret.txt',
      '/guide.txt',
      'C:/secret.txt',
      'unknown.txt',
      'linked\\secret.txt',
    ])
      assert.throws(() => loadDevelopmentSource(path, root, guides));
    symlinkSync(
      outside,
      join(root, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(
      () => loadDevelopmentSource('linked/secret.txt', root, guides),
      /Missing or inaccessible/,
    );
    assert.equal(readFileSync(join(root, 'guide.txt'), 'utf8'), source);
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'private');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('development middleware rejects cross-origin requests and mutations', async () => {
  let middleware: any;
  developmentInlineEditing().configureServer({
    middlewares: {
      use(handler: any) {
        middleware = handler;
      },
    },
    async ssrLoadModule(path: string) {
      return path.includes('catalogue')
        ? { getCatalogue: () => ({ root: 'unused', guides: [] }) }
        : { loadDevelopmentSource: () => loaded() };
    },
  } as never);
  async function request(
    url: string,
    method = 'GET',
    headers: Record<string, string | undefined> = { host: '127.0.0.1:4321' },
  ) {
    let body = '',
      passed = false;
    const response = {
      statusCode: 200,
      setHeader() {},
      end(value: string) {
        body = value;
      },
    };
    await middleware({ url, method, headers }, response, () => {
      passed = true;
    });
    return { ...response, body, passed };
  }
  assert.equal((await request('/other')).passed, true);
  assert.equal(
    (await request('/__dev/guide-source?path=test')).statusCode,
    200,
  );
  assert.equal((await request('/__dev/guide-source', 'POST')).statusCode, 405);
  for (const headers of [
    { host: 'evil.example' },
    { host: '127.0.0.1:4321', origin: 'https://evil.example' },
    { host: 'localhost:4321', 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal(
      (await request('/__dev/guide-source', 'GET', headers)).statusCode,
      403,
    );
});
