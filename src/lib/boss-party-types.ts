import { z } from 'zod';
import definitions from '../../catalogue/boss-party-types.json';
import type { Hub } from './catalogue';

const partyTypesSchema = z.record(
  z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  z.enum(['solo', 'group', 'both']).nullable(),
);

export const parseBossPartyTypes = (input: unknown) =>
  partyTypesSchema.parse(input);
export const bossPartyTypes = parseBossPartyTypes(definitions);
export type BossPartyTypes = ReturnType<typeof parseBossPartyTypes>;

/** Party filters come only from the explicit boss configuration, never guide text. */
export function bossDirectoryAttributes(
  hub: Pick<Hub, 'slug' | 'guides'>,
  types: BossPartyTypes = bossPartyTypes,
): string[] {
  const attributes = hub.guides
    .flatMap((guide) => guide.attributes)
    .filter(
      (value) =>
        !/^(?:solos?|duos?|trios?|quads?|groups?|small teams?)$/i.test(value),
    );
  const type = types[hub.slug];
  if (type === 'solo' || type === 'both') attributes.push('Solo');
  if (type === 'group' || type === 'both') attributes.push('Group');
  return [...new Set(attributes)];
}
