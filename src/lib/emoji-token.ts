import { parseGuide } from '@pvme/guide-parser';
import type { LineToken } from './source-lines';

/** Only explicit Discord emoji literals can be introduced as new rich tokens.
 * Original links, references and other source tokens retain their existing guards. */
export function newEmojiToken(raw: string): LineToken | undefined {
  if (!/^<a?:[A-Za-z0-9_-]+:\d{5,25}>$/.test(raw)) return;
  const block = parseGuide(raw).messages[0]?.blocks[0];
  if (block?.type !== 'paragraph' || block.children.length !== 1) return;
  const node = block.children[0];
  if (node.type !== 'emoji' || !node.id || node.raw !== raw) return;
  return { id: `new-emoji:${raw}`, raw, node };
}

export function emojiTokenFromId(id: string): LineToken | undefined {
  return id.startsWith('new-emoji:') ? newEmojiToken(id.slice(10)) : undefined;
}

/** New links are explicit rich-editor operations, never inferred from pasted HTML. */
export function newLinkToken(raw: string): LineToken | undefined {
  const block = parseGuide(raw).messages[0]?.blocks[0];
  if (block?.type !== 'paragraph' || block.children.length !== 1) return;
  const node = block.children[0];
  if (
    node.type !== 'link' ||
    node.raw !== raw ||
    !/^https?:\/\//i.test(node.url) ||
    /[\s<>"'\\]/.test(node.url) ||
    node.destination.length
  )
    return;
  try {
    new URL(node.url);
  } catch {
    return;
  }
  return { id: `new-link:${raw}`, raw, node };
}
export function inlineTokenFromId(id: string): LineToken | undefined {
  return (
    emojiTokenFromId(id) ||
    (id.startsWith('new-link:') ? newLinkToken(id.slice(9)) : undefined)
  );
}
