import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { guideApiProxy } from '../scripts/guide-api-proxy.mjs';

function response() {
  return {
    statusCode: 200,
    headers: {} as Record<string, any>,
    body: '',
    setHeader(name: string, value: unknown) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body: string) {
      this.body = body;
    },
  };
}
function middleware(secret = 'local-test-only') {
  let handler: any;
  const stack: any[] = [];
  const post = guideApiProxy({
    PVME_SUBMIT_SECRET: secret,
    VITE_GUIDE_PR_ENDPOINT_LIVE: 'https://never-contact.invalid',
  } as any).configureServer({
    middlewares: {
      stack,
      use(prefix: string, fn: any) {
        assert.equal(prefix, '/api/guide-pr');
        handler = fn;
        stack.push({ route: prefix, handle: fn });
      },
    },
  } as any);
  const layer = stack[0];
  stack.unshift({
    route: '',
    handle() {
      assert.fail('Astro base guard must run after the proxy');
    },
  });
  post();
  assert.equal(stack[0], layer);
  return handler;
}
function request(method = 'GET', url = '/auth/me', headers = {}) {
  return Object.assign(
    Readable.from(method === 'GET' ? [] : [Buffer.from('{"token":"mock"}')]),
    { method, url, headers: { host: 'localhost:4321', ...headers } },
  );
}

test('local proxy forwards exact route/query, JSON, cookies and CSRF with fixed authenticated origin; relays redirects and every cookie', async (t) => {
  const calls: any[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('redirect-body', {
        status: 302,
        headers: [
          ['Location', 'https://discord.com/oauth2/authorize?state=signed'],
          ['Set-Cookie', 'nonce=a; Secure; SameSite=None; Path=/'],
          ['Set-Cookie', 'session=b; Secure; SameSite=None; Path=/'],
        ],
      });
    },
  );
  const run = middleware();
  for (const method of ['GET', 'POST', 'PUT']) {
    const route =
      method === 'POST'
        ? '/v2/submissions?strict=2'
        : '/auth/github/callback?code=mock&state=signed';
    const res = response();
    await run(
      request(method, route, {
        cookie: 'session=old',
        'x-pvme-csrf-token': 'csrf-test',
        origin: 'http://localhost:4321',
        'x-pvme-proxy-origin': 'https://attacker.invalid',
      }),
      res,
    );
    assert.equal(res.statusCode, 302);
    assert.equal(res.body, 'redirect-body');
    assert.equal(
      res.headers.location,
      'https://discord.com/oauth2/authorize?state=signed',
    );
    assert.deepEqual(res.headers['set-cookie'], [
      'nonce=a; SameSite=Lax; Path=/',
      'session=b; SameSite=Lax; Path=/',
    ]);
    assert.equal(res.headers['cache-control'], 'no-store');
    const call = calls.at(-1);
    assert.equal(call.url, `http://localhost:8080${route}`);
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.init.headers.Cookie, 'session=old');
    assert.equal(call.init.headers['X-PVME-CSRF-Token'], 'csrf-test');
    assert.equal(
      call.init.headers['X-PVME-Proxy-Origin'],
      'http://localhost:4321',
    );
    assert.equal(call.init.headers['X-PVME-Submit-Secret'], 'local-test-only');
    if (method !== 'GET')
      assert.equal(call.init.body.toString(), '{"token":"mock"}');
  }
});

test('proxy refuses non-local host/origin, missing local secret and unsupported methods without outgoing requests', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    assert.fail('Unexpected upstream request');
  });
  for (const [req, expected, secret] of [
    [request('GET', '/', { host: '127.0.0.1:4321' }), 403, 'test'],
    [request('POST', '/', { origin: 'https://attacker.invalid' }), 403, 'test'],
    [request('GET'), 503, ''],
    [request('DELETE'), 405, 'test'],
  ] as const) {
    const res = response();
    await middleware(secret)(req, res);
    assert.equal(res.statusCode, expected);
  }
});

test('unreachable local backend never falls back to production, including cancelled OAuth callbacks', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url));
    throw new Error('Local offline');
  });
  const res = response();
  await middleware()(
    request('GET', '/auth/discord/callback?error=access_denied&state=signed'),
    res,
  );
  assert.equal(res.statusCode, 502);
  assert.deepEqual(urls, [
    'http://localhost:8080/auth/discord/callback?error=access_denied&state=signed',
  ]);
  assert.equal(guideApiProxy({}).apply, 'serve');
});
