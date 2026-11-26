import type { LinkPage } from './guide-source-provider';

export const pvmeChannelUrl = (id: string) =>
  `https://discord.com/channels/534508796639182860/${id}`;

export function pvmeChannelId(value: string) {
  try {
    const url = new URL(value);
    if (
      !/^https?:$/.test(url.protocol) ||
      !/^(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com$/.test(url.hostname) ||
      url.search ||
      url.hash
    )
      return;
    return /^\/channels\/534508796639182860\/(\d{5,25})\/?$/.exec(
      url.pathname,
    )?.[1];
  } catch {
    return;
  }
}

export function linkSourceUrl(value: string, pages: LinkPage[], base?: string) {
  const url = new URL(value.trim(), base);
  if (!/^https?:$/.test(url.protocol) || /[\s<>"'\\]/.test(value.trim()))
    throw new Error('Enter an HTTP or HTTPS URL without spaces');
  const page = pages.find((page) => {
    const local = new URL(page.href, base || page.url);
    return url.href === local.href || url.href === page.url;
  });
  return page?.sourceUrl || value.trim();
}

export function linkDisplayUrl(
  value: string,
  pages: LinkPage[],
  base?: string,
) {
  const page = pages.find((page) => page.sourceUrl === value);
  return page ? new URL(page.href, base || page.url).href : value;
}
