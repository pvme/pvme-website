import type { InlineNode } from '@pvme/guide-parser';

const acronyms: Record<string, string> = {
  dpm: 'DPM',
  pvm: 'PvM',
  pvme: 'PvME',
  faq: 'FAQ',
  afk: 'AFK',
  rs3: 'RS3',
  eof: 'EoF',
  aoe: 'AoE',
  dps: 'DPS',
};

export function pageLinkTitle(title: string): string {
  return title.replace(
    /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu,
    (word) =>
      /^ed\d+$/i.test(word)
        ? word.toUpperCase()
        : acronyms[word.toLowerCase()] ?? word[0].toUpperCase() + word.slice(1),
  );
}

// Work on text nodes so formatting, emoji and destinations remain intact.
export function pageLinkNodes(nodes: InlineNode[]): InlineNode[] {
  return nodes.map((node): InlineNode => {
    if (node.type === 'text')
      return { ...node, value: pageLinkTitle(node.value) };
    if ('children' in node && node.type !== 'image')
      return { ...node, children: pageLinkNodes(node.children) };
    return node;
  });
}
