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
export function appendCombatText(
  element: HTMLElement,
  text: string,
  assetBase: string,
) {
  const doc = element.ownerDocument;
  for (const part of combatTextParts(text)) {
    if (!part.file) {
      element.append(doc.createTextNode(part.text));
      continue;
    }
    const label = doc.createElement('span');
    label.className = 'combat-label';
    const img = doc.createElement('img');
    img.src = assetBase + part.file;
    img.alt = '';
    img.className = 'combat-style-icon';
    img.width = 22;
    img.height = 22;
    img.setAttribute('aria-hidden', 'true');
    label.append(img, doc.createTextNode(part.text));
    element.append(label);
  }
}
