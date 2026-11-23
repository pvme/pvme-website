import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { Options } from '../catalogue';
import { LocalError } from './filesystem';
import { createLocalService, type EditRequest, type LocalService } from './service';

export async function readJSON(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new LocalError('JSON content type required.', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk); size += b.length;
    if (size > 128 * 1024) throw new LocalError('Request exceeds 128 KiB.', 413);
    chunks.push(b);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new LocalError('Invalid JSON request.'); }
}
export function assertLocalRequest(req: IncomingMessage, port: number, token: string) {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) throw new LocalError('Only loopback clients may use the local editor.', 403);
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!hosts.includes(req.headers.host ?? '')) throw new LocalError('Invalid local Host header.', 403);
  const origin = `http://${req.headers.host}`;
  if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new LocalError('Cross-origin requests are not allowed.', 403);
  if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['x-local-token'] !== token)) throw new LocalError('A same-origin inspector session is required.', 403);
}
export function localHandler(service: Promise<LocalService>, token: string, port: () => number) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, value: unknown) => {
      res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(JSON.stringify(value));
    };
    try {
      assertLocalRequest(req, port(), token);
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const s = await service;
      if (req.method === 'GET') {
        if (url.pathname === '/api/local/state') return send(200, { catalogue: await s.state(), token });
        if (url.pathname === '/api/local/source') return send(200, await s.source(url.searchParams.get('path') ?? ''));
        if (url.pathname === '/api/local/folders') return send(200, { folders: await s.folders() });
      } else if (req.method === 'POST') {
        const body = await readJSON(req);
        if (url.pathname === '/api/local/preview') return send(200, await s.preview(body as unknown as EditRequest));
        if (url.pathname === '/api/local/apply') return send(200, await s.apply(String(body.id), body.confirmed === true, body.acknowledgeReferences === true));
        if (url.pathname === '/api/local/review') return send(200, { catalogue: await s.decide(String(body.id), String(body.sourceHash), body.decision as never) });
        if (url.pathname === '/api/local/refresh') return send(200, { catalogue: await s.refresh() });
      }
      send(404, { error: 'Unknown local editor endpoint.' });
    } catch (error) {
      const status = error instanceof LocalError ? error.status : (error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM' ? 403 : 500;
      send(status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
export function localEditor(options: Options): Plugin {
  return {
    name: 'pvme-local-editor', apply: 'serve',
    configResolved(config) {
      if (!['127.0.0.1', 'localhost', '::1'].includes(String(config.server.host))) throw new Error('The local editor must bind to localhost. Do not use --host 0.0.0.0.');
      if (config.server.https || config.server.cors === true) throw new Error('The local editor requires local HTTP with CORS disabled.');
    },
    configureServer(server) {
      // Lazy initialization keeps a missing guide directory from preventing the
      // static inspector from starting. Only API requests access local files.
      let service: Promise<LocalService> | undefined;
      const token = randomBytes(32).toString('hex');
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/local/')) return next();
        service ??= createLocalService(options);
        const handler = localHandler(service, token, () => {
          const address = server.httpServer?.address();
          return address && typeof address !== 'string' ? address.port : server.config.server.port ?? 5173;
        });
        void handler(req, res);
      });
    },
  };
}
