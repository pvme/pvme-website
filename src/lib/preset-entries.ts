import {
  parseGuide,
  type GuideDocument,
  type BlockNode,
  type InlineNode,
  type ParagraphBlock,
  type ListItem,
} from '@pvme/guide-parser';
export interface PresetLine {
  nodes: InlineNode[];
  finalUrl?: string;
}
export interface PresetAnalysis {
  paragraphs: WeakMap<ParagraphBlock, PresetLine[]>;
  items: WeakMap<ListItem, string>;
  urls: Set<string>;
  explicitImages: Set<string>;
  presetImages: Set<string>;
}
export const directImage = (url: string) =>
  /^https?:\/\//i.test(url) &&
  /\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(url);
export function presetPage(raw: string) {
  try {
    const u = new URL(raw);
    return (
      (['presets.pvme.io', 'pvme.io', 'pvme.github.io'].includes(u.hostname) &&
        (u.hostname === 'presets.pvme.io' ||
          /\/(preset-maker|preset-maker-storage)\//.test(u.pathname))) ||
      (u.hostname.endsWith('.cloudfunctions.net') &&
        /presetEmbed/i.test(u.pathname))
    );
  } catch {
    return false;
  }
}
const text = (nodes: InlineNode[]): string =>
  nodes
    .map((n) =>
      'children' in n ? text(n.children) : n.type === 'text' ? n.value : '',
    )
    .join('');
const links = (nodes: InlineNode[]): { url: string; label: string }[] =>
  nodes.flatMap((n) =>
    n.type === 'link'
      ? [{ url: n.url, label: text(n.children) }]
      : 'children' in n
        ? links(n.children)
        : [],
  );
export function analysePresets(doc: GuideDocument): PresetAnalysis {
  const result: PresetAnalysis = {
    paragraphs: new WeakMap(),
    items: new WeakMap(),
    urls: new Set(),
    presetImages: new Set(),
    explicitImages: new Set(
      doc.attachments.filter((a) => a.kind === 'image').map((a) => a.url),
    ),
  };
  const stack: { level: number; text: string }[] = [];
  const inPresetContext = () =>
    stack.some((h) => /\b(presets?|gear|equipment|loadouts?)\b/i.test(h.text));
  const scanInline = (nodes: InlineNode[]) => {
    for (const n of nodes) {
      if (n.type === 'image') {
        result.explicitImages.add(n.url);
        if (inPresetContext()) result.presetImages.add(n.url);
      }
      if (
        n.type === 'link' &&
        !n.suppressEmbed &&
        text(n.children) === n.url &&
        directImage(n.url)
      ) {
        result.explicitImages.add(n.url);
        if (inPresetContext()) result.presetImages.add(n.url);
      }
      if ('children' in n) scanInline(n.children);
    }
  };
  const final = (nodes: InlineNode[]) => {
    const all = links(nodes);
    if (!all.length) return undefined;
    const presetContext = stack.some((h) =>
      /\b(presets?|gear|equipment|loadouts?)\b/i.test(h.text),
    );
    if (
      !presetContext &&
      !all.some((l) => /\bpreset\b/i.test(l.label) || presetPage(l.url))
    )
      return undefined;
    const url = all.at(-1)!.url;
    // Never fall back to an earlier link when the final destination is unsupported.
    if (!directImage(url) && !presetPage(url)) return undefined;
    result.urls.add(url);
    return url;
  };
  const visit = (blocks: BlockNode[], owned = false) => {
    for (const b of blocks) {
      if (b.type === 'heading') {
        while (stack.length && stack.at(-1)!.level >= b.level) stack.pop();
        stack.push({ level: b.level, text: text(b.children) });
      }
      if (b.type === 'attachment' && b.kind === 'image' && inPresetContext())
        result.presetImages.add(b.url);
      if (
        'children' in b &&
        Array.isArray(b.children) &&
        b.type !== 'blockquote'
      )
        scanInline(b.children as InlineNode[]);
      if (b.type === 'paragraph' && !owned) {
        const lines: InlineNode[][] = [[]];
        for (const n of b.children) {
          if (n.type === 'line-break') lines.push([]);
          else lines.at(-1)!.push(n);
        }
        const entries = lines.map((nodes) => ({
          nodes,
          finalUrl: final(nodes),
        }));
        if (entries.some((e) => e.finalUrl)) result.paragraphs.set(b, entries);
      }
      if (b.type === 'list')
        for (const item of b.items) {
          const nodes = item.children.flatMap((n) =>
            n.type === 'paragraph' ? n.children : [],
          );
          const url = final(nodes);
          if (url) result.items.set(item, url);
          visit(item.children, true);
        }
      if (b.type === 'blockquote') visit(b.children, owned);
      if (b.type === 'embed' && b.valid) visitEmbed(b.value);
    }
  };
  const visitEmbed = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, any>;
    for (const media of [v.image, v.thumbnail])
      if (typeof media?.url === 'string') {
        result.explicitImages.add(media.url);
        if (inPresetContext() || /\bpreset\b/i.test(String(v.title || '')))
          result.presetImages.add(media.url);
      }
    for (const content of [
      v.description,
      v.content,
      ...(Array.isArray(v.fields)
        ? v.fields.flatMap((f: any) => [f.name, f.value])
        : []),
    ])
      if (typeof content === 'string') {
        // URLs from embedded strings are resolved here; renderer parses those strings with the same AST later.
        const parsed = analysePresets(parseGuide(content));
        for (const u of parsed.urls) result.urls.add(u);
        for (const u of parsed.explicitImages) result.explicitImages.add(u);
        for (const u of parsed.presetImages) result.presetImages.add(u);
      }
    if (v.embed) visitEmbed(v.embed);
    if (Array.isArray(v.embeds)) v.embeds.forEach(visitEmbed);
  };
  doc.messages.forEach((m) => visit(m.blocks));
  return result;
}
