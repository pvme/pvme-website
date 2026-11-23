export function findHeaderArtwork<T>(
  images: Record<string, T>,
  kind: 'bosses' | 'slayer',
  slug: string,
): T | undefined {
  for (const extension of ['webp', 'avif', 'png', 'jpg', 'jpeg']) {
    const image = images[`../assets/${kind}/${slug}.${extension}`];
    if (image) return image;
  }
}
