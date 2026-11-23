import type { GuideType } from './schema';

export const GUIDE_TYPES: GuideType[] = ['boss-overview', 'boss-rotation', 'boss-mechanics', 'boss-afk', 'slayer', 'upgrade-order', 'combat-achievement', 'general-pvm'];
export const GUIDE_TYPE_LABELS: Record<GuideType, string> = {
  'boss-overview': 'Boss overview', 'boss-rotation': 'Boss rotations', 'boss-mechanics': 'Boss mechanics',
  'boss-afk': 'AFK / low-effort boss guide', slayer: 'Slayer', 'upgrade-order': 'Upgrade order',
  'combat-achievement': 'Combat Achievement', 'general-pvm': 'General PvM',
};
export function validateGuideTypes(value: unknown): GuideType[] {
  if (!Array.isArray(value) || value.some(t => !GUIDE_TYPES.includes(t))) throw new Error(`Choose guide types from: ${GUIDE_TYPES.join(', ')}.`);
  return [...new Set(value)] as GuideType[];
}
