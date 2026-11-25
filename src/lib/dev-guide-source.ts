import { readFileSync } from 'node:fs';
import { sourcePath } from './catalogue';
import { getDiscordLinkResolver } from './discord-links';
import type { LoadedGuideSource } from './guide-source-provider';

/** Called only by the opt-in Vite development middleware. Never writes sources. */
export function loadDevelopmentSource(
  path: string,
  root: string,
  guides: readonly { path: string; title: string }[],
): LoadedGuideSource {
  if (
    !path ||
    path.startsWith('/') ||
    /[\\:\u0000-\u001f]/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid guide path');
  const guide = guides.find((guide) => guide.path === path);
  if (!guide) throw new Error('Guide is not in the published catalogue');
  const originalText = readFileSync(sourcePath(root, path), 'utf8');
  const previewLinks: NonNullable<LoadedGuideSource['previewLinks']> = {};
  for (const match of originalText.matchAll(
    /<#(\d+)>|https?:\/\/(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/channels\/\d+\/\d+(?:\/\d+)?/g,
  )) {
    const raw = match[1]
      ? `https://discord.com/channels/534508796639182860/${match[1]}`
      : match[0];
    const resolver = getDiscordLinkResolver();
    const href = resolver.resolve(raw, '');
    if (href) previewLinks[raw] = { href, title: resolver.title(raw) };
  }
  return {
    path,
    previewLinks,
    originalText,
    name: guide.title,
    repo: 'pvme/pvme-guides',
    baseBranch: 'master',
    source: 'master',
    branch: 'master',
  };
}
