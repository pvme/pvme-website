import snapshot from '../data/emoji-autocomplete.json';

export interface EmojiCompletion {
  id: string;
  emojiId: string;
  name: string;
  aliases: string[];
}
export const emojiSnapshot: EmojiCompletion[] = snapshot.filter(
  (emoji) =>
    /^[A-Za-z0-9_]+$/.test(emoji.id) && /^\d{5,25}$/.test(emoji.emojiId),
);
export const emojiCatalogueUrl =
  'https://raw.githubusercontent.com/pvme/pvme-settings/master/emojis/emojis_v2.json';
export const emojiSource = (emoji: EmojiCompletion) =>
  `<:${emoji.id}:${emoji.emojiId}>`;
export const emojiImage = (emoji: EmojiCompletion) =>
  `https://cdn.discordapp.com/emojis/${emoji.emojiId}.png?size=48`;

export function emojiQuery(before: string) {
  const match = /:([A-Za-z0-9_-]{2,})(:?)$/.exec(before);
  if (!match || ['<', '\\', ':'].includes(before[match.index - 1])) return;
  return {
    query: match[1].toLowerCase(),
    from: match.index,
    to: before.length,
    closed: !!match[2],
  };
}

export function emojiMatches(
  catalogue: EmojiCompletion[],
  query: string,
  exact = false,
): EmojiCompletion[] {
  query = query.toLowerCase();
  return catalogue
    .filter((emoji) => {
      const terms = [
        emoji.id,
        ...emoji.aliases,
        emoji.name,
        emoji.name.replace(/\s+/g, ''),
      ].map((term) => term.toLowerCase());
      return exact
        ? [emoji.id, ...emoji.aliases].some(
            (term) => term.toLowerCase() === query,
          )
        : terms.some((term) => term.includes(query));
    })
    .sort(
      (a, b) =>
        Number(b.id.toLowerCase() === query) -
          Number(a.id.toLowerCase() === query) ||
        Number(b.id.toLowerCase().startsWith(query)) -
          Number(a.id.toLowerCase().startsWith(query)),
    )
    .slice(0, 25);
}

export function emojiCatalogue(data: unknown): EmojiCompletion[] {
  const categories = (
    data as { categories?: { emojis?: Record<string, unknown>[] }[] }
  )?.categories;
  if (!Array.isArray(categories)) return [];
  return categories
    .flatMap((category) =>
      Array.isArray(category.emojis) ? category.emojis : [],
    )
    .flatMap((emoji) =>
      typeof emoji.id === 'string' &&
      /^[A-Za-z0-9_]+$/.test(emoji.id) &&
      /^\d{5,25}$/.test(String(emoji.emoji_id))
        ? [
            {
              id: emoji.id,
              emojiId: String(emoji.emoji_id),
              name: typeof emoji.name === 'string' ? emoji.name : emoji.id,
              aliases: Array.isArray(emoji.id_aliases)
                ? emoji.id_aliases.filter(
                    (alias): alias is string => typeof alias === 'string',
                  )
                : [],
            },
          ]
        : [],
    );
}
