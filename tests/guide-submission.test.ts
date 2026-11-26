import test from 'node:test';
import assert from 'node:assert/strict';
import { GuideApi, GuideApiError, type PublicUser } from '../src/lib/guide-api';
import {
  GuideSubmission,
  reviewIdentity,
  submissionFailure,
} from '../src/lib/guide-submission';
import {
  parsePublicUser,
  parseSubmissionResult,
  validateUpdate,
  SubmissionUncertainError,
} from '../src/lib/submission-contract';
import { releaseFlags } from '../src/lib/release-flags';
import { DraftStorage } from '../src/lib/draft-storage';
import { EditSession } from '../src/lib/edit-session';
import { createTestGuide, testSource, MemoryStore } from './helpers';
const user = (id = '42', csrfToken = 'csrf'): PublicUser => ({
  provider: 'github',
  githubId: id,
  githubLogin: 'mock',
  username: 'mock',
  displayName: 'Mock',
  globalName: '',
  avatar: '',
  csrfToken,
  canReviewPrs: false,
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const success = {
  prUrl: 'https://github.com/pvme/pvme-guides/pull/123',
  branch: 'guide-editor/github-42/test',
  path: 'test.txt',
  reusedReview: false,
};
async function fixture(
  source: 'master' | 'user-pr' = 'master',
  existing = false,
  respond?: (body: any, calls: any[]) => Promise<Response>,
) {
  const original = 'Original é\r\nSecond\n';
  const { rendered } = await createTestGuide(original);
  const loaded = {
    ...testSource(original),
    source,
    branch: source === 'master' ? 'master' : success.branch,
    ...(existing
      ? {
          existingReviewBranch: success.branch,
          existingReviewUrl: success.prUrl,
        }
      : {}),
    ...(source === 'user-pr' ? { prUrl: success.prUrl } : {}),
  };
  const session = await EditSession.create(rendered.sourceMap, loaded);
  session.setDocument('Edited é\r\nSecond\n');
  const calls: any[] = [];
  const api = new GuideApi(
    true,
    (async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/auth/me')) return json({ user: user() });
      assert.equal(String(url), '/api/guide-pr/');
      return respond
        ? respond(JSON.parse(init!.body as string), calls)
        : json(
            { ...success, reusedReview: source === 'user-pr' || existing },
            source === 'user-pr' || existing ? 200 : 201,
          );
    }) as typeof fetch,
    true,
  );
  await api.restore();
  const provider = {
    async load(path: string, selected?: string) {
      assert.equal(path, 'test.txt');
      assert.equal(selected, source);
      return { ...loaded };
    },
  };
  const storage = new MemoryStore(),
    drafts = new DraftStorage(storage, 'github:42');
  drafts.save(session);
  const workflow = new GuideSubmission(api, provider);
  return { api, calls, loaded, session, drafts, storage, workflow, provider };
}
const description = { title: 'Update test', notes: 'Correct the guide' };

test('public session validation strips secrets and rejects malformed identities and types', () => {
  const parsed = parsePublicUser({
    ...user(),
    githubToken: 'never-retain',
    roles: ['secret'],
    exp: 123,
  });
  assert.deepEqual(parsed, user());
  assert.equal(parsePublicUser(null), null);
  for (const invalid of [
    undefined,
    {},
    [],
    { ...user(), githubId: '' },
    { ...user(), csrfToken: '' },
    { ...user(), provider: 'other' },
    { ...user(), canReviewPrs: 'true' },
  ])
    assert.throws(() => parsePublicUser(invalid));
  const discord = {
    ...user(),
    provider: 'discord',
    discordId: '99',
    pvmeMember: false,
  };
  assert.equal(parsePublicUser(discord)?.provider, 'discord');
  assert.equal((parsePublicUser(discord) as any).githubId, undefined);
});
test('real new PR success uses exact source, JSON credentials and CSRF; deliberate completion retires only the submitted draft', async () => {
  const f = await fixture();
  const old = f.drafts.snapshot('test.txt');
  const receipt = await f.workflow.submit(f.session, description, f.drafts);
  assert.deepEqual(receipt.result, success);
  assert.equal(f.drafts.snapshot('test.txt'), old);
  const post = f.calls.at(-1);
  const payload = JSON.parse(post.init.body);
  assert.equal(payload.originalContent, 'Original é\r\nSecond\n');
  assert.equal(payload.content, 'Edited é\r\nSecond\n');
  assert.equal(payload.sourcePreservation, 'exact');
  assert.equal(payload.replaceExistingReview, false);
  assert.equal(post.init.credentials, 'include');
  assert.equal(post.init.cache, 'no-store');
  assert.equal(post.init.headers['X-PVME-CSRF-Token'], 'csrf');
  assert.equal(f.workflow.complete(receipt), true);
  assert.equal(f.drafts.hasDraft('test.txt'), false);
  await assert.rejects(
    f.workflow.submit(f.session, description, f.drafts),
    /already been submitted/,
  );
});
test('loaded review updates retain the actual branch; master replacements require identity-bound metadata consent', async () => {
  for (const source of ['master', 'user-pr'] as const) {
    const f = await fixture(source, true);
    if (source === 'master') {
      await assert.rejects(
        f.workflow.submit(f.session, description, f.drafts),
        /Confirm replacement/,
      );
      await assert.rejects(
        f.workflow.submit(f.session, description, f.drafts, {
          identity: 'github:99',
          review: reviewIdentity(f.session),
        }),
        /Confirm replacement/,
      );
    }
    const receipt = await f.workflow.submit(f.session, description, f.drafts, {
      identity: 'github:42',
      review: reviewIdentity(f.session),
    });
    const payload = JSON.parse(f.calls.at(-1).init.body);
    assert.equal(payload.replaceExistingReview, source === 'master');
    assert.equal(payload.branch, f.loaded.branch);
    assert.equal(payload.existingReviewBranch, success.branch);
    assert.ok(!('dryRun' in receipt.result) && receipt.result.reusedReview);
  }
});
test('changed source or known review metadata blocks stale replacement consent before POST', async () => {
  for (const change of [
    { existingReviewBranch: 'other' },
    { existingReviewUrl: 'https://github.com/pvme/pvme-guides/pull/999' },
    { originalText: 'Newer source' },
  ]) {
    const f = await fixture('master', true);
    f.provider.load = async () => ({ ...f.loaded, ...change });
    await assert.rejects(
      f.workflow.submit(f.session, description, f.drafts, {
        identity: 'github:42',
        review: reviewIdentity(f.session),
      }),
    );
    assert.ok(!f.calls.some((call) => call.init.method === 'POST'));
    assert.ok(f.drafts.hasDraft('test.txt'));
  }
});
test('duplicate submission is blocked during source validation and in the API request itself', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture('master', false, async () => {
    await gate;
    return json(success, 201);
  });
  const pending = f.workflow.submit(f.session, description, f.drafts);
  await assert.rejects(
    f.workflow.submit(f.session, description, f.drafts),
    /already pending/,
  );
  while (!f.calls.some((call) => call.init.method === 'POST'))
    await new Promise((resolve) => setTimeout(resolve, 1));
  const payload = await f.session.prepareUpdate(description, f.loaded);
  await assert.rejects(f.api.submit(payload, 'github:42'), /already pending/);
  release();
  await pending;
  assert.equal(f.calls.filter((call) => call.init.method === 'POST').length, 1);
});
test('newer draft edits, unrelated snapshots and account drafts survive successful completion', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture('master', false, async () => {
    await gate;
    return json(success, 201);
  });
  const pending = f.workflow.submit(f.session, description, f.drafts);
  while (!f.calls.some((call) => call.init.method === 'POST'))
    await new Promise((resolve) => setTimeout(resolve, 1));
  f.session.setDocument('Newer edits\r\nSecond\n');
  f.drafts.save(f.session);
  const other = new DraftStorage(f.storage, 'github:99');
  other.save(f.session);
  const current = f.drafts.snapshot('test.txt'),
    otherRaw = other.snapshot('test.txt');
  release();
  const receipt = await pending;
  assert.equal(f.workflow.complete(receipt), false);
  assert.equal(f.drafts.snapshot('test.txt'), current);
  assert.equal(other.snapshot('test.txt'), otherRaw);
});
test('session expiry and identity changes immediately before POST cannot submit or remove a draft', async () => {
  for (const current of [null, user('99')]) {
    const f = await fixture();
    (f.api as any).request = async () => json({ user: current });
    await assert.rejects(f.workflow.submit(f.session, description, f.drafts));
    assert.ok(f.drafts.hasDraft('test.txt'));
  }
});
test('documented CSRF rejection retries once with the same identity and fresh token only', async () => {
  for (const changed of [false, true]) {
    let posts = 0,
      reads = 0;
    const f = await fixture();
    (f.api as any).request = async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/me')) {
        reads++;
        return json({
          user: reads === 1 ? user() : user(changed ? '99' : '42', 'refreshed'),
        });
      }
      posts++;
      if (posts === 1)
        return json(
          { error: 'Your login session could not be verified.' },
          403,
        );
      assert.equal((init.headers as any)['X-PVME-CSRF-Token'], 'refreshed');
      return json(success, 201);
    };
    if (changed)
      await assert.rejects(f.workflow.submit(f.session, description, f.drafts));
    else await f.workflow.submit(f.session, description, f.drafts);
    assert.equal(posts, changed ? 1 : 2);
  }
});
test('HTTP failures and uncertain network/response outcomes never retry or delete drafts', async () => {
  for (const [status, code] of [
    [401, undefined],
    [403, undefined],
    [404, undefined],
    [409, undefined],
    [409, 'SOURCE_CONFLICT'],
    [409, 'FORK_SYNC_REQUIRED'],
    [413, undefined],
    [429, undefined],
    [500, undefined],
    [422, undefined],
  ] as const) {
    let posts = 0;
    const f = await fixture('master', false, async () => {
      posts++;
      return json({ error: 'Safe backend error', code }, status);
    });
    await assert.rejects(
      f.workflow.submit(f.session, description, f.drafts),
      (error) => {
        const text = submissionFailure(error);
        assert.match(text, /draft is retained/);
        if (code === 'FORK_SYNC_REQUIRED') assert.match(text, /Sync fork/);
        return error instanceof GuideApiError;
      },
    );
    assert.equal(posts, 1);
    assert.ok(f.drafts.hasDraft('test.txt'));
  }
  for (const respond of [
    async () => {
      throw new Error('Connection lost');
    },
    async () => json({ ok: true }),
    async () => json({ ...success, prUrl: 'javascript:bad' }),
    async () => json(success, 202),
  ]) {
    const f = await fixture('master', false, respond);
    await assert.rejects(
      f.workflow.submit(f.session, description, f.drafts),
      (error) =>
        error instanceof SubmissionUncertainError &&
        /Inspect|inspect/.test(error.message),
    );
    assert.equal(
      f.calls.filter((call) => call.init.method === 'POST').length,
      1,
    );
    assert.ok(f.drafts.hasDraft('test.txt'));
  }
});
test('dry-run validates its public response, reports no PR and retains the draft', async () => {
  const f = await fixture('master', false, async (body) =>
    json({
      dryRun: true,
      message: 'Validated',
      title: body.title,
      path: body.path,
      user: { ...user(), githubToken: 'strip' },
      contentBytes: Buffer.byteLength(body.content),
      originalContentBytes: Buffer.byteLength(body.originalContent),
      source: body.source,
      branch: body.branch,
      reviewBranch: success.branch,
    }),
  );
  const receipt = await f.workflow.submit(f.session, description, f.drafts);
  assert.ok('dryRun' in receipt.result);
  assert.equal((receipt.result as any).user.githubToken, undefined);
  assert.equal(f.workflow.complete(receipt), false);
  assert.ok(f.drafts.hasDraft('test.txt'));
});
test('UTF-8 byte limits, changed nonempty source and description limits fail before network', async () => {
  const f = await fixture();
  const payload = await f.session.prepareUpdate(description, f.loaded);
  for (const changed of [
    { content: ' ' },
    { content: payload.originalContent },
    { notes: ' ' },
    { title: 'x'.repeat(121) },
    { notes: 'x'.repeat(2001) },
    { content: 'é'.repeat(1024 * 1024 + 1) },
    { originalContent: 'é'.repeat(1024 * 1024 + 1) },
  ])
    assert.throws(() => validateUpdate({ ...payload, ...changed }));
  for (const value of [
    { ...success, path: 'other.txt' },
    { ...success, reusedReview: 'false' },
    { ...success, branch: '' },
    null,
  ])
    assert.throws(() => parseSubmissionResult(value, payload));
});
test('release switches default closed and production editing/submission require public authentication', async () => {
  assert.deepEqual(releaseFlags(false), {
    authentication: false,
    authenticatedEditing: false,
    submission: false,
    localEditing: false,
  });
  assert.equal(
    releaseFlags(false, undefined, 'true', 'true').submission,
    false,
  );
  assert.equal(releaseFlags(false, 'true', 'true', 'true').submission, true);
  assert.equal(releaseFlags(true).localEditing, true);
  assert.equal(releaseFlags(true, undefined, 'true', 'true').submission, true);
  const f = await fixture();
  const disabled = new GuideApi(true, async () => {
    assert.fail('Disabled request');
  });
  await assert.rejects(
    disabled.submit(
      await f.session.prepareUpdate(description, f.loaded),
      'github:42',
    ),
    /not enabled/,
  );
});

