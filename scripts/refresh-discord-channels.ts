import { writeFileSync } from 'node:fs';
const source =
  'https://raw.githubusercontent.com/pvme/pvme-settings/pvme-discord/channels.json';
const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
if (!response.ok)
  throw new Error(`Channel metadata request failed: HTTP ${response.status}`);
const raw: unknown = await response.json();
if (!Array.isArray(raw) || !raw.length)
  throw new Error('Expected a nonempty channel metadata array');
const channels = raw.map((item) => {
  if (
    !item ||
    typeof item !== 'object' ||
    !/^\d{17,20}$/.test(String(item.id)) ||
    typeof item.name !== 'string' ||
    (item.path != null && typeof item.path !== 'string')
  )
    throw new Error('Invalid public channel metadata record');
  return { id: String(item.id), name: item.name, path: item.path || null };
});
writeFileSync(
  new URL('../src/data/discord-channels.json', import.meta.url),
  JSON.stringify({ source, channels }, null, 2) + '\n',
);
console.log(
  `Refreshed ${channels.length} public Discord channels (${channels.filter((c) => c.path).length} explicit paths).`,
);
