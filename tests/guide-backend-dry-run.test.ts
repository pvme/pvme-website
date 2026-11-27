import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, createCipheriv } from 'node:crypto';
import { GuideApi } from '../src/lib/guide-api';
import { EditSession } from '../src/lib/edit-session';
import { GuideSubmission } from '../src/lib/guide-submission';
import { DraftStorage } from '../src/lib/draft-storage';
import { createTestGuide, MemoryStore } from './helpers';

const backend = resolve('../guide-editor/cloud-functions/guide-pr');
const framework = resolve(
  backend,
  'node_modules/@google-cloud/functions-framework/build/src/main.js',
);
test(
  'actual local Cloud Function validates exact website payload in DRY_RUN with synthetic auth and external networking blocked',
  {
    skip: !existsSync(framework) && 'Adjacent backend dependencies unavailable',
    timeout: 20000,
  },
  async () => {
    const listener = createServer();
    await new Promise<void>((done) => listener.listen(0, 'localhost', done));
    const port = (listener.address() as import('node:net').AddressInfo).port;
    await new Promise<void>((done) => listener.close(() => done()));
    const secret = 'website-dryrun-test-only';
    const child = spawn(
      process.execPath,
      [
        '--require',
        resolve('tests/fixtures/guide-backend-offline.cjs'),
        framework,
        '--target=submitGuideUpdate',
        `--port=${port}`,
      ],
      {
        cwd: backend,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          DRY_RUN: 'true',
          AUTH_COOKIE_SECRET: secret,
          ALLOWED_ORIGIN: 'https://pvme.io',
          TRUSTED_ORIGIN: 'https://pvme.io',
        },
      },
    );
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          const r = await fetch(`http://localhost:${port}/`);
          assert.equal((await r.json()).mode, 'dry-run');
          ready = true;
          break;
        } catch {
          await new Promise((done) => setTimeout(done, 50));
        }
      }
      assert.ok(ready, output);
      const session = {
        provider: 'github',
        githubId: '123',
        githubLogin: 'website-mock',
        githubToken: 'test-only-not-a-provider-token',
        csrfToken: 'website-csrf',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const iv = randomBytes(12),
        cipher = createCipheriv(
          'aes-256-gcm',
          createHash('sha256').update(secret).digest(),
          iv,
        );
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(session)),
        cipher.final(),
      ]);
      const cookie = [
        'v2',
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        encrypted.toString('base64url'),
      ].join('.');
      const api = new GuideApi(
        true,
        async (url, init) => {
          if (init?.method === 'POST')
            assert.equal(String(url), '/api/guide-pr/v2/submissions');
          const headers = new Headers(init?.headers);
          headers.set('Origin', 'https://pvme.io');
          headers.set('Cookie', `pvme_guide_session=${cookie}`);
          return fetch(
            `http://localhost:${port}${String(url).replace('/api/guide-pr', '')}`,
            { ...init, headers },
          );
        },
        true,
      );
      const identity = await api.restore();
      assert.equal(identity?.provider, 'github');
      assert.equal((identity as any).githubToken, undefined);
      const original = 'Original Unicode é\r\nSecond\n';
      const { rendered } = await createTestGuide(original);
      const loaded = await api.load('test.txt', 'master');
      assert.ok(!('hasExistingReview' in loaded));
      assert.equal(loaded.reviewState?.state, 'unverified');
      assert.equal(loaded.localDryRunVerified, true);
      const edit = await EditSession.create(rendered.sourceMap, loaded);
      edit.setDocument('Edited Unicode é\r\nSecond\n');
      const drafts = new DraftStorage(new MemoryStore(), 'github:123');
      drafts.save(edit);
      const workflow = new GuideSubmission(api, {
        async load() {
          const fresh = await api.load('test.txt', 'master');
          if ('hasExistingReview' in fresh) throw Error('Unexpected review');
          return fresh;
        },
      });
      const receipt = await workflow.submit(
        edit,
        {
          title: 'Dry-run website test',
          notes: 'Verify exact source contract',
        },
        drafts,
      );
      assert.ok('dryRun' in receipt.result);
      if ('dryRun' in receipt.result) {
        assert.equal(
          receipt.result.contentBytes,
          Buffer.byteLength(edit.content()),
        );
        assert.equal(
          receipt.result.originalContentBytes,
          Buffer.byteLength(original),
        );
      }
      assert.equal(workflow.complete(receipt), false);
      assert.ok(drafts.hasDraft(edit.path));
      const payload = {
        ...(await edit.prepareUpdate(
          { title: 'Strict check', notes: 'Validation only' },
          edit.loaded,
        )),
        contractVersion: 2,
        expectedContributor: 'github:123',
        expectedReview: { state: 'unverified' },
      };
      for (const [patch, csrf, route, status, code] of [
        [
          { expectedContributor: 'github:124' },
          'website-csrf',
          '/v2/submissions',
          409,
          'CONTRIBUTOR_MISMATCH',
        ],
        [{}, '', '/v2/submissions', 403, 'CSRF_INVALID'],
        [
          { contractVersion: 1 },
          'website-csrf',
          '/v2/submissions',
          400,
          'INVALID_CONTRACT',
        ],
        [
          { expectedReview: { state: 'none', headSha: 'invalid' } },
          'website-csrf',
          '/v2/submissions',
          400,
          'INVALID_REVIEW_STATE',
        ],
        [
          { replaceExistingReview: true },
          'website-csrf',
          '/v2/submissions',
          400,
          'INVALID_REVIEW_STATE',
        ],
        [{}, 'website-csrf', '/', 400, 'STRICT_ROUTE_REQUIRED'],
      ] as const) {
        const response = await fetch(`http://localhost:${port}${route}`, {
          method: 'POST',
          headers: {
            Origin: 'https://pvme.io',
            'Content-Type': 'application/json',
            Cookie: `pvme_guide_session=${cookie}`,
            'X-PVME-CSRF-Token': csrf,
          },
          body: JSON.stringify({ ...payload, ...patch }),
        });
        assert.equal(response.status, status);
        assert.equal((await response.json()).code, code);
      }
    } finally {
      child.kill();
      if (child.exitCode === null)
        await new Promise((done) => child.once('exit', done));
    }
  },
);
