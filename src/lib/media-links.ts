import type { InlineNode } from '@pvme/guide-parser';
export type MediaLink = { kind: 'youtube' | 'video' | 'image'; source: string };
export function standaloneMediaRow(nodes: InlineNode[]): boolean {
  let found = false;
  const visit = (nodes: InlineNode[]): boolean =>
    nodes.every((node) => {
      if (node.type === 'link' || node.type === 'image') {
        const media = mediaLink(node.url);
        if (
          !media ||
          (node.type === 'link' &&
            node.suppressEmbed &&
            media.kind !== 'youtube')
        )
          return false;
        found = true;
        return true;
      }
      if (node.type === 'emoji' || node.type === 'line-break') return true;
      if (node.type === 'text') return /^[\s()[\]\/|,·&]*$/.test(node.value);
      return 'children' in node && visit(node.children);
    });
  return visit(nodes) && found;
}
/** Only known player URLs and direct media files are embeddable. */
export function mediaLink(raw: string): MediaLink | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  if (host === 'youtu.be') id = url.pathname.split('/')[1];
  else if (
    [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'youtube-nocookie.com',
      'www.youtube-nocookie.com',
    ].includes(host)
  ) {
    id =
      url.pathname === '/watch'
        ? url.searchParams.get('v') || undefined
        : /^\/(embed|shorts|live)\//.test(url.pathname)
          ? url.pathname.split('/')[2]
          : undefined;
  }
  if (id && /^[\w-]{11}$/.test(id)) {
    const embed = new URL(`https://www.youtube.com/embed/${id}`);
    embed.searchParams.set('playsinline', '1');
    const time =
      url.searchParams.get('start') ||
      url.searchParams.get('t') ||
      new URLSearchParams(url.hash.slice(1)).get('t');
    if (time) {
      const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(time);
      const seconds = /^\d+$/.test(time)
        ? Number(time)
        : parts
          ? Number(parts[1] || 0) * 3600 +
            Number(parts[2] || 0) * 60 +
            Number(parts[3] || 0)
          : 0;
      if (Number.isSafeInteger(seconds) && seconds > 0)
        embed.searchParams.set('start', String(seconds));
    }
    return { kind: 'youtube', source: embed.href };
  }
  if (/\.(mp4|webm)$/i.test(url.pathname))
    return { kind: 'video', source: raw };
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(url.pathname))
    return { kind: 'image', source: raw };
}
