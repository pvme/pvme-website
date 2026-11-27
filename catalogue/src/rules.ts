import type { BaseStyle, Finding, Style } from './schema';

// Bump when detection rules change to invalidate cached records.
export const RULES_VERSION = '2.3.0';
export const EXCLUDED_FOLDERS = new Set(['archive', 'navigation', 'commands', 'testing', 'development', 'dev', 'editor-resources', 'get-involved']);
export const CATEGORIES: Record<string, string> = {
  'rs3-full-boss-guides': 'Boss', slayer: 'Slayer', afk: 'AFK', 'upgrading-info': 'Upgrade Orders',
  'basic-guides': 'General PvM', 'dpm-advice': 'DPM Advice', 'combat-achievements': 'Combat Achievements',
  'getting-started': 'Getting Started', 'new-to-pvm': 'General PvM', 'new-to-bossing': 'Bossing Basics',
  'invention-and-perks': 'Invention & Perks', 'miscellaneous-information': 'General PvM', 'one-tick-guides': 'One Tick Guides',
};
export const STYLE_RULES: [BaseStyle, RegExp][] = [
  ['Melee', /\b(?:melee|mel)\b/i], ['Magic', /\b(?:magic|mage|mag)\b/i],
  ['Ranged', /\b(?:ranged|range|rng)\b/i], ['Necromancy', /\b(?:necromancy|necro|nec)\b/i],
];
export function normaliseHeading(text: string): string {
  return text.replace(/<a?:([\w]+):\d+>/g, ' $1 ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .normalize('NFKC').replace(/[_*~`|#]/g, '').replace(/[^\p{L}\p{N}\s/+()-]/gu, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}
export function detectStyles(text: string): BaseStyle[] {
  const normalized = normaliseHeading(text);
  return STYLE_RULES.filter(([, re]) => re.test(normalized)).map(([name]) => name);
}
const STYLE_WORD = '(?:melee|mel|magic|mage|mag|ranged|range|rng|necromancy|necro|nec)';
const HYBRID_PAIR = new RegExp(`\\b${STYLE_WORD}\\s*[-+&]\\s*${STYLE_WORD}\\b`, 'i');
export function styleCombination(text: string, emojiText = ''): { styles: Style[]; components: BaseStyle[]; hybrid: boolean; ambiguous: boolean } {
  const components = detectStyles(`${text} ${emojiText}`);
  const normalized = normaliseHeading(text.replace(/[–—−]/g, '-'));
  const hybrid = /\bhybrid\b/i.test(normalized) || (components.length > 1 && HYBRID_PAIR.test(text.replace(/[–—−]/g, '-').replace(/[_*~`]/g, '')));
  // Multiple style names in one setup are not evidence for independent
  // single-style options. Unmarked combinations retain components for review.
  const emojiAlternatives = detectStyles(text).length === 0 && detectStyles(emojiText).length > 1;
  const ambiguous = !hybrid && !emojiAlternatives && components.length > 1 && !/\b(?:or|alternatives?)\b/i.test(normalized);
  return { styles: hybrid ? ['Hybrid'] : ambiguous ? [] : components, components, hybrid, ambiguous };
}
export function canonicalAttribute(value: string): string {
  if (/^(?:afk|low[ -]effort|afk\s*\/\s*low[ -]effort)$/i.test(value.trim())) return 'AFK / Low Effort';
  return value;
}
export function attributes(text: string, origin: Finding['origin'] = 'explicit', evidence = 'Method heading'): Finding[] {
  const n = normaliseHeading(text).replace(/\bnon[ -]?afk\b/g, '').replace(/\bnot afk\b/g, '').replace(/\bnon[ -]?active\b/g, '');
  const patterns: [string, RegExp][] = [
    ['AFK / Low Effort', /\b(?:afk|low[ -]effort)\b/], ['Active', /\bactive\b/],
    ['High Effort', /\bhigh[ -]effort\b/],
    ['Hard Mode', /\b(?:hard[ -]?modes?|hm)\b/], ['Normal Mode', /\b(?:normal[ -]?modes?|nm)\b/],
    ['Base Tank', /\bbase(?: tank)?\b/], ['Bomb Tank', /\bbomb(?: tank)?\b/], ['DPS', /\bdps\b/],
    ['Hybrid', /\bhybrid\b/], ['Cannon', /\bcannon\b/], ['Advanced', /\badvanced\b/],
    ['Sunken Pyramid', /\b(?:sunken pyramid|posd|psd)\b/],
  ];
  const found = patterns.filter(([, re]) => re.test(n)).map(([value]) => ({ value, origin, evidence }));
  if (/\b(?:normal\s*(?:\+|and|\/)\s*hard|hard\s*(?:\+|and|\/)\s*normal) modes?\b/.test(n)) for (const value of ['Normal Mode', 'Hard Mode']) if (!found.some(a => a.value === value)) found.push({ value, origin, evidence });
  const level = n.match(/\blevel (\d+(?:[+-]\d+|\+)?)/);
  if (level) found.push({ value: `Level ${level[1]}`, origin, evidence });
  const phase = n.match(/\b(?:phase\s*|p)([1-9])\b/);
  if (phase) found.push({ value: `Phase ${phase[1]}`, origin, evidence });
  const variantText = n.replace(/\(?\s*\d[\d., +/–-]*(?:kph|kills? per hour)\s*\)?/g, '').trim();
  const location = variantText.match(/\bmethod\s+(.+)$/);
  if (location && !/\b(?:method|rotation|strategy|melee|magic|mage|range|necromancy|necro|active|afk|effort|hybrid|cannon)\b/.test(location[1])) {
    found.push({ value: `Variant: ${location[1]}`, origin, evidence });
  }
  return found;
}
export const METHOD_KEYWORDS = /\b(methods?|strateg(?:y|ies)|rotations?)\b/;
export const GENERIC_METHOD = /^(?:(?:general|basic|suggested|example) )?(?:methods?|strateg(?:y|ies)|rotations?)(?: \d+)?$/;
export const ORDINARY = /\b(?:presets?|relics?|action bars?|ability bars?|example kills?|introduction|overview|disclaimer|requirements?|mechanics?|stats|drops|useful items|unlocks|related guides|getting there|location and|positioning|equipment|gear|inventory|prayers?|abilities|perks|faq|tips|rewards|setup|recommendations?|helpers?|general information|the fight|prefight)\b/;
export const ROLE = /\b(?:base tank|bomb tank|base|dps|solo|duo|trio|hard mode|normal mode|hm|nm)\b/;
export const PHASE = /^(?:phase\s*|p)[1-9]\b/;
export const STYLE_ONLY = /^(?:(?:melee|magic|mage|ranged|range|necromancy|necro|mel|mag|rng|nec)(?:\s*[/+ -]\s*|\s+)?)+(?:hybrid)?$/;
