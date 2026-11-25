export const combatStyleNames = [
  'Necromancy',
  'Magic',
  'Ranged',
  'Melee',
] as const;
export function combatStylePath(style: string) {
  return `/${style.toLowerCase()}/`;
}
export function combatStyleFromPath(path: string) {
  const last = path.split('/').filter(Boolean).at(-1)?.toLowerCase();
  return combatStyleNames.find((style) => style.toLowerCase() === last);
}
export const combatStyleFiles: Record<string, string> = {
  melee: 'melee.png',
  ranged: 'ranged.png',
  magic: 'magic.png',
  necromancy: 'necromancy.png',
};
export function combatStyleFile(style: string) {
  return combatStyleFiles[
    style.toLowerCase() === 'mage' ? 'magic' : style.toLowerCase()
  ];
}
export function combatTextParts(text: string) {
  return text
    .split(/\b(Melee|Ranged|Magic|Mage|Necromancy)\b/gi)
    .filter(Boolean)
    .map((text) => ({ text, file: combatStyleFile(text) }));
}
