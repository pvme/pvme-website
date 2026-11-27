import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { releaseFlags } from '../src/lib/release-flags';
const buildDirectory = process.env.PHASE4_BUILD_DIR || 'dist';

function assets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? assets(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

test('production browser assets contain no proxy secret, local upstream or browser QA identity', () => {
  const files = assets(join(buildDirectory, '_astro')).filter((path) =>
    /\.(js|html|css)$/.test(path),
  );
  assert.ok(files.length);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      content,
      /build-safety-sentinel-local-only|browser-mock-local-only|X-PVME-Submit-Secret|X-PVME-Proxy-Origin|PVME_SUBMIT_SECRET|http:\/\/localhost:(?:4321|8080)|Mock contributor|\/__test|\/auth\/dev-session|pvme-guide-api-local/,
    );
  }
});

test('production authentication and both inline entry points follow independent closed-by-default release switches', () => {
  const { document } = parseHTML(
    readFileSync(join(buildDirectory, 'bosses/giant-mole/index.html'), 'utf8'),
  );
  assert.ok(
    document.querySelector(
      '[data-account] summary[aria-label="Contributor account"]',
    ),
  );
  assert.ok(document.querySelector('[data-login="discord"]'));
  assert.ok(document.querySelector('[data-login="github"]'));
  const entries = [...document.querySelectorAll('[data-inline-edit-path]')];
  assert.ok(entries.length >= 2);
  const hidden = entries[0].hasAttribute('hidden');
  assert.ok(entries.every((entry) => entry.hasAttribute('hidden') === hidden));
  const flags = releaseFlags(
    false,
    process.env.PUBLIC_AUTHENTICATION,
    process.env.PUBLIC_AUTHENTICATED_EDITING,
    process.env.PUBLIC_GUIDE_SUBMISSION,
  );
  assert.equal(hidden, !flags.authenticatedEditing);
  assert.equal(
    document.querySelector('[data-account]')!.hasAttribute('hidden'),
    !flags.authentication,
  );
  assert.equal(
    document.querySelector('meta[name="referrer"]')?.getAttribute('content'),
    'no-referrer',
  );
});
