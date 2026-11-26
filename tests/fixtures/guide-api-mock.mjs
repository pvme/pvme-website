// Explicit browser QA fixture. Synthetic PR lifecycle only; never contacts external services.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
let identity = '42',
  review = false,
  stale = false,
  scenario = 'success',
  posts = 0;
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
          displayName: `Mock contributor ${identity}`,
          avatar: '',
          csrfToken: `browser-mock-csrf-${identity}`,
          canReviewPrs: false,
        };
  const send = (data, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(data));
  };
  const branch = `guide-editor/github-${identity}/browser-mock`,
    prUrl = 'https://github.com/pvme/pvme-guides/pull/123';
  if (url.pathname === '/__test') {
    identity = url.searchParams.get('identity') || identity;
    if (url.searchParams.has('review'))
      review = url.searchParams.get('review') === '1';
    if (url.searchParams.has('stale'))
      stale = url.searchParams.get('stale') === '1';
    scenario = url.searchParams.get('scenario') || scenario;
    if (url.searchParams.get('reset') === '1') {
      submitted.clear();
      posts = 0;
    }
    return send({ ok: true, identity, review, stale, scenario, posts });
  }
  if (url.pathname === '/auth/me') return send({ user });
  if (url.pathname === '/auth/logout') {
    if (req.headers['x-pvme-csrf-token'] !== user?.csrfToken)
      return send({ error: 'CSRF rejected' }, 403);
    identity = 'anonymous';
    return send({ ok: true });
  }
  if (url.pathname === '/' && req.method === 'POST') {
    posts++;
    if (!user) return send({ error: 'Session expired' }, 401);
    if (req.headers['x-pvme-csrf-token'] !== user.csrfToken)
      return send({ error: 'Your login session could not be verified.' }, 403);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return send({ error: 'Invalid JSON' }, 400);
    }
    if (scenario === 'delay')
      await new Promise((done) => setTimeout(done, 2000));
    if (scenario === 'network') {
      req.socket.destroy();
      return;
    }
    if (scenario === 'conflict')
      return send(
        { error: 'Source changed during submission', code: 'SOURCE_CONFLICT' },
        409,
      );
    if (scenario === 'fork')
      return send(
        { error: 'Fork workflow files differ', code: 'FORK_SYNC_REQUIRED' },
        409,
      );
    if (scenario === 'server')
      return send({ error: 'Guide update submission failed.' }, 500);
    if (scenario === 'dry-run')
      return send({
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
    const reusedReview = review;
    review = true;
    submitted.set(`${identity}:${body.path}`, body.content);
    return send(
      { prUrl, branch, path: body.path, reusedReview },
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
      if (review && url.searchParams.get('source') === 'auto')
        return send({
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
          originalText:
            submitted.get(`${identity}:${path}`) ||
            loaded.originalText + (stale ? '\nReview only change\n' : ''),
          source: 'user-pr',
          branch,
          prUrl,
        });
      return send({
        ...loaded,
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
