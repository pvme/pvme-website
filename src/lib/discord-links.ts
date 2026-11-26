import {
  parseGuide,
  type BlockNode,
  type InlineNode,
} from '@pvme/guide-parser';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  getCatalogue,
  sourcePath,
  url,
  type Guide,
  type Hub,
} from './catalogue';
import metadata from '../data/discord-channels.json';
import { guideSectionDestination } from './guide-destinations';
import { resourceCategories } from './resource-guides';

const guild = '534508796639182860';
export interface DiscordChannel {
  id: string;
  name?: string;
  path?: string | null;
  messages?: Record<string, { tag?: string; line?: number }>;
}
export function discordAddress(raw: string) {
  try {
    const address = new URL(raw);
    if (
      !['http:', 'https:'].includes(address.protocol) ||
      !/^(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com$/.test(address.hostname)
    )
      return;
    const match = /^\/channels\/(\d+)\/(\d+)(?:\/(\d+))?\/?$/.exec(
      address.pathname,
    );
    if (!match || match[1] !== guild) return;
    return {
      channel: match[2],
      message: match[3],
      tag: decodeURIComponent(address.hash.slice(1)),
    };
  } catch {
    return;
  }
}
const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .replace(
      /\b(hm|nm|mage|range)\b/g,
      (word) =>
        ({
          hm: 'hard mode',
          nm: 'normal mode',
          mage: 'magic',
          range: 'ranged',
        })[word]!,
    )
    .replace(/[^a-z0-9]+/g, '');
const text = (nodes: InlineNode[]): string =>
  nodes
    .map((node) =>
      'children' in node
        ? text(node.children)
        : node.type === 'text'
          ? node.value
          : '',
    )
    .join('');
const headings = (
  blocks: BlockNode[],
): Extract<BlockNode, { type: 'heading' }>[] =>
  blocks.flatMap((block) =>
    block.type === 'heading'
      ? [block]
      : block.type === 'list'
        ? block.items.flatMap((item) => headings(item.children))
        : block.type === 'blockquote'
          ? headings(block.children)
          : [],
  );
type Destination = { href: string; title: string; guides: Guide[] };
type DirectoryLink = { raw: string; label: string; context: string };

export function createDiscordLinkResolver(
  guides: Guide[],
  hubs: Hub[],
  root: string,
  channels: DiscordChannel[],
  directoryLinks: DirectoryLink[] = [],
) {
  const targets = new Map<string, Destination>();
  const exactMessages = new Map<string, Destination>();
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const toGuide = (guide: Guide): Destination => ({
    href: guide.href,
    title: guide.title,
    guides: [guide],
  });
  const unique = (matches: Guide[]) =>
    matches.length === 1 ? toGuide(matches[0]) : undefined;
  const namedGuide = (name: string, pool = guides) =>
    normalize(name)
      ? unique(
          pool.filter((guide) =>
            [guide.title, basename(guide.path, '.txt'), ...guide.aliases].some(
              (alias) => normalize(alias) === normalize(name),
            ),
          ),
        )
      : undefined;
  const namedHub = (name: string) => {
    if (!normalize(name)) return;
    const matches = hubs.filter((hub) =>
      [hub.name, hub.name.split(',')[0], hub.id, hub.slug].some(
        (alias) => normalize(alias) === normalize(name),
      ),
    );
    return matches.length === 1
      ? {
          href: matches[0].href,
          title: matches[0].name,
          guides: matches[0].guides,
        }
      : undefined;
  };
  const namedDirectory = (name: string): Destination | undefined => {
    const routes: Record<string, string> = {
      rs3slayer: '/slayer/',
      upgradeorder: '/resources/upgrade-orders/',
      basicguides: '/bosses/',
      fullbossguides: '/bosses/',
      rs3fullbossguides: '/bosses/',
    };
    if (routes[normalize(name)])
      return {
        href: routes[normalize(name)],
        title:
          normalize(name) === 'upgradeorder'
            ? 'Upgrade Order'
            : normalize(name) === 'rs3slayer'
              ? 'Slayer'
              : 'Bosses',
        guides: [],
      };
    const categories = [...new Set(guides.map((g) => g.category))].filter(
      (category) => normalize(category) === normalize(name),
    );
    if (categories.length === 1)
      return {
        href:
          resourceCategories(guides).find((category) =>
            category.guides.some((guide) => guide.category === categories[0]),
          )?.href || '/resources/',
        title: categories[0],
        guides: guides.filter((g) => g.category === categories[0]),
      };
  };
  for (const channel of channels) {
    const target = channel.path
      ? unique(guides.filter((g) => g.path === channel.path))
      : channel.name
        ? namedGuide(channel.name) ||
          namedHub(channel.name) ||
          namedDirectory(channel.name)
        : undefined;
    if (target) targets.set(channel.id, target);
  }
  const proposals = new Map<string, Map<string, Destination>>();
  for (const link of directoryLinks) {
    const address = discordAddress(link.raw);
    if (!address) continue;
    const parts = link.context.replace(/\\/g, '/').split('/');
    const category = parts[2];
    const folder =
      (
        {
          'full-guides': 'rs3-full-boss-guides',
          'misc-info': 'miscellaneous-information',
        } as Record<string, string>
      )[category] || category;
    let pool = guides.filter((g) => g.path.startsWith(folder + '/'));
    if (!pool.length) pool = guides;
    const contextHubs = hubs.filter((hub) =>
      parts
        .slice(3)
        .some(
          (part) => normalize(part.replace(/\.txt$/, '')) === normalize(hub.id),
        ),
    );
    if (contextHubs.length === 1)
      pool = pool.filter((g) =>
        contextHubs[0].guides.some((v) => v.id === g.id),
      );
    let target = namedGuide(link.label, pool);
    if (!target && contextHubs.length === 1) {
      const subject = normalize(
        contextHubs[0].guides[0]?.subject || contextHubs[0].name,
      );
      target = unique(
        pool.filter(
          (g) =>
            normalize(g.title).replace(new RegExp('^' + subject), '') ===
            normalize(link.label),
        ),
      );
    }
    if (!target) continue;
    const key =
      address.message && address.message !== address.channel
        ? `${address.channel}/${address.message}`
        : address.channel;
    const options = proposals.get(key) || new Map<string, Destination>();
    options.set(target.href, target);
    proposals.set(key, options);
  }
  for (const [key, options] of proposals) {
    if (options.size !== 1) continue;
    const target = [...options.values()][0];
    if (key.includes('/')) exactMessages.set(key, target);
    else if (!targets.has(key)) targets.set(key, target);
  }
  const documents = new Map<string, ReturnType<typeof parseGuide>>();
  const documentFor = (guide: Guide) => {
    let doc = documents.get(guide.path);
    if (!doc) {
      doc = parseGuide(readFileSync(sourcePath(root, guide.path), 'utf8'));
      documents.set(guide.path, doc);
    }
    return doc;
  };
  const anchorFor = (
    guide: Guide,
    label: string,
    tag?: string,
    line?: number,
  ) => {
    const doc = documentFor(guide);
    if (tag && Object.hasOwn(doc.tags, tag)) return `${guide.id}--${tag}`;
    const list = doc.messages.flatMap((message) => headings(message.blocks));
    const matches = line
      ? list.filter((h) => h.range.startLine === line)
      : label
        ? list.filter((h) => normalize(text(h.children)) === normalize(label))
        : [];
    if (matches.length !== 1) return;
    let id = `heading-${matches[0].range.startLine}`;
    while (Object.hasOwn(doc.tags, id)) id += '-heading';
    return `${guide.id}--${id}`;
  };
  const resolve = (raw: string, label = '') => {
    const address = discordAddress(raw);
    if (!address) return;
    const target =
      (address.message
        ? exactMessages.get(`${address.channel}/${address.message}`) ||
          targets.get(address.message)
        : undefined) || targets.get(address.channel);
    if (!target) return;
    if (address.message || address.tag) {
      const explicit = address.message
        ? byId.get(address.channel)?.messages?.[address.message]
        : undefined;
      const matches = target.guides.flatMap((guide) => {
        const anchor = anchorFor(
          guide,
          label,
          explicit?.tag || address.tag,
          explicit?.line,
        );
        return anchor ? [{ guide, anchor }] : [];
      });
      if (matches.length === 1)
        return url(
          guideSectionDestination(matches[0].guide, matches[0].anchor),
        );
    }
    return url(target.href);
  };
  return {
    resolve,
    pages: [...targets].map(([channel, target]) => ({
      title: target.title,
      href: url(target.href),
      sourceUrl: `https://discord.com/channels/${guild}/${channel}`,
    })),
    title: (raw: string) => {
      const address = discordAddress(raw);
      if (!address) return;
      return (
        (address.message
          ? exactMessages.get(`${address.channel}/${address.message}`) ||
            targets.get(address.message)
          : undefined) || targets.get(address.channel)
      )?.title;
    },
    channelCount: targets.size,
    messageCount: exactMessages.size,
  };
}

function directoryReferences(root: string): DirectoryLink[] {
  const references: DirectoryLink[] = [];
  const visitInline = (nodes: InlineNode[], context: string) =>
    nodes.forEach((node) => {
      if (node.type === 'link' && discordAddress(node.url))
        references.push({ raw: node.url, label: text(node.children), context });
      else if ('children' in node) visitInline(node.children, context);
    });
  const visitEmbed = (value: unknown, context: string) => {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, any>;
    for (const content of [
      v.description,
      v.content,
      ...(Array.isArray(v.fields)
        ? v.fields.flatMap((f: any) => [f.name, f.value])
        : []),
    ])
      if (typeof content === 'string') visitText(content, context);
    if (v.embed) visitEmbed(v.embed, context);
    if (Array.isArray(v.embeds))
      v.embeds.forEach((embed) => visitEmbed(embed, context));
  };
  const visitBlocks = (blocks: BlockNode[], context: string) =>
    blocks.forEach((block) => {
      if (block.type === 'list')
        block.items.forEach((item) => visitBlocks(item.children, context));
      else if (block.type === 'blockquote')
        visitBlocks(block.children, context);
      else if (block.type === 'embed' && block.valid)
        visitEmbed(block.value, context);
      else if ('children' in block && Array.isArray(block.children))
        visitInline(block.children as InlineNode[], context);
    });
  const visitText = (source: string, context: string) =>
    parseGuide(source).messages.forEach((message) =>
      visitBlocks(message.blocks, context),
    );
  const walk = (folder: string, relative: string) => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory())
        walk(join(folder, entry.name), `${relative}/${entry.name}`);
      else if (entry.name.endsWith('.txt'))
        visitText(
          readFileSync(sourcePath(root, `${relative}/${entry.name}`), 'utf8'),
          `${relative}/${entry.name}`,
        );
    }
  };
  walk(join(root, 'navigation/directory'), 'navigation/directory');
  return references;
}
let cached: ReturnType<typeof createDiscordLinkResolver> | undefined;
export function getDiscordLinkResolver() {
  if (!cached) {
    const { guides, bosses, slayer, root } = getCatalogue();
    const channels: DiscordChannel[] = metadata.channels;
    const extra = process.env.DISCORD_LINKS_FILE;
    const records = extra
      ? [...channels, ...JSON.parse(readFileSync(extra, 'utf8')).channels]
      : channels;
    cached = createDiscordLinkResolver(
      guides,
      [...bosses, ...slayer],
      root,
      records,
      directoryReferences(root),
    );
  }
  return cached;
}
