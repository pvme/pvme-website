import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GuideApi,
  GuideApiError,
  consumeOAuthReturn,
  contributorId,
  eligibleContributor,
  type PublicUser,
} from '../src/lib/guide-api';
import { authenticatedSourceProvider } from '../src/lib/authenticated-source';
import { completeGithubDevLogin } from '../src/lib/guide-api-dev';
import { DraftStorage } from '../src/lib/draft-storage';
import { EditSession } from '../src/lib/edit-session';
import { createTestGuide, MemoryStore, testSource } from './helpers';

const github = (id = '42', csrfToken = 'csrf-a'): PublicUser => ({
  provider: 'github',
  githubId: id,
  githubLogin: 'contributor',
  username: 'contributor',
  globalName: '',
  displayName: 'Contributor',
  avatar: '',
  csrfToken,
  canReviewPrs: false,
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function mockApi(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const response = responses.shift();
    assert.ok(response, `Unexpected request: ${url}`);
    return response;
  };
  const api = new GuideApi(true, request);
  return { api, calls, request };
}

test('credentialed, uncached session restoration keeps CSRF in memory and stable provider identity', async () => {
  const { api, calls } = mockApi([json({ user: github() })]);
  await api.restore();
  assert.equal(contributorId(api.user), 'github:42');
  assert.equal(calls[0].url, '/api/guide-pr/auth/me');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(eligibleContributor(api.user));
  assert.equal(
    eligibleContributor({
      ...github(),
      provider: 'discord',
      discordId: '42',
      pvmeMember: false,
    } as PublicUser),
    false,
  );
});

test('OAuth return preserves base path, multiple query values and fragment, scrubs transient values', () => {
  for (const prefix of [
    'https://pvme.io/pvme-website/',
    'https://pvme.io/',
    'http://localhost:4321/pvme-website/',
  ]) {
    const href = `${prefix}bosses/nex/?tag=a&tag=b&submit=1&authError=old&githubSession=handoff#phase-2`;
    const api = new GuideApi(prefix.includes('localhost'));
    for (const provider of ['github', 'discord'] as const) {
      const login = new URL(
        api.loginUrl(provider, href),
        'http://localhost:4321',
      );
      assert.equal(
        login.searchParams.get('returnTo'),
        `${prefix}bosses/nex/?tag=a&tag=b#phase-2`,
      );
      assert.ok(login.pathname.endsWith(`/auth/${provider}/start`));
    }
    let clean = '';
    assert.deepEqual(
      consumeOAuthReturn(href, (url) => {
        clean = url;
      }),
      { token: 'handoff', error: 'old' },
    );
    assert.equal(clean, `${prefix}bosses/nex/?tag=a&tag=b#phase-2`);
  }
});

test('production handoff cannot contact dev-session', async () => {
  const api = new GuideApi(false, (async () => {
    assert.fail('Production dev request');
  }) as typeof fetch);
  assert.equal(api.base, 'https://guide-api.pvme.io');
  await assert.rejects(
    completeGithubDevLogin(api, 'test-only', async () => {
      assert.fail('Production dev request');
    }),
    /disabled in production/,
  );
});

test('local handoff sends JSON credentials; session is restored independently afterwards', async () => {
  const { api, calls, request } = mockApi([
    json({ user: github() }),
    json({ user: github() }),
  ]);
  await completeGithubDevLogin(api, 'encrypted-test-handoff', request);
  await api.restore();
  assert.equal(
    calls[0].init.body,
    JSON.stringify({ token: 'encrypted-test-handoff' }),
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
});

test('logout uses CSRF, refreshes once for the documented 403, and preserves identity on other errors', async () => {
  const { api, calls } = mockApi([
    json({ user: github() }),
    json({ error: 'The login session could not be verified' }, 403),
    json({ user: github('42', 'csrf-b') }),
    json({ ok: true }),
  ]);
  await api.restore();
  await api.logout();
  assert.equal((calls[1].init.headers as any)['X-PVME-CSRF-Token'], 'csrf-a');
  assert.equal((calls[3].init.headers as any)['X-PVME-CSRF-Token'], 'csrf-b');
  assert.equal(api.user, null);
  assert.equal(calls.length, 4);
  for (const status of [400, 403, 409, 500]) {
    const mock = mockApi([
      json({ user: github() }),
      json({ error: 'Retain draft', code: 'SOURCE_CONFLICT' }, status),
    ]);
    await mock.api.restore();
    await assert.rejects(
      mock.api.logout(),
      (error) => error instanceof GuideApiError && error.status === status,
    );
    assert.equal(mock.calls.length, 2);
    assert.equal(contributorId(mock.api.user), 'github:42');
  }
});

test('CSRF refresh never retries with another contributor or an expired session', async () => {
  for (const user of [github('99'), null]) {
    const { api, calls } = mockApi([
      json({ user: github() }),
      json({ error: 'login session could not be verified' }, 403),
      json({ user }),
    ]);
    await api.restore();
    await assert.rejects(api.logout());
    assert.equal(calls.length, 3);
  }
  const anonymous = mockApi([
    json({ error: 'login session could not be verified' }, 403),
  ]);
  await assert.rejects(anonymous.api.logout());
  assert.equal(anonymous.calls.length, 1);
});

test('network errors are not retried; 401 and failed session checks suspend identity', async () => {
  let attempts = 0;
  const api = new GuideApi(true, (async () => {
    attempts++;
    throw new Error('Offline');
  }) as typeof fetch);
  api.user = github();
  let changes = 0;
  api.onIdentityChange = () => changes++;
  await assert.rejects(api.logout(), /Offline/);
  assert.equal(attempts, 1);
  await assert.rejects(api.restore(), /Offline/);
  assert.equal(api.user, null);
  assert.equal(changes, 1);
  const mock = mockApi([
    json({ user: github() }),
    json({ error: 'Expired' }, 401),
  ]);
  await mock.api.restore();
  await assert.rejects(mock.api.load('test.txt'));
  assert.equal(mock.api.user, null);
});

test('existing review requires a choice, and preparation refetches the chosen source', async () => {
  const source = testSource('Original\r\n');
  const choice = {
    hasExistingReview: true,
    path: 'test.txt',
    reviewBranch: 'guide-editor/github-42/test',
    prUrl: 'https://github.com/pvme/pvme-guides/pull/1',
  };
  for (const selection of ['master', 'review'] as const) {
    const selected = {
      ...source,
      source:
        selection === 'review' ? ('user-pr' as const) : ('master' as const),
      branch: selection === 'review' ? choice.reviewBranch : 'master',
    };
    const { api, calls } = mockApi([
      json({ user: github() }),
      json(choice),
      json({ user: github() }),
      json(selected),
      json({ user: github() }),
      json(selected),
    ]);
    let choices = 0;
    const provider = authenticatedSourceProvider(
      api,
      () => 'github:42',
      async () => {
        choices++;
        return selection;
      },
    );
    const loaded = await provider.load('test.txt');
    assert.equal(loaded.originalText, 'Original\r\n');
    assert.equal(choices, 1);
    await provider.load('test.txt', loaded.source);
    assert.ok(calls[3].url.endsWith(`source=${selection}`));
    assert.ok(calls[5].url.endsWith(`source=${selection}`));
  }
});

test('source provider fails closed for expired or changed contributors before loading private source', async () => {
  for (const user of [null, github('99')]) {
    const { api, calls } = mockApi([json({ user })]);
    const provider = authenticatedSourceProvider(
      api,
      () => 'github:42',
      async () => {
        assert.fail('No choice expected');
      },
    );
    await assert.rejects(provider.load('test.txt'));
    assert.equal(calls.length, 1);
  }
});

test('drafts are isolated by provider and stable ID, retained through expiry/logout and source mismatch', async () => {
  const store = new MemoryStore();
  const { session, rendered } = await createTestGuide('A guide line\r\n');
  session.setDocument('A changed guide line\r\n');
  const first = new DraftStorage(store, 'github:42');
  first.save(session);
  for (const id of [
    'github:99',
    'discord:42',
    'signed-out',
    'local-development',
  ]) {
    const other = new DraftStorage(store, id);
    assert.equal(other.hasDraft(session.path), false);
    assert.equal(
      other.restore(
        await EditSession.create(
          rendered.sourceMap,
          testSource(session.originalContent),
        ),
      ).status,
      'empty',
    );
  }
  const fresh = await EditSession.create(
    rendered.sourceMap,
    testSource(session.originalContent),
  );
  assert.equal(first.restore(fresh).status, 'restored');
  assert.equal(fresh.content(), session.content());
  const review = await EditSession.create(rendered.sourceMap, {
    ...testSource(session.originalContent),
    source: 'user-pr',
    branch: 'review',
  });
  assert.equal(first.restore(review).status, 'blocked');
  assert.equal(first.hasDraft(session.path), true);
  const old = await createTestGuide('A newer line\n');
  assert.equal(first.restore(old.session).status, 'blocked');
  const dev = new DraftStorage(store);
  dev.save(session);
  assert.equal(dev.identity, 'local-development');
  const legacy = JSON.parse(store.getItem(dev.key(session.path))!);
  delete legacy.source;
  delete legacy.branch;
  delete legacy.existingReviewBranch;
  store.setItem(dev.key(session.path), JSON.stringify(legacy));
  assert.equal(
    dev.restore(
      await EditSession.create(
        rendered.sourceMap,
        testSource(session.originalContent),
      ),
    ).status,
    'restored',
  );
});

test('exact Phase 5 payload preserves immutable original and blocks stale maps/review metadata', async () => {
  const original = 'A guide line\r\nAnother line\n';
  const { session, rendered } = await createTestGuide(original);
  const loaded = testSource(original);
  loaded.originalText = 'tampered';
  assert.equal(session.originalContent, original);
  assert.ok(Object.isFrozen(session.loaded));
  await assert.rejects(
    EditSession.create(rendered.sourceMap, loaded),
    /older source snapshot/,
  );
  session.setDocument('A changed guide line\r\nAnother line\n');
  const payload = await session.prepareUpdate(
    { title: 'Change', notes: 'Reason' },
    testSource(original),
  );
  assert.equal(payload.sourcePreservation, 'exact');
  assert.equal(payload.originalContent, original);
  assert.equal(payload.replaceExistingReview, false);
  await assert.rejects(
    session.prepareUpdate(
      { title: 'Change', notes: 'Reason' },
      { ...testSource(original), existingReviewBranch: 'new-review' },
    ),
    /metadata changed/,
  );
});

test('late session restoration cannot undo a confirmed logout and parallel refreshes share one request', async () => {
  let resolve: ((response: Response) => void) | undefined;
  let reads = 0;
  const api = new GuideApi(true, (async (url) => {
    if (String(url).endsWith('/auth/me')) {
      reads++;
      return new Promise((done) => {
        resolve = done;
      });
    }
    return json({ ok: true });
  }) as typeof fetch);
  api.user = github();
  const first = api.restore();
  const second = api.restore();
  assert.equal(first, second);
  assert.equal(reads, 1);
  await api.logout();
  resolve!(json({ user: github() }));
  await first;
  assert.equal(api.user, null);
});

test('browser fetch receives the global receiver rather than the API instance', async () => {
  const api = new GuideApi(true, function (this: unknown) {
    assert.equal(this, globalThis);
    return Promise.resolve(json({ user: github() }));
  } as typeof fetch);
  await api.restore();
  assert.equal(contributorId(api.user), 'github:42');
});
