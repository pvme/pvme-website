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
  validateStrictUpdate,
  SubmissionUncertainError,
} from '../src/lib/submission-contract';
import { releaseFlags } from '../src/lib/release-flags';
import { DraftStorage } from '../src/lib/draft-storage';
import type { StrictGuideUpdate } from '../src/lib/submission-contract';
import type { ReviewVersion } from '../src/lib/review-state';
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
  contractVersion: 2 as const,
  contributor: 'github:42' as const,
  prUrl: 'https://github.com/pvme/pvme-guides/pull/123',
  branch: 'guide-editor/github-42/test',
  path: 'test.txt',
  reusedReview: false,
};
const version: ReviewVersion = {
  state: 'present',
  repository: 'mock/pvme-guides',
  branch: success.branch,
  headSha: 'a'.repeat(40),
  prId: 1001,
  prNumber: 123,
  prUrl: success.prUrl,
};
const strict = (
  payload: import('../src/lib/edit-session').GuideUpdatePayload,
  expectedReview: import('../src/lib/review-state').ExpectedReview = {
    state: 'none',
  },
): StrictGuideUpdate => ({
  ...payload,
  contractVersion: 2,
  expectedContributor: 'github:42',
  expectedReview,
});
async function fixture(
  source: 'master' | 'user-pr' = 'master',
  existing = false,
  respond?: (body: any, calls: any[]) => Promise<Response>,
) {
  const original = 'Original é\r\nSecond\n';
  const { rendered } = await createTestGuide(original);
  const loaded = {
    ...testSource(original),
    contributor: 'github:42' as const,
    reviewState:
      existing || source === 'user-pr' ? version : { state: 'none' as const },
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
      assert.equal(String(url), '/api/guide-pr/v2/submissions');
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
  const payload = strict(await f.session.prepareUpdate(description, f.loaded));
  await assert.rejects(f.api.submit(payload, 'github:42'), /already pending/);
  release();
  await pending;
  assert.equal(f.calls.filter((call) => call.init.method === 'POST').length, 1);
});
test('a newer draft saved by Tab B before Tab A submits its older session survives completion', async () => {
  const f = await fixture();
  const { rendered } = await createTestGuide(f.session.originalContent);
  const tabB = await EditSession.create(rendered.sourceMap, f.loaded);
  tabB.setDocument('Tab B newer draft\r\n');
  const tabBStore = new DraftStorage(f.storage, 'github:42');
  tabBStore.save(tabB);
  const newerRevision = tabBStore.snapshot('test.txt');
  const olderContent = f.session.content();

  const receipt = await f.workflow.submit(f.session, description, f.drafts);
  assert.equal(receipt.content, olderContent);
  assert.equal(JSON.parse(f.calls.at(-1).init.body).content, olderContent);
  assert.equal(receipt.storedRevision, undefined);
  assert.equal(f.workflow.complete(receipt), false);
  assert.equal(tabBStore.snapshot('test.txt'), newerRevision);
  const recovered = await EditSession.create(rendered.sourceMap, f.loaded);
  assert.equal(tabBStore.restore(recovered).status, 'restored');
  assert.equal(recovered.content(), 'Tab B newer draft\r\n');
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
test('strict CSRF rejection performs no retry or identity refresh', async () => {
  let posts = 0,
    reads = 0;
  const f = await fixture();
  (f.api as any).request = async (url: string) => {
    if (url.endsWith('/auth/me')) {
      reads++;
      return json({ user: user() });
    }
    assert.equal(url, '/api/guide-pr/v2/submissions');
    posts++;
    return json(
      {
        error: 'Your login session could not be verified.',
        code: 'CSRF_INVALID',
      },
      403,
    );
  };
  await assert.rejects(
    f.workflow.submit(f.session, description, f.drafts),
    (error) => error instanceof GuideApiError && error.code === 'CSRF_INVALID',
  );
  assert.equal(posts, 1);
  assert.equal(reads, 1);
  assert.ok(f.drafts.hasDraft('test.txt'));
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
      contractVersion: 2,
      contributor: 'github:42',
      reviewStateVerified: false,
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
  const payload = strict(await f.session.prepareUpdate(description, f.loaded));
  for (const changed of [
    { content: ' ' },
    { content: payload.originalContent },
    { notes: ' ' },
    { title: 'x'.repeat(121) },
    { notes: 'x'.repeat(2001) },
    { content: 'é'.repeat(1024 * 1024 + 1) },
    { originalContent: 'é'.repeat(1024 * 1024 + 1) },
  ])
    assert.throws(() =>
      validateStrictUpdate({ ...payload, ...changed }, user()),
    );
  for (const value of [
    { ...success, path: 'other.txt' },
    { ...success, reusedReview: 'false' },
    { ...success, branch: '' },
    null,
  ])
    assert.throws(() => parseSubmissionResult(value, payload, 201));
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
      strict(await f.session.prepareUpdate(description, f.loaded)),
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

test('strict immutable rechecks reject identical text with changed head, PR identity, appearance or disappearance', async () => {
  const changes = [
    { headSha: 'b'.repeat(40) },
    { prId: 1002 },
    { prNumber: 124, prUrl: 'https://github.com/pvme/pvme-guides/pull/124' },
    { repository: 'other/pvme-guides' },
    { branch: 'guide-editor/github-42/other' },
  ];
  for (const change of changes) {
    const f = await fixture('master', true);
    f.provider.load = async () => ({
      ...f.loaded,
      reviewState: { ...version, ...change },
    });
    await assert.rejects(
      f.workflow.submit(f.session, description, f.drafts, {
        identity: 'github:42',
        review: reviewIdentity(f.session),
      }),
      /metadata changed/,
    );
    assert.equal(
      f.calls.filter((call) => call.init.method === 'POST').length,
      0,
    );
  }
  const f = await fixture();
  f.provider.load = async () => ({ ...f.loaded, reviewState: version });
  await assert.rejects(
    f.workflow.submit(f.session, description, f.drafts),
    /metadata changed/,
  );
  assert.ok(f.drafts.hasDraft('test.txt'));
  const closed = await fixture('master', true);
  closed.provider.load = async () => ({
    ...closed.loaded,
    reviewState: { state: 'none' },
    existingReviewBranch: '',
    existingReviewUrl: '',
  });
  await assert.rejects(
    closed.workflow.submit(closed.session, description, closed.drafts, {
      identity: 'github:42',
      review: reviewIdentity(closed.session),
    }),
    /metadata changed/,
  );
  assert.ok(!closed.calls.some((call) => call.init.method === 'POST'));
  assert.ok(closed.drafts.hasDraft('test.txt'));
});

test('all strict success fields and HTTP creation/update consistency are validated', async () => {
  for (const [status, patch] of [
    [201, { contractVersion: 1 }],
    [201, { contractVersion: undefined }],
    [201, { contributor: 'discord:42' }],
    [201, { contributor: 'github:99' }],
    [200, {}],
    [201, { branch: 'master' }],
    [201, { branch: 'guide-editor/github-99/test' }],
    [201, { prUrl: 'https://github.com/other/repo/pull/123' }],
    [201, { reusedReview: true }],
  ] as const) {
    const f = await fixture('master', false, async () =>
      json({ ...success, ...patch }, status),
    );
    await assert.rejects(
      f.workflow.submit(f.session, description, f.drafts),
      SubmissionUncertainError,
    );
    assert.ok(f.drafts.hasDraft('test.txt'));
    assert.equal(
      f.calls.filter((call) => call.init.method === 'POST').length,
      1,
    );
  }
  const f = await fixture('user-pr', true, async () =>
    json(
      {
        ...success,
        reusedReview: true,
        prUrl: 'https://github.com/pvme/pvme-guides/pull/124',
      },
      200,
    ),
  );
  await assert.rejects(
    f.workflow.submit(f.session, description, f.drafts),
    SubmissionUncertainError,
  );
});

test('an outdated backend or missing strict source metadata cannot downgrade to legacy POST', async () => {
  const f = await fixture('master', false, async () =>
    json({ error: 'Route not found' }, 404),
  );
  await assert.rejects(
    f.workflow.submit(f.session, description, f.drafts),
    (error) => error instanceof GuideApiError && error.status === 404,
  );
  assert.deepEqual(
    f.calls
      .filter((call) => call.init.method === 'POST')
      .map((call) => call.url),
    ['/api/guide-pr/v2/submissions'],
  );
  const g = await fixture();
  const old = await EditSession.create(g.session.map, {
    ...g.loaded,
    reviewState: undefined,
  });
  old.setDocument(g.session.content());
  await assert.rejects(
    g.workflow.submit(old, description, g.drafts),
    /metadata is missing/,
  );
  assert.equal(g.calls.filter((call) => call.init.method === 'POST').length, 0);
  const exported = await old.prepareUpdate(description, old.loaded);
  assert.equal(exported.content, g.session.content());
});

test('captured identity cannot be reassigned to a newly selected draft namespace', async () => {
  const f = await fixture();
  f.api.user = user('99');
  const other = new DraftStorage(f.storage, 'github:99');
  other.save(f.session);
  await assert.rejects(
    f.workflow.submit(f.session, description, other),
    /account changed/,
  );
  assert.ok(other.hasDraft('test.txt'));
  assert.ok(f.drafts.hasDraft('test.txt'));
});

test('typed strict request rejects missing assertions, extra fields and invalid replacement combinations', async () => {
  const { validateStrictUpdate } =
    await import('../src/lib/submission-contract');
  const f = await fixture();
  const payload = strict(await f.session.prepareUpdate(description, f.loaded));
  for (const patch of [
    { contractVersion: 1 },
    { expectedContributor: 'github:0' },
    { expectedContributor: 'discord:01' },
    { expectedReview: undefined },
    { expectedReview: { state: 'none', headSha: 'a'.repeat(40) } },
    { replaceExistingReview: true },
    { sourcePreservation: undefined },
    { notes: 123 },
    { title: 123 },
    { unknown: 'leak' },
    { expectedReview: { ...version, headSha: 'A'.repeat(40) } },
    { expectedReview: { ...version, prId: Number.MAX_SAFE_INTEGER + 1 } },
    { expectedReview: { ...version, prUrl: version.prUrl + '?x=1' } },
    {
      expectedReview: { ...version, repository: 'other/pvme-guides' },
      replaceExistingReview: true,
    },
  ])
    assert.throws(() =>
      validateStrictUpdate({ ...payload, ...patch } as any, user()),
    );
  assert.doesNotThrow(() =>
    validateStrictUpdate(
      { ...payload, title: undefined, existingReviewBranch: undefined },
      user(),
    ),
  );
  assert.throws(() =>
    validateStrictUpdate(
      { ...payload, expectedReview: { state: 'unverified' } } as any,
      user(),
    ),
  );
});

test('strict request assertions are captured before asynchronous identity revalidation', async () => {
  const f = await fixture('master', true);
  const payload: StrictGuideUpdate = {
    ...strict(await f.session.prepareUpdate(description, f.loaded), version),
    replaceExistingReview: true,
  };
  const expected = { ...payload.expectedReview };
  (f.api as any).request = async (url: string, init: RequestInit) => {
    if (url.endsWith('/auth/me')) {
      payload.expectedReview = { ...version, headSha: 'b'.repeat(40) };
      return json({ user: user() });
    }
    assert.deepEqual(JSON.parse(init.body as string).expectedReview, expected);
    return json({ ...success, reusedReview: true }, 200);
  };
  await f.api.submit(payload, 'github:42');
});

test('structured v2 errors preserve drafts without any retry and flag late review conflicts as uncertain', async () => {
  for (const [status, code] of [
    [409, 'CONTRIBUTOR_MISMATCH'],
    [403, 'CSRF_INVALID'],
    [400, 'INVALID_CONTRACT'],
    [400, 'INVALID_CONTRIBUTOR'],
    [400, 'INVALID_REVIEW_STATE'],
    [409, 'REPLACEMENT_CONSENT_REQUIRED'],
    [409, 'REVIEW_STATE_CONFLICT'],
    [409, 'SOURCE_CONFLICT'],
    [409, 'FORK_SYNC_REQUIRED'],
    [400, 'STRICT_ROUTE_REQUIRED'],
  ] as const) {
    const f = await fixture('master', false, async () =>
      json({ error: 'Strict error', code }, status),
    );
    await assert.rejects(
      f.workflow.submit(f.session, description, f.drafts),
      (error) => {
        assert.ok(error instanceof GuideApiError);
        const message = submissionFailure(error);
        assert.match(message, /draft is retained/);
        if (code === 'REVIEW_STATE_CONFLICT')
          assert.match(message, /Publication may already have occurred/);
        return true;
      },
    );
    assert.equal(
      f.calls.filter((call) => call.init.method === 'POST').length,
      1,
    );
    assert.ok(f.drafts.hasDraft('test.txt'));
  }
});

test('saved immutable versions block stale draft restoration while old versionless drafts use only fresh source metadata', async () => {
  const f = await fixture('user-pr', true);
  const { rendered } = await createTestGuide(f.session.originalContent);
  const next = await EditSession.create(rendered.sourceMap, {
    ...f.loaded,
    reviewState: { ...version, headSha: 'b'.repeat(40) },
  });
  assert.equal(f.drafts.restore(next).status, 'blocked');
  assert.ok(f.drafts.hasDraft('test.txt'));
  const raw = JSON.parse(f.drafts.snapshot('test.txt')!);
  delete raw.reviewState;
  f.storage.setItem(f.drafts.key('test.txt'), JSON.stringify(raw));
  assert.equal(f.drafts.restore(next).status, 'restored');
  assert.equal(next.loaded.reviewState?.state, 'present');
  assert.ok(
    next.loaded.reviewState?.state === 'present' &&
      next.loaded.reviewState.headSha === 'b'.repeat(40),
  );
  assert.throws(() => {
    (next.loaded.reviewState as any).headSha = 'c'.repeat(40);
  });
});

test('accepted v2 result keeps its captured identity when the displayed account changes in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture('master', false, async () => {
    await gate;
    return json(success, 201);
  });
  const pending = f.workflow.submit(f.session, description, f.drafts);
  while (!f.calls.some((call) => call.init.method === 'POST'))
    await new Promise((done) => setTimeout(done, 1));
  f.api.user = user('99');
  const other = new DraftStorage(f.storage, 'github:99');
  other.save(f.session);
  const raw = other.snapshot('test.txt');
  release();
  const receipt = await pending;
  assert.equal(receipt.identity, 'github:42');
  assert.equal(receipt.result.contributor, 'github:42');
  f.workflow.complete(receipt);
  assert.equal(other.snapshot('test.txt'), raw);
  assert.equal(f.drafts.hasDraft('test.txt'), false);
});
