import type { APIRoute } from 'astro';
import { getCatalogue, url } from '../lib/catalogue';
import { websiteCollections } from '../lib/collections';
import { getDiscordLinkResolver } from '../lib/discord-links';
import { pageLinkTitle } from '../lib/page-link-title';
import type { LinkPage } from '../lib/guide-source-provider';

export const GET: APIRoute = ({ site }) => {
  const catalogue = getCatalogue();
  const pages = new Map<string, LinkPage>();
  const add = (title: string, href: string, sourceUrl?: string) => {
    if (pages.has(href)) return;
    const absolute = new URL(href, site).href;
    pages.set(href, {
      title: pageLinkTitle(title),
      href,
      url: absolute,
      sourceUrl: sourceUrl || absolute,
    });
  };
  // Channel-backed destinations take precedence over ordinary website URLs.
  for (const page of getDiscordLinkResolver().pages)
    add(page.title, page.href, page.sourceUrl);
  for (const page of [...catalogue.bosses, ...catalogue.slayer])
    add(page.name, url(page.href));
  for (const page of websiteCollections(catalogue))
    add(page.title, url(page.href));
  for (const page of catalogue.guides) add(page.title, url(page.href));
  for (const [title, href] of [
    ['Home', '/'],
    ['Bosses', '/bosses/'],
    ['Slayer', '/slayer/'],
    ['Resources', '/resources/'],
    ['Tools', '/tools/'],
  ])
    add(title, url(href));
  return new Response(
    JSON.stringify(
      [...pages.values()].sort((a, b) => a.title.localeCompare(b.title)),
    ),
    {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    },
  );
};
