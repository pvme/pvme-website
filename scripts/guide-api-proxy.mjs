/** Server-only Vite middleware. Never included in the static site. */
export function guideApiProxy(env) {
  return {
    name: 'pvme-guide-api-local',
    apply: 'serve',
    enforce: 'post',
    configureServer(server) {
      // Install before Astro's base-path middleware: this endpoint is origin-rooted.
      server.middlewares.use('/api/guide-pr', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const fail = (status, error) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error }));
        };
        if (!['GET', 'POST', 'PUT'].includes(req.method))
          return fail(405, 'Unsupported method.');
        if (
          req.headers.host !== 'localhost:4321' ||
          (req.headers.origin && req.headers.origin !== 'http://localhost:4321')
        )
          return fail(
            403,
            'Use http://localhost:4321 for local authentication.',
          );
        if (!env.PVME_SUBMIT_SECRET)
          return fail(
            503,
            'Configure the local proxy secret and dry-run backend.',
          );
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const headers = {
            'Content-Type': 'application/json',
            'X-PVME-Submit-Secret': env.PVME_SUBMIT_SECRET,
            'X-PVME-Proxy-Origin': 'http://localhost:4321',
          };
          if (req.headers.cookie) headers.Cookie = req.headers.cookie;
          if (req.headers.origin) headers.Origin = req.headers.origin;
          if (req.headers['x-pvme-csrf-token'])
            headers['X-PVME-CSRF-Token'] = req.headers['x-pvme-csrf-token'];
          const url = new URL(req.url || '/', 'http://localhost');
          const response = await fetch(
            `http://localhost:8080${url.pathname}${url.search}`,
            {
              method: req.method,
              headers,
              redirect: 'manual',
              ...(['POST', 'PUT'].includes(req.method)
                ? { body: Buffer.concat(chunks) }
                : {}),
            },
          );
          res.statusCode = response.status;
          res.setHeader(
            'Content-Type',
            response.headers.get('content-type') || 'application/json',
          );
          const location = response.headers.get('location');
          if (location) res.setHeader('Location', location);
          const cookies = response.headers
            .getSetCookie()
            .map((cookie) =>
              cookie
                .replace(/;\s*Secure\b/gi, '')
                .replace(/SameSite=None/gi, 'SameSite=Lax'),
            );
          if (cookies.length) res.setHeader('Set-Cookie', cookies);
          res.end(await response.text());
        } catch {
          fail(502, 'Local guide backend is unreachable at localhost:8080.');
        }
      });
      const layer = server.middlewares.stack.at(-1);
      // Astro prepends its base/route guards in its post hook. Move this exact
      // Connect layer ahead of them after all core middleware has been installed.
      return () => {
        const index = server.middlewares.stack.indexOf(layer);
        if (index >= 0) server.middlewares.stack.splice(index, 1);
        server.middlewares.stack.unshift(layer);
      };
    },
  };
}
