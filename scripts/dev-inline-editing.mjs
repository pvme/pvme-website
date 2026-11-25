/** No production route or generated source files. Registered exclusively for opt-in dev. */
export function developmentInlineEditing() {
  return {
    name: 'pvme-development-inline-editing',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/__dev/guide-source') return next();
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const host = req.headers.host || '';
        const hostname = host.split(':')[0];
        if (
          !['localhost', '127.0.0.1'].includes(hostname) ||
          (req.headers.origin && req.headers.origin !== `http://${host}`) ||
          (req.headers['sec-fetch-site'] &&
            !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
        ) {
          res.statusCode = 403;
          return res.end('Local same-origin requests only');
        }
        if (req.method !== 'GET') {
          res.statusCode = 405;
          return res.end('Read-only endpoint');
        }
        try {
          const { getCatalogue } = await server.ssrLoadModule(
            '/src/lib/catalogue.ts',
          );
          const { loadDevelopmentSource } = await server.ssrLoadModule(
            '/src/lib/dev-guide-source.ts',
          );
          const { root, guides } = getCatalogue();
          const source = loadDevelopmentSource(
            url.searchParams.get('path') || '',
            root,
            guides,
          );
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(source));
        } catch {
          res.statusCode = 404;
          res.end('Guide source unavailable');
        }
      });
    },
  };
}
