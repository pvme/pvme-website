export interface SearchEntry {
  title: string;
  href: string;
  category: string;
  section?: string;
  styles?: string[];
  terms: string;
}
const normalize = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function searchEntries<T extends SearchEntry>(
  rows: T[],
  query: string,
  limit = 12,
) {
  const q = normalize(query);
  if (!q) return [];
  const words = q.split(' ');
  const seen = new Set<string>();
  return rows
    .map((row, index) => {
      const title = normalize(row.title),
        terms = normalize(row.terms);
      return {
        row,
        index,
        terms,
        score:
          title === q
            ? 2000
            : title.startsWith(q)
              ? 1000
              : terms.split(' ').includes(q)
                ? 800
                : title.includes(q)
                  ? 500
                  : words.filter((w) =>
                      title.split(' ').some((t) => t.startsWith(w)),
                    ).length * 50,
      };
    })
    .filter(({ terms }) => words.every((word) => terms.includes(word)))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .filter(({ row }) => {
      const key = row.href;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit)
    .map(({ row }) => row);
}
