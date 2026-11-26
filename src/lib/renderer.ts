import {
  parseGuide,
  type BlockNode,
  type InlineNode,
  type HeadingBlock,
} from '@pvme/guide-parser';
import { readFileSync } from 'node:fs';
import { createSourceMapper, sourceFingerprint } from './source-map-builder';
import type { GuideSourceMap } from './source-map';
import { mediaLink, standaloneMediaRow } from './media-links';
import { discordAddress, getDiscordLinkResolver } from './discord-links';
import { pageLinkTitle, pageLinkNodes } from './page-link-title';
import { sourcePath, type Guide, type Method } from './catalogue';
import { analysePresets, type PresetAnalysis } from './preset-entries';
import {
  presetPreviewCache,
  previewVersion,
  type PreviewRecord,
} from './preset-cache';
export const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
const safe = (s: string) => (/^(https?:\/\/|#)/i.test(s) ? escape(s) : '');
const guideHref = (raw: string, label = '') => {
  const local = discordAddress(raw)
    ? getDiscordLinkResolver().resolve(raw, label)
    : undefined;
  return local ? escape(local) : safe(raw);
};
const overlayAttrs = (url: string) => {
  const kind = mediaLink(url)?.kind;
  return kind ? ` data-media-overlay="${kind}" aria-haspopup="dialog"` : '';
};
const plain = (nodes: InlineNode[]): string =>
  nodes
    .map((n) =>
      'children' in n
        ? plain(n.children)
        : n.type === 'text'
          ? n.value
          : n.type === 'emoji'
            ? n.name
            : '',
    )
    .join('');
const labelText = (nodes: InlineNode[]): string =>
  nodes
    .map((n) =>
      'children' in n
        ? labelText(n.children)
        : n.type === 'text'
          ? n.value
          : '',
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
export interface RenderedGuide {
  html: string;
  sourceMap?: GuideSourceMap;
  toc: { id: string; text: string; level: number }[];
  methods: { id: string; anchor: string; resolved: boolean }[];
  image?: string;
}
export function renderGuide(
  source: string,
  guide: Pick<Guide, 'methods' | 'sections'>,
  prefix = '',
  previews: Record<string, PreviewRecord> = presetPreviewCache(),
  options: { referenceTitle?: string; sourcePath?: string } = {},
): RenderedGuide {
  const doc = parseGuide(source);
  const mapper =
    options.sourcePath && !options.referenceTitle
      ? createSourceMapper(doc, options.sourcePath)
      : undefined;
  let mappingEnabled = true;
  const withoutMappings = (render: () => string): string => {
    const previous = mappingEnabled;
    mappingEnabled = false;
    try {
      return render();
    } finally {
      mappingEnabled = previous;
    }
  };
  // Keep style-only ability-bar labels in the image alt text.
  const barLabels = new Set<BlockNode>();
  const barImages = new Map<BlockNode, string>();
  const barNotes = new Map<BlockNode, string>();
  const styleLabelNodes = (nodes: InlineNode[]): boolean =>
    nodes.every(
      (node) =>
        node.type === 'text' ||
        node.type === 'emoji' ||
        (['bold', 'italic', 'underline'].includes(node.type) &&
          'children' in node &&
          styleLabelNodes(node.children)),
    );
  let barSection:
    | { label: BlockNode; image: BlockNode; style: string; note?: string }[]
    | undefined;
  const finishBars = () => {
    if (barSection && barSection.length > 1)
      for (const entry of barSection) {
        barLabels.add(entry.label);
        barImages.set(
          entry.image,
          `${entry.style} ability bar${entry.note ? ` ${entry.note}` : ''}`,
        );
        if (entry.note)
          barNotes.set(entry.image, `${entry.style} ${entry.note}`);
      }
    barSection = undefined;
  };
  const contentBlocks = doc.messages
    .flatMap((message) => message.blocks)
    .filter(
      (block) => !['command', 'blank', 'unknown-command'].includes(block.type),
    );
  for (let index = 0; index < contentBlocks.length; index++) {
    const block = contentBlocks[index];
    if (block.type === 'heading') {
      finishBars();
      if (/^ability bars?$/i.test(labelText(block.children))) barSection = [];
    }
    if (
      !barSection ||
      (block.type !== 'paragraph' &&
        (block.type !== 'list' || block.ordered || block.items.length !== 1))
    )
      continue;
    const children =
      block.type === 'paragraph' ? [block] : block.items[0].children;
    const label =
      children.length === 1 && children[0].type === 'paragraph'
        ? children[0]
        : undefined;
    const match =
      label &&
      /^(magic|melee|necro(?:mancy)?|ranged?)\s*(\([^()\n]+\))?$/i.exec(
        labelText(label.children),
      );
    const style =
      match && (/^necro$/i.test(match[1]) ? 'Necromancy' : match[1]);
    const image = contentBlocks[index + 1];
    if (
      style &&
      label &&
      styleLabelNodes(label.children) &&
      image?.type === 'attachment' &&
      image.kind === 'image'
    ) {
      barSection.push({ label: block, image, style, note: match?.[2] });
    }
  }
  finishBars();
  const presetAnalysis = analysePresets(doc);
  const presetDestinations = new Map(
    [...presetAnalysis.presetImages].map((u) => [u, u]),
  );
  for (const url of presetAnalysis.urls) {
    presetDestinations.set(url, url);
    const image = previews[url]?.imageUrl;
    if (image) presetDestinations.set(image, url);
  }
  let collectedPresets: string[] | undefined;
  let inMechanicMessage = false;
  let presetLabel: InlineNode[] = [];
  const presetLabelNodes = (nodes: InlineNode[]): InlineNode[] =>
    nodes.flatMap((node): InlineNode[] => {
      if (node.type === 'link') return presetLabelNodes(node.children);
      if (node.type === 'image' || node.type === 'line-break') return [];
      return [
        'children' in node
          ? ({
              ...node,
              children: presetLabelNodes(node.children),
            } as InlineNode)
          : node,
      ];
    });
  const presetCard = (destination: string, content: string) => {
    const href = safe(destination);
    if (!href) return content;
    const label = plain(presetLabel).trim() || 'Equipment preset';
    const labelHtml = presetLabel.length
      ? inline(presetLabelNodes(presetLabel), true)
      : escape(label);
    const card = `<a class="preset-preview-card" href="${href}"${overlayAttrs(destination)} rel="noopener noreferrer" aria-label="Open ${escape(label)}"><span class="preset-preview-header"><span class="preset-preview-label" title="${escape(label)}">${labelHtml}</span><span class="preset-preview-action">Open preset ↗</span></span><span class="preset-preview-surface">${content}</span></a>`;
    if (collectedPresets) {
      collectedPresets.push(card);
      return '';
    }
    return card;
  };
  const presetCarousel = (cards: string[]) => {
    const presets = cards.every((card) =>
      card.startsWith('<a class="preset-preview-card"'),
    );
    const name = presets ? 'Presets' : 'Media';
    const label = presets ? 'preset' : 'item';
    return `<section class="preset-carousel" data-preset-carousel role="region" aria-roledescription="carousel" aria-label="${presets ? 'Equipment presets' : 'Media examples'}"><div class="preset-carousel-toolbar"><span>${name} <span data-preset-count aria-live="polite">1 / ${cards.length}</span></span><div class="preset-carousel-controls" hidden><button type="button" data-preset-prev aria-label="Previous ${label}" disabled>←</button><button type="button" data-preset-next aria-label="Next ${label}">→</button></div></div><div class="preset-carousel-track" data-preset-track tabindex="0" aria-label="${name} previews. Scroll or use left and right arrow keys.">${cards.map((card, index) => `<div class="preset-carousel-slide" data-preset-slide role="group" aria-roledescription="slide" aria-label="${index + 1} of ${cards.length}">${card}</div>`).join('')}</div></section>`;
  };
  const previewGroup = (content: string, cards: string[]) =>
    cards.length > 1
      ? `<div data-media-switcher-group>${content}${presetCarousel(cards)}</div>`
      : content + cards.join('');
  const mediaSeen = new WeakMap<string[], Set<string>>();
  const collectMedia = (raw: string, nodes: InlineNode[] = presetLabel) => {
    if (
      !collectedPresets ||
      inMechanicMessage ||
      presetDestinations.has(raw) ||
      (nodes.length > 0 && !standaloneMediaRow(nodes))
    )
      return false;
    const embed = mediaLink(raw);
    if (!embed) return false;
    const seen = mediaSeen.get(collectedPresets) || new Set<string>();
    if (seen.has(raw)) return true;
    seen.add(raw);
    mediaSeen.set(collectedPresets, seen);
    const name = embed.kind === 'image' ? 'image' : 'video';
    const text = plain(nodes).trim();
    const title = !text || text === raw ? `Example ${name}` : text;
    const titleHtml =
      !text || text === raw
        ? escape(title)
        : inline(presetLabelNodes(nodes), true);
    const player =
      embed.kind === 'youtube'
        ? `<iframe data-media-src="${escape(embed.source)}" title="${escape(title)}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe><noscript><a href="${safe(raw)}">Watch on YouTube ↗</a></noscript>`
        : embed.kind === 'video'
          ? `<video controls preload="none" src="${safe(raw)}" aria-label="${escape(title)}"></video>`
          : `<a href="${safe(raw)}"${overlayAttrs(raw)} aria-label="Open ${escape(title)}"><img src="${safe(raw)}" alt="${escape(title)}" loading="lazy" decoding="async"></a>`;
    collectedPresets.push(
      `<div class="media-preview-card"><div class="preset-preview-header"><span class="preset-preview-label">${titleHtml}</span><a class="preset-preview-action" href="${safe(raw)}"${overlayAttrs(raw)} rel="noopener noreferrer">Open ${name} ↗</a></div><div class="media-preview-surface">${player}</div></div>`,
    );
    return true;
  };
  const renderMedia = (raw: string, alt?: string) => {
    if (collectMedia(raw)) return '';
    const content = media(raw, alt);
    const destination = presetDestinations.get(raw);
    return destination && content.startsWith('<img')
      ? presetCard(destination, content)
      : content;
  };
  const preview = (url: string | undefined, analysis: PresetAnalysis) => {
    if (!url) return '';
    const record = previews[url];
    if (
      !record?.path ||
      !record.path.startsWith('/preset-previews/') ||
      analysis.explicitImages.has(url) ||
      presetAnalysis.explicitImages.has(url) ||
      (record.imageUrl &&
        (analysis.explicitImages.has(record.imageUrl) ||
          presetAnalysis.explicitImages.has(record.imageUrl)))
    )
      return '';
    const base = import.meta.env?.BASE_URL?.replace(/\/$/, '') || '';
    return presetCard(
      url,
      `<img class="preset-preview" src="${escape(base + record.path)}" alt="Preset preview" loading="lazy" decoding="async"${record.width && record.height ? ` width="${record.width}" height="${record.height}"` : ''}>`,
    );
  };
  let mechanicSection = 0;
  const mechanicMessages = new Set(
    doc.messages.filter((message) => {
      const titles = message.blocks.filter((block) => block.type === 'heading');
      for (const heading of titles) {
        if (heading.level <= 2)
          mechanicSection = /\bmechanics?\b/i.test(labelText(heading.children))
            ? heading.level
            : 0;
      }
      const labelled = message.blocks.some(
        (block) =>
          block.type === 'paragraph' &&
          /^Mechanic:/i.test(plain(block.children).trimStart()),
      );
      const solution =
        titles.length > 0 &&
        message.blocks.some(
          (block) =>
            block.type === 'paragraph' &&
            /^Solution:/i.test(plain(block.children).trimStart()),
        );
      return (
        labelled ||
        solution ||
        !!(
          mechanicSection &&
          titles.some((heading) => heading.level > mechanicSection)
        )
      );
    }),
  );
  const mechanicHeadings = new Set(
    [...mechanicMessages].flatMap((message) =>
      message.blocks
        .filter((block) => block.type === 'heading')
        .map((heading) => heading.id),
    ),
  );
  const headings: HeadingBlock[] = [];
  const visit = (blocks: BlockNode[]) => {
    for (const b of blocks) {
      if (b.type === 'heading') headings.push(b);
      else if (b.type === 'blockquote') visit(b.children);
      else if (b.type === 'list') b.items.forEach((i) => visit(i.children));
    }
  };
  doc.messages.forEach((m) => visit(m.blocks));
  const ids = new Map(
    headings.map((h) => [h.id, `heading-${h.range.startLine}`]),
  );
  const tagIds = new Map(Object.keys(doc.tags).map((t) => [t, t]));
  // Keep tag anchors at their source message.
  const used = new Set(tagIds.values());
  for (const h of headings) {
    let id = ids.get(h.id)!;
    while (used.has(id)) id += '-heading';
    used.add(id);
    ids.set(h.id, id);
  }
  const extra = new Map<string, string[]>();
  const ownedHeadings = new Map<string, Set<string>>();
  for (const m of guide.methods) {
    const tag = [m.tag, m.anchor].find((t) => t && doc.tags[t]);
    const sectionId = tag && doc.tags[tag].sectionId;
    if (sectionId) {
      const owners = ownedHeadings.get(sectionId) || new Set<string>();
      owners.add(m.id);
      ownedHeadings.set(sectionId, owners);
    }
  }
  const methods = guide.methods.map((m: Method) => {
    const tag = [m.tag, m.anchor].find((t) => t && tagIds.has(t));
    if (tag) return { id: m.id, anchor: tag, resolved: true };
    const location = m.locations?.[0];
    const section = guide.sections.find((s) => s.methodIds.includes(m.id));
    // Match source locations before heading and parent labels.
    const matches = headings.filter(
      (h) =>
        labelText(h.children) === m.label.trim() &&
        (!ownedHeadings.has(h.id) || ownedHeadings.get(h.id)!.has(m.id)),
    );
    const contextual = matches.filter((h) => {
      const s = doc.sections.find((s) => s.id === h.id);
      let parent = s?.parentId;
      const parents: string[] = [];
      while (parent) {
        const p = doc.sections.find((s) => s.id === parent);
        if (!p) break;
        const heading = headings.find((h) => h.id === p.id);
        parents.unshift(heading ? labelText(heading.children) : p.heading);
        parent = p.parentId;
      }
      return m.context.every((c) => parents.includes(c));
    });
    const sectionHeading =
      section &&
      headings.find(
        (h) =>
          h.range.startLine === section.line &&
          labelText(h.children) === m.label.trim(),
      );
    const heading = location
      ? headings.find((h) => h.range.startLine === location.line)
      : sectionHeading ||
        (contextual.length === 1
          ? contextual[0]
          : matches.length === 1
            ? matches[0]
            : undefined);
    if (heading) {
      let anchor = m.anchor || `method-${m.id}`;
      if (used.has(anchor)) anchor = `${anchor}-${m.id}`;
      used.add(anchor);
      extra.set(heading.id, [...(extra.get(heading.id) || []), anchor]);
      return { id: m.id, anchor, resolved: true };
    }
    const fallback =
      section && headings.find((h) => h.range.startLine === section.line);
    return {
      id: m.id,
      anchor: fallback ? ids.get(fallback.id)! : 'guide-start',
      resolved: false,
    };
  });
  const cover = doc.attachments.find(
    (a) =>
      a.kind === 'image' &&
      a.range.startLine < (headings[1]?.range.startLine || Infinity),
  );
  const inline = (
    nodes: InlineNode[],
    linked = false,
    heading = false,
  ): string =>
    nodes
      .map((n, index) => {
        const textValue =
          n.type === 'text' && heading && index === 0
            ? n.value.replace(/^> +/, '')
            : n.type === 'text'
              ? n.value
              : '';
        switch (n.type) {
          case 'text':
            return !linked && mappingEnabled && mapper
              ? (() => {
                  // Heading presentation can remove a Discord quote prefix.
                  // A transformed leaf no longer represents its exact editable value.
                  const ref =
                    textValue === n.value ? mapper.reference(n, 'text') : '';
                  return ref
                    ? `<span${ref}>${escape(textValue)}</span>`
                    : escape(textValue);
                })()
              : escape(textValue);
          case 'bold':
            return `<strong>${inline(n.children, linked)}</strong>`;
          case 'italic':
            return `<em>${inline(n.children, linked)}</em>`;
          case 'underline':
            return `<u>${inline(n.children, linked)}</u>`;
          case 'strikethrough':
            return `<del>${inline(n.children, linked)}</del>`;
          case 'spoiler':
            return `<span class="spoiler" tabindex="0">${inline(n.children, linked)}</span>`;
          case 'inline-code':
            return `<code>${escape(n.value)}</code>`;
          case 'emoji':
            return n.id
              ? `<img class="emoji" src="https://cdn.discordapp.com/emojis/${escape(n.id)}.${n.animated ? 'gif' : 'png'}?size=48" width="24" height="24" loading="lazy" alt=":${escape(n.name)}:" title="${escape(n.name)}">`
              : escape(`:${n.name}:`);
          case 'line-break':
            return '<br>';
          case 'spacer':
            return '<span class="spacer"></span>';
          case 'reference':
            return n.kind === 'tag' && tagIds.has(n.target)
              ? `<a href="#${escape(n.target)}">Jump to section</a>`
              : '';
          case 'mention': {
            if (n.kind !== 'channel') return '';
            const raw = `https://discord.com/channels/534508796639182860/${n.target}`;
            const href = guideHref(raw);
            const title = href.startsWith('/')
              ? pageLinkTitle(
                  getDiscordLinkResolver().title(raw) || 'Related guide',
                )
              : 'Discord Channel ↗';
            return `<a href="${href}">${escape(title)}</a>`;
          }
          case 'image':
            return linked
              ? media(n.url, plain(n.children))
              : renderMedia(n.url, plain(n.children));
          case 'link': {
            const ref = n.destination.find((r) => r.kind === 'tag');
            const href = ref
              ? tagIds.has(ref.target)
                ? `#${escape(ref.target)}`
                : ''
              : guideHref(n.url, labelText(n.children));
            if (!href) return inline(n.children, true);
            const youtube = mediaLink(n.url)?.kind === 'youtube';
            const overlay =
              n.suppressEmbed || youtube ? overlayAttrs(n.url) : '';
            if (overlay && !youtube)
              return `<a href="${href}"${overlay} rel="noopener noreferrer">${inline(n.children, true)}</a>`;
            if (
              !linked &&
              collectMedia(n.url, presetLabel.length ? presetLabel : [n])
            )
              return `<a href="${href}"${overlay} rel="noopener noreferrer">${inline(n.children, true)}</a>`;
            if (
              !n.suppressEmbed &&
              /\.(png|jpe?g|gif|webp|mp4|webm)(\?|$)/i.test(n.url) &&
              plain(n.children) === n.url
            )
              return linked ? media(n.url) : renderMedia(n.url);
            const content = inline(
              href.startsWith('/') ? pageLinkNodes(n.children) : n.children,
              true,
            );
            const hasPresetImage = (nodes: InlineNode[]): boolean =>
              nodes.some((child) =>
                child.type === 'image'
                  ? presetDestinations.has(child.url)
                  : 'children' in child && hasPresetImage(child.children),
              );
            if (!linked && hasPresetImage(n.children))
              return presetCard(n.url, content);
            const editable =
              mappingEnabled &&
              !linked &&
              /^https?:\/\//.test(n.url) &&
              !/[\s<>"'\\${}]/.test(n.url) &&
              !href.startsWith('/') &&
              !discordAddress(n.url) &&
              !n.destination.length &&
              !mediaLink(n.url) &&
              !presetDestinations.has(n.url);
            const refs =
              editable && mapper
                ? mapper.reference(n, 'link-label') +
                  mapper.reference(n, 'link-url')
                : '';
            return `<a href="${href}"${refs}${overlay}${href.startsWith('#') ? '' : ' rel="noopener noreferrer"'}>${content}</a>`;
          }
          case 'timestamp': {
            const date = new Date(Number(n.timestamp) * 1000);
            return Number.isFinite(date.getTime())
              ? `<time datetime="${date.toISOString()}">${escape(date.toUTCString())}</time>`
              : '';
          }
          case 'unknown-inline':
            return escape(n.raw);
        }
      })
      .join('');
  const embedded = (value: unknown): string => {
    if (!value || typeof value !== 'object') return '';
    const v = value as Record<string, any>;
    if (Array.isArray(value)) return value.map(embedded).join('');
    if (v.embed || v.embeds)
      return (
        (v.content ? embedText(v.content) : '') +
        (v.embed ? embedded(v.embed) : '') +
        (Array.isArray(v.embeds) ? v.embeds.map(embedded).join('') : '')
      );
    if (typeof v.title === 'string' && /table of contents/i.test(v.title))
      return '';
    const resourceHref =
      typeof v.url === 'string'
        ? guideHref(v.url, typeof v.title === 'string' ? v.title : '')
        : '';
    const heading = (text: string) =>
      `<h3>${parseGuide(text)
        .messages.flatMap((m) => m.blocks)
        .map((b) =>
          b.type === 'paragraph' || b.type === 'heading'
            ? inline(b.children)
            : '',
        )
        .join(' ')}</h3>`;
    const title =
      typeof v.title === 'string' && !sameReferenceTitle(v.title)
        ? options.referenceTitle
          ? heading(v.title)
          : `<strong>${embedText(v.title)}</strong>`
        : '';
    const parentCollector = collectedPresets;
    const cards: string[] = [];
    if (!options.referenceTitle && !parentCollector) collectedPresets = cards;
    const content = `${title}${typeof v.description === 'string' ? embedText(v.description) : ''}${Array.isArray(v.fields) ? v.fields.map((f: any) => `<div>${typeof f.name === 'string' ? (options.referenceTitle ? heading(f.name) : `<strong>${embedText(f.name)}</strong>`) : ''}${typeof f.value === 'string' ? embedText(f.value) : ''}</div>`).join('') : ''}${v.image?.url ? renderMedia(String(v.image.url)) : ''}${v.thumbnail?.url ? renderMedia(String(v.thumbnail.url)) : ''}${resourceHref ? `<a href="${resourceHref}">Open resource${resourceHref.startsWith('/') ? '' : ' ↗'}</a>` : ''}${typeof v.content === 'string' ? embedText(v.content) : ''}`;
    collectedPresets = parentCollector;
    return `<aside class="guide-embed">${previewGroup(content, cards)}</aside>`;
  };
  const sameReferenceTitle = (text: string) => {
    if (!options.referenceTitle) return false;
    const title = parseGuide(text)
      .messages.flatMap((m) => m.blocks)
      .map((b) =>
        b.type === 'paragraph' || b.type === 'heading'
          ? labelText(b.children)
          : '',
      )
      .join(' ')
      .trim();
    return title.toLowerCase() === options.referenceTitle.toLowerCase();
  };
  const embedText = (text: string): string => {
    // Discord accepts a diamond immediately before its content; the parser
    // requires a separating space. Leave fenced code examples verbatim.
    let fence: string | undefined;
    const normalized = text
      .split('\n')
      .map((line) => {
        const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = marker;
          else if (
            marker[0] === fence[0] &&
            marker.length >= fence.length &&
            /^\s*(?:`+|~+)\s*$/.test(line)
          )
            fence = undefined;
          return line;
        }
        return fence ? line : line.replace(/^(\s*⬥)(?=\S)/u, '$1 ');
      })
      .join('\n');
    const parsed = parseGuide(normalized);
    const analysis = analysePresets(parsed);
    return parsed.messages.map((m) => blocks(m.blocks, analysis)).join('');
  };
  const blocks = (
    nodes: BlockNode[],
    analysis: PresetAnalysis = presetAnalysis,
  ): string => {
    const renderBlock = (b: BlockNode): string => {
      if (barLabels.has(b)) return '';
      switch (b.type) {
        case 'heading': {
          if (sameReferenceTitle(labelText(b.children).replace(/^> +/, '')))
            return `<span id="${escape(ids.get(b.id) || b.id)}"></span>`;
          const level = Math.max(2, b.level);
          let content = inline(b.children, false, true),
            examples = false;
          const firstLink = b.children.findIndex(
            (node) => node.type === 'link',
          );
          if (mechanicHeadings.has(b.id) && firstLink > 0) {
            const titleNodes = b.children.slice(0, firstLink);
            const exampleNodes = b.children.slice(firstLink);
            const tail = titleNodes.at(-1);
            if (tail?.type === 'text') {
              const suffix = tail.value.match(/(\s*[[(]\s*|\s+)$/)?.[0];
              if (suffix) {
                titleNodes[titleNodes.length - 1] = {
                  ...tail,
                  value: tail.value.slice(0, -suffix.length),
                };
                exampleNodes.unshift({ ...tail, value: suffix });
              }
            }
            content = `<span class="mechanic-title">${inline(titleNodes, false, true)}</span><span class="mechanic-examples">${inline(exampleNodes)}</span>`;
            examples = true;
          }
          const headingClass =
            b.level === 1
              ? 'guide-document-title'
              : examples
                ? 'mechanic-heading'
                : '';
          const quoteLine =
            b.children.length === 1 &&
            b.children[0].type === 'text' &&
            /^> +\S/.test(b.children[0].value)
              ? ` data-quote-heading-line="${b.children[0].range.start.offset}"`
              : '';
          return `${(extra.get(b.id) || []).map((id) => `<span id="${escape(id)}" class="anchor"></span>`).join('')}<h${level}${headingClass ? ` class="${headingClass}"` : ''}${quoteLine} id="${escape(ids.get(b.id) || `embedded-${b.range.startLine}`)}">${content}</h${level}>`;
        }
        case 'paragraph': {
          const text = plain(b.children);
          if (
            !options.referenceTitle &&
            /\btable of contents\b/i.test(text) &&
            /\b(?:pins|pinned messages?)\b/i.test(text)
          )
            return '';
          const entries = analysis.paragraphs.get(b);
          if (entries) {
            const parentCollector = collectedPresets,
              parentLabel = presetLabel;
            const cards: string[] = [];
            if (!parentCollector) collectedPresets = cards;
            const content = entries
              .map((entry) => {
                if (!parentCollector) presetLabel = entry.nodes;
                return `<p>${inline(entry.nodes)}</p>${preview(entry.finalUrl, analysis)}`;
              })
              .join('');
            collectedPresets = parentCollector;
            presetLabel = parentLabel;
            return previewGroup(content, cards);
          }
          if (!collectedPresets && standaloneMediaRow(b.children)) {
            const urls = new Set<string>();
            const visitLinks = (nodes: InlineNode[]) =>
              nodes.forEach((node) => {
                if (node.type === 'link' && mediaLink(node.url))
                  urls.add(node.url);
                else if ('children' in node) visitLinks(node.children);
              });
            visitLinks(b.children);
            if (urls.size > 1) {
              const cards: string[] = [];
              collectedPresets = cards;
              const content = inline(b.children);
              collectedPresets = undefined;
              return previewGroup(`<p>${content}</p>`, cards);
            }
          }
          const parentLabel = presetLabel;
          if (collectedPresets && !options.referenceTitle)
            presetLabel = b.children;
          const content = inline(b.children);
          presetLabel = parentLabel;
          return `<p>${content}</p>`;
        }
        case 'subtext':
          return `<p class="muted">${inline(b.children)}</p>`;
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul';
          const parentCollector = collectedPresets,
            parentLabel = presetLabel;
          const sharedCollector = !options.referenceTitle && parentCollector;
          const cards: string[] = sharedCollector || [];
          collectedPresets = cards;
          const items = b.items
            .map((i) => {
              presetLabel = i.children
                .filter((n) => n.type === 'paragraph')
                .flatMap((n) => n.children);
              return `<li>${blocks(i.children, analysis)}${preview(analysis.items.get(i), analysis)}</li>`;
            })
            .join('');
          collectedPresets = parentCollector;
          presetLabel = parentLabel;
          const content = `<${tag}>${items}</${tag}>`;
          return sharedCollector ? content : previewGroup(content, cards);
        }
        case 'blockquote':
          return `<blockquote>${blocks(b.children, analysis)}</blockquote>`;
        case 'codeblock':
          return `<pre><code>${escape(b.value)}</code></pre>`;
        case 'attachment':
          if (barImages.has(b)) {
            const image = media(b.url, barImages.get(b));
            const note = barNotes.get(b);
            return note
              ? `<figure class="ability-bar">${image}<figcaption><ul><li>${escape(note)}</li></ul></figcaption></figure>`
              : `<div class="ability-bar">${image}</div>`;
          }
          return b.kind === 'image'
            ? `<div${b === cover ? ' class="guide-cover"' : ''}>${renderMedia(b.url, barImages.get(b))}</div>`
            : safe(b.url)
              ? `<p><a href="${safe(b.url)}">Download attachment ↗</a></p>`
              : '';
        case 'embed':
          return b.valid ? withoutMappings(() => embedded(b.value)) : '';
        case 'blank':
        case 'command':
        case 'unknown-command':
          return '';
      }
    };
    const isMediaRow = (node: BlockNode) =>
      node.type === 'paragraph' &&
      (analysis.paragraphs.has(node) || standaloneMediaRow(node.children));
    const output: string[] = [];
    for (let index = 0; index < nodes.length; index++) {
      if (!collectedPresets && isMediaRow(nodes[index])) {
        let end = index + 1;
        while (end < nodes.length && isMediaRow(nodes[end])) end++;
        if (end - index > 1) {
          const cards: string[] = [];
          const rows: string[] = [];
          const parentLabel = presetLabel;
          collectedPresets = cards;
          for (const row of nodes.slice(index, end)) {
            if (row.type === 'paragraph') presetLabel = row.children;
            rows.push(renderBlock(row));
          }
          collectedPresets = undefined;
          presetLabel = parentLabel;
          output.push(previewGroup(rows.join(''), cards));
          index = end - 1;
          continue;
        }
      }
      output.push(renderBlock(nodes[index]));
    }
    return output.join('');
  };
  let html = doc.messages
    .map((m) => {
      const mechanic = mechanicMessages.has(m);
      const abilityBars = m.blocks.some((block) => barImages.has(block));
      inMechanicMessage = mechanic;
      const content = blocks(m.blocks);
      inMechanicMessage = false;
      if (!content && !m.anchors.length) return '';
      return `${m.anchors.map((a) => `<span class="anchor" id="${escape(a.tag)}"></span>`).join('')}<section class="guide-message${mechanic ? ' mechanic-message' : ''}${abilityBars ? ' ability-bar-message' : ''}">${content}</section>`;
    })
    .join('')
    .replace(
      /<a\b([^>]*\bhref="https?:\/\/[^"]+"[^>]*)>/g,
      (_, attributes: string) =>
        `<a${attributes} target="_blank"${/\brel=/.test(attributes) ? '' : ' rel="noopener noreferrer"'}>`,
    );
  const mapped = mapper?.finish(html);
  if (mapped) html = mapped.html;
  return {
    ...(mapped ? { sourceMap: mapped.sourceMap } : {}),
    html: prefix
      ? html
          .replace(
            /\bid="([^"]+)"/g,
            (_, id: string) => `id="${escape(prefix)}${id}"`,
          )
          .replace(
            /href="#([^"]+)"/g,
            (_, id: string) => `href="#${escape(prefix)}${id}"`,
          )
      : html,
    toc: headings.map((h) => ({
      id: prefix + ids.get(h.id)!,
      text: labelText(h.children).replace(/^> +/, ''),
      level: h.level,
    })),
    methods: methods.map((m) => ({ ...m, anchor: prefix + m.anchor })),
    image: cover?.url,
  };
}
function media(raw: string, alt = 'Guide illustration') {
  const src = safe(raw);
  if (!src) return '';
  return /\.(mp4|webm)(\?|$)/i.test(raw)
    ? `<video controls preload="none" src="${src}" aria-label="${escape(alt)}"></video>`
    : `<img class="guide-image" src="${src}" alt="${escape(alt)}" loading="lazy" decoding="async">`;
}
const cache = new Map<string, RenderedGuide>();
export function getRendered(g: Guide, root: string) {
  const source = readFileSync(sourcePath(root, g.path), 'utf8');
  const key = JSON.stringify([
    root,
    g.id,
    g.path,
    previewVersion(),
    g.methods,
    g.sections,
  ]);
  const hash = sourceFingerprint(source);
  let r = cache.get(key);
  if (!r || r.sourceMap?.sourceHash !== hash) {
    r = renderGuide(source, g, `${g.id}--`, presetPreviewCache(), {
      sourcePath: g.path,
    });
    cache.set(key, r);
  }
  return r;
}