test('retirement markers cannot erase a newer cross-tab save between comparison and completion', async () => {
  const f = await fixture();
  const receipt = await f.workflow.submit(f.session, description, f.drafts);
  const originalSet = f.storage.setItem.bind(f.storage);
  let injected = false;
  f.storage.setItem = (key, value) => {
    if (key.includes(':submitted:') && !injected) {
      injected = true;
      f.session.setDocument('Cross-tab newer source\r\n');
      f.drafts.save(f.session);
    }
    originalSet(key, value);
  };
  assert.equal(f.workflow.complete(receipt), true);
  assert.ok(f.drafts.hasDraft('test.txt'));
  const restored = await EditSession.create(f.session.map, f.loaded);
  assert.equal(f.drafts.restore(restored).status, 'restored');
  assert.equal(restored.content(), 'Cross-tab newer source\r\n');
});

test('storage failure retains contributor drafts in tab memory across forced session suspension', async () => {
  const f = await fixture();
  const unavailable = {
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('full');
    },
    removeItem() {
      throw Error('blocked');
    },
  };
  const drafts = new DraftStorage(unavailable, 'github:42');
  assert.match(drafts.save(f.session)!, /remain in this tab/);
  const fresh = await EditSession.create(f.session.map, f.loaded);
  assert.equal(
    new DraftStorage(unavailable, 'github:99').hasDraft(f.session.path),
    false,
  );
  assert.equal(
    new DraftStorage(unavailable, 'github:42').restore(fresh).status,
    'restored',
  );
  assert.equal(fresh.content(), f.session.content());
});
