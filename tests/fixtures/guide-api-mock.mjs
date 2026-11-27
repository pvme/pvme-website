// Explicit browser QA fixture. Synthetic PR lifecycle only; never contacts external services.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
let identity = '42',
  review = false,
  stale = false,
  scenario = 'success',
  posts = 0,
  headSha = 'a'.repeat(40),
  prId = 1001,
  prNumber = 123,
  longProfile = false;
const submitted = new Map();
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'http://localhost:8080');
  const user =
    identity === 'anonymous'
      ? null
      : {
          provider: 'github',
          githubId: identity,
          githubLogin: `mock-${identity}`,
          username: `mock-${identity}`,
          globalName: '',
          displayName: longProfile
            ? `An exceptionally long contributor display name ${identity} with Unicode Ω and words`
            : `Mock contributor ${identity}`,
          avatar: longProfile
            ? 'https://avatars.githubusercontent.com/u/1?v=4'
            : '',
          csrfToken: `browser-mock-csrf-${identity}`,
          canReviewPrs: false,
        };
  const send = (data, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  };
  const branch = `guide-editor/github-${identity}/browser-mock`,
    prUrl = `https://github.com/pvme/pvme-guides/pull/${prNumber}`;
  const contributor = user ? `github:${user.githubId}` : null;
  const reviewState = review
    ? {
        state: 'present',
        repository: `${user?.githubLogin}/pvme-guides`,
        branch,
        headSha,
        prId,
        prNumber,
        prUrl,
      }
    : { state: 'none' };
  if (url.pathname === '/__test') {
    identity = url.searchParams.get('identity') || identity;
    if (url.searchParams.has('review'))
      review = url.searchParams.get('review') === '1';
    if (url.searchParams.has('stale'))
      stale = url.searchParams.get('stale') === '1';
    scenario = url.searchParams.get('scenario') || scenario;
    if (url.searchParams.has('head'))
      headSha = url.searchParams.get('head').repeat(40).slice(0, 40);
    if (url.searchParams.has('prId'))
      prId = Number(url.searchParams.get('prId'));
    if (url.searchParams.has('prNumber'))
      prNumber = Number(url.searchParams.get('prNumber'));
    if (url.searchParams.has('profile'))
      longProfile = url.searchParams.get('profile') === 'long';
    if (url.searchParams.get('reset') === '1') {
      submitted.clear();
      ((posts = 0),
        (headSha = 'a'.repeat(40)),
        (prId = 1001),
        (prNumber = 123),
        (longProfile = false));
    }
    return send({
      ok: true,
      identity,
      review,
      stale,
      scenario,
      posts,
      headSha,
      prId,
      prNumber,
    });
  }
  if (url.pathname === '/' && req.method === 'GET')
    return send({
      ok: true,
      repo: 'pvme/pvme-guides',
      baseBranch: 'master',
      mode: scenario === 'dry-run' ? 'dry-run' : 'live',
    });
  if (url.pathname === '/' && req.method === 'POST')
    return send(
      { error: 'Use strict v2 route', code: 'STRICT_ROUTE_REQUIRED' },
      400,
    );
  if (url.pathname === '/auth/me') return send({ user });
  if (url.pathname === '/auth/logout') {
    if (req.headers['x-pvme-csrf-token'] !== user?.csrfToken)
      return send({ error: 'CSRF rejected' }, 403);
    identity = 'anonymous';
    return send({ ok: true });
  }
  if (url.pathname === '/v2/submissions' && req.method === 'POST') {
    posts++;
    const mode = scenario;
    if (mode === 'legacy') return send({ error: 'Route not found' }, 404);
    if (!user) return send({ error: 'Session expired' }, 401);
    if (req.headers['x-pvme-csrf-token'] !== user.csrfToken)
      return send(
        {
          error: 'Your login session could not be verified.',
          code: 'CSRF_INVALID',
        },
        403,
      );
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return send({ error: 'Invalid JSON' }, 400);
    }
    if (body.contractVersion !== 2)
      return send(
        { error: 'Invalid strict contract', code: 'INVALID_CONTRACT' },
        400,
      );
    if (body.expectedContributor !== contributor)
      return send(
        { error: 'Contributor changed', code: 'CONTRIBUTOR_MISMATCH' },
        409,
      );
    if (mode === 'csrf')
      return send(
        { error: 'Explicit CSRF rejected', code: 'CSRF_INVALID' },
        403,
      );
    const expected = body.expectedReview;
    if (
      mode !== 'dry-run' &&
      (!expected ||
        Object.keys(reviewState).some(
          (key) => expected[key] !== reviewState[key],
        ))
    )
      return send(
        { error: 'Immutable review changed', code: 'REVIEW_STATE_CONFLICT' },
        409,
      );
    if (review && body.source === 'master' && !body.replaceExistingReview)
      return send(
        { error: 'Confirm replacement', code: 'REPLACEMENT_CONSENT_REQUIRED' },
        409,
      );
    const reusedReview = review;
    if (mode === 'delay') await new Promise((done) => setTimeout(done, 2000));
    if (mode === 'network') {
      req.socket.destroy();
      return;
    }
    if (mode === 'conflict')
      return send(
        { error: 'Source changed during submission', code: 'SOURCE_CONFLICT' },
        409,
      );
    if (mode === 'fork')
      return send(
        { error: 'Fork workflow files differ', code: 'FORK_SYNC_REQUIRED' },
        409,
      );
    if (mode === 'server')
      return send({ error: 'Guide update submission failed.' }, 500);
    if (mode === 'dry-run')
      return send({
        contractVersion: 2,
        contributor,
        reviewStateVerified: false,
        dryRun: true,
        message: 'Mock dry-run validation; no GitHub changes',
        path: body.path,
        title: body.title,
        user,
        contentBytes: Buffer.byteLength(body.content),
        originalContentBytes: Buffer.byteLength(body.originalContent),
        source: body.source,
        branch: body.branch,
        reviewBranch: branch,
      });
    if (review && body.source === 'master' && !body.replaceExistingReview)
      return send({ error: 'Explicit replacement consent required' }, 409);
    if (identity === user.githubId) {
      review = true;
      headSha = 'b'.repeat(40);
    }
    submitted.set(`${user.githubId}:${body.path}`, body.content);
    return send(
      {
        contractVersion: mode === 'bad-result' ? 1 : 2,
        contributor,
        prUrl,
        branch,
        path: body.path,
        reusedReview,
      },
      reusedReview ? 200 : 201,
    );
  }
  if (url.pathname === '/guides/load' && user) {
    const path = url.searchParams.get('path');
    if (!path || path.includes('..') || /[\\:]/.test(path))
      return send({ error: 'Invalid fixture path' }, 400);
    try {
      const loaded = JSON.parse(
        await readFile(
          new URL(`../../dist/guide-source/${path}.json`, import.meta.url),
          'utf8',
        ),
      );
      if (scenario === 'dry-run') {
        if (url.searchParams.get('source') === 'review')
          return send({ error: 'Dry-run review unavailable' }, 404);
        return send({
          ...loaded,
          prUrl: '',
          reviewState: { state: 'unverified' },
          dryRun: true,
        });
      }
      const metadata = scenario === 'missing-meta' ? {} : { reviewState };
      if (review && url.searchParams.get('source') === 'auto')
        return send({
          ...metadata,
          hasExistingReview: true,
          path,
          name: loaded.name,
          repo: loaded.repo,
          baseBranch: 'master',
          liveBranch: 'master',
          reviewBranch: branch,
          prUrl,
        });
      if (review && url.searchParams.get('source') === 'review')
        return send({
          ...loaded,
          ...metadata,
          originalText:
            submitted.get(`${identity}:${path}`) ||
            loaded.originalText + (stale ? '\nReview only change\n' : ''),
          source: 'user-pr',
          branch,
          prUrl,
        });
      return send({
        ...loaded,
        prUrl: '',
        ...metadata,
        ...(review
          ? { existingReviewBranch: branch, existingReviewUrl: prUrl }
          : {}),
      });
    } catch {
      return send({ error: 'Fixture guide unavailable' }, 404);
    }
  }
  return send({ error: 'Browser fixture: route unavailable' }, 401);
});
server.listen(8080, 'localhost', () =>
  console.log(
    'Mock guide API on localhost:8080; synthetic submissions only; no external calls.',
  ),
);
