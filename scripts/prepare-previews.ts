import { getCatalogue, sourcePath } from '../src/lib/catalogue';
import {
  analysePresets,
  directImage,
  presetPage,
} from '../src/lib/preset-entries';
import type { PreviewRecord } from '../src/lib/preset-cache';
import { parseGuide } from '@pvme/guide-parser';
import { parseHTML } from 'linkedom';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const manifest = '.cache/preset-previews.json';
if (existsSync('.env')) process.loadEnvFile('.env');
mkdirSync('.cache', { recursive: true });
mkdirSync('public/preset-previews', { recursive: true });
let cache: Record<string, PreviewRecord> = {};
try {
  cache = JSON.parse(readFileSync(manifest, 'utf8'));
} catch {}
const { guides, root } = getCatalogue();
const urls = new Set<string>();
for (const g of guides) {
  const analysis = analysePresets(
    parseGuide(readFileSync(sourcePath(root, g.path), 'utf8')),
  );
  for (const u of analysis.urls)
    if (!analysis.explicitImages.has(u)) urls.add(u);
}
const pending = [...urls].filter((url) => {
  const c = cache[url];
  return (
    !c ||
    Date.now() - c.checkedAt > (c.path ? 7 * 86400000 : 900000) ||
    (c.path && !existsSync('public' + c.path))
  );
});
console.log(
  `Preset previews: ${urls.size} entry destinations, ${pending.length} to resolve.`,
);
let completed = 0,
  failed = 0;
async function request(url: string) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'PvME-Web-Static-Preview/1.0' },
  });
  if (!r.ok) throw Error(String(r.status));
  return r;
}
async function resolvePreview(url: string): Promise<PreviewRecord> {
  let imageUrl = url;
  let width: number | undefined, height: number | undefined;
  if (!directImage(url)) {
    if (!presetPage(url)) throw Error('Unsupported page');
    const r = await request(url);
    const html = await r.text();
    const { document } = parseHTML(html);
    const image =
      document
        .querySelector('meta[property="og:image:secure_url"]')
        ?.getAttribute('content') ||
      document
        .querySelector('meta[property="og:image"]')
        ?.getAttribute('content') ||
      document
        .querySelector('meta[name="twitter:image"]')
        ?.getAttribute('content');
    if (!image) throw Error('No preview metadata');
    imageUrl = new URL(image, r.url).href;
    width =
      Number(
        document
          .querySelector('meta[property="og:image:width"]')
          ?.getAttribute('content'),
      ) || undefined;
    height =
      Number(
        document
          .querySelector('meta[property="og:image:height"]')
          ?.getAttribute('content'),
      ) || undefined;
  }
  const u = new URL(imageUrl);
  if (!['http:', 'https:'].includes(u.protocol))
    throw Error('Invalid image protocol');
  const r = await request(imageUrl);
  const mime = r.headers.get('content-type')?.split(';')[0];
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
  };
  if (!mime || !extensions[mime]) throw Error('Not a supported image');
  if (Number(r.headers.get('content-length')) > 5000000)
    throw Error('Oversized image');
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > 5000000 || bytes.length < 20)
    throw Error('Invalid image size');
  const path = `/preset-previews/${createHash('sha256').update(bytes).digest('hex')}.${extensions[mime]}`;
  writeFileSync('public' + path, bytes);
  return { checkedAt: Date.now(), path, imageUrl, width, height };
}
let cursor = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (cursor < pending.length) {
      const url = pending[cursor++];
      try {
        cache[url] = await resolvePreview(url);
      } catch {
        failed++;
        if (!cache[url]?.path || !existsSync('public' + cache[url].path))
          cache[url] = { checkedAt: Date.now() };
      }
      completed++;
      if (completed % 25 === 0) {
        writeFileSync(manifest, JSON.stringify(cache, null, 2));
        console.log(`Preset previews: ${completed}/${pending.length} checked.`);
      }
    }
  }),
);
writeFileSync(manifest, JSON.stringify(cache, null, 2));
const available = [...urls].filter((u) => cache[u]?.path).length;
console.log(
  `Preset previews: ${available} available; ${urls.size - available} unresolved (original links retained).`,
);
