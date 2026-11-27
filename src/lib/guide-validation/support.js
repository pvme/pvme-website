export function embedValues(node) {
  if (
    !node.valid ||
    !node.value ||
    typeof node.value !== 'object' ||
    Array.isArray(node.value)
  )
    return [];
  const value = node.value;
  const embeds = Object.hasOwn(value, 'embeds')
    ? Array.isArray(value.embeds)
      ? value.embeds
      : []
    : Object.hasOwn(value, 'embed')
      ? [value.embed]
      : Object.hasOwn(value, 'content')
        ? []
        : [value];
  return embeds.filter(
    (embed) => embed && typeof embed === 'object' && !Array.isArray(embed),
  );
}
