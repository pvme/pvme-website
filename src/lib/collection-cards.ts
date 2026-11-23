import {
  collectionDefinitions,
  type CollectionCardGroup,
} from '../../catalogue/src/collection-definitions';

export function groupCollectionCards<
  T extends { id: string; collectionId?: string },
>(
  cards: T[],
  parent: string,
  definitions: CollectionCardGroup[] = collectionDefinitions.cardGroups,
) {
  const groups = definitions.filter((group) => group.parent === parent);
  const named = groups.filter((group) => !group.remaining);
  if (named.length === 1)
    groups.sort((a, b) => Number(!!a.remaining) - Number(!!b.remaining));
  const select = (group: CollectionCardGroup) =>
    group.collection
      ? cards.filter((card) => card.collectionId === group.collection)
      : (group.cards || []).flatMap((id) =>
          cards.filter((card) => card.id === id),
        );
  const reserved = new Set(named.flatMap(select).map((card) => card.id));
  const hasNamedGroup = named.some((group) => select(group).length);
  const grouped = groups.map((group) => ({
    ...group,
    ...(group.remaining && hasNamedGroup
      ? { heading: group.heading || 'Other' }
      : {}),
    cards: group.remaining
      ? cards.filter((card) => !reserved.has(card.id))
      : select(group),
  }));
  const assigned = new Set(
    grouped.flatMap((group) => group.cards.map((card) => card.id)),
  );
  const remaining = cards.filter((card) => !assigned.has(card.id));
  if (remaining.length)
    grouped.push({
      parent,
      label: hasNamedGroup ? 'Other' : 'Collections',
      ...(hasNamedGroup ? { heading: 'Other' } : {}),
      cards: remaining,
    });
  return grouped.filter((group) => group.cards.length);
}
