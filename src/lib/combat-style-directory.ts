import type { Guide, Hub, Method } from './catalogue';
import { getRendered } from './renderer';
import { resourceGuideTitle } from './resource-guides';
import { methodDestination } from './guide-destinations';
import { combatStyleNames, combatStylePath } from './combat-styles';

export const directoryStyles = combatStyleNames;
export function combatStyleLinks(guides: Guide[]) {
  return directoryStyles
    .filter((style) =>
      guides.some((guide) => guideHasDirectoryStyle(guide, style)),
    )
    .map((style) => ({
      id: `style-${style.toLowerCase()}`,
      title: style,
      icon: style.toLowerCase(),
      description: `${style} guides, bosses and combat progression`,
      href: combatStylePath(style),
    }));
}
export type DirectoryStyle = (typeof directoryStyles)[number];
const definitions = [
  { id: 'learning', title: 'Learning & Upgrades' },
  { id: 'bosses', title: 'Bosses' },
  { id: 'afk', title: 'AFK & Low Effort' },
  { id: 'slayer', title: 'Slayer' },
  { id: 'achievements', title: 'Combat Achievements' },
  { id: 'one-tick', title: 'One Tick Guides' },
  { id: 'other', title: 'Other Resources' },
];
export interface StyleDirectoryEntry {
  id: string;
  title: string;
  href: string;
  terms: string;
  category: string;
}
export interface StyleDirectoryGroup {
  id: string;
  title: string;
  entries: StyleDirectoryEntry[];
}
export interface StyleDirectory {
  style: DirectoryStyle;
  count: number;
  groups: StyleDirectoryGroup[];
}
type StyleDeclaration = {
  styles: string[];
  combatSetups: { style: string; components: string[] }[];
};
export function declaresStyle(value: StyleDeclaration, style: string): boolean {
  return (
    value.styles.includes(style) ||
    value.combatSetups.some(
      (setup) => setup.style === style || setup.components.includes(style),
    )
  );
}
export function guideHasDirectoryStyle(guide: Guide, style: string): boolean {
  // The tutorial uses a Ranged preset to explain how to read guides.
  if (
    style === 'Ranged' &&
    guide.path === 'getting-started/how-to-use-pvme.txt'
  )
    return false;
  return (
    declaresStyle(guide, style) ||
    guide.methods.some((method) => declaresStyle(method, style))
  );
}
function applicableMethods(guide: Guide, style: string): Method[] {
  return guide.methods.filter(
    (method) =>
      declaresStyle(method, style) ||
      (declaresStyle(guide, style) &&
        !method.styles.length &&
        !method.combatSetups.length),
  );
}
const relaxed = (attributes: string[]) =>
  attributes.some((attribute) =>
    ['AFK / Low Effort', 'AFK', 'Low Effort', 'AFK & Low Effort'].includes(
      attribute,
    ),
  );
export function styleGuideGroup(guide: Guide, methods: Method[]): string {
  if (guide.category === 'One Tick Guides') return 'one-tick';
  if (
    guide.types.includes('combat-achievement') ||
    guide.category === 'Combat Achievements'
  )
    return 'achievements';
  if (guide.types.includes('slayer') || guide.category === 'Slayer')
    return 'slayer';
  if (
    guide.category === 'AFK' ||
    (guide.types.includes('boss-afk') &&
      !guide.types.some((type) =>
        ['boss-overview', 'boss-rotation', 'boss-mechanics'].includes(type),
      )) ||
    (methods.length > 0 &&
      methods.every((method) => relaxed(method.attributes)))
  )
    return 'afk';
  if (guide.types.some((type) => type.startsWith('boss-'))) return 'bosses';
  if (
    guide.types.some((type) => ['general-pvm', 'upgrade-order'].includes(type))
  )
    return 'learning';
  return 'other';
}
function entryHref(
  guide: Guide,
  methods: Method[],
  hubs: Hub[],
  root: string,
): string {
  if (methods.length !== 1) return guide.href;
  const method = methods[0];
  const rendered = getRendered(guide, root);
  const hub = hubs.find((hub) =>
    hub.guides.some((member) => member.id === guide.id),
  );
  return methodDestination(guide, method.id, rendered.methods, hub);
}
export function combatStyleDirectories(
  guides: Guide[],
  hubs: Hub[],
  root: string,
): StyleDirectory[] {
  return directoryStyles.map((style) => {
    const groups = definitions.map((group) => ({
      ...group,
      entries: [] as StyleDirectoryEntry[],
    }));
    for (const guide of guides.filter((guide) =>
      guideHasDirectoryStyle(guide, style),
    )) {
      const methods = applicableMethods(guide, style);
      const group = groups.find(
        (group) => group.id === styleGuideGroup(guide, methods),
      )!;
      let title = resourceGuideTitle(guide.title);
      if (
        guide.types.includes('upgrade-order') &&
        title.toLowerCase() === style.toLowerCase()
      )
        title = `${style} Upgrade Order`;
      if (
        guide.subject &&
        guide.types.some((type) => type.startsWith('boss-')) &&
        title.toLowerCase() === style.toLowerCase()
      )
        title = `${guide.subject} — ${title}`;
      group.entries.push({
        id: guide.id,
        title,
        href: entryHref(guide, methods, hubs, root),
        category: guide.category,
        terms: [
          title,
          guide.title,
          guide.subject,
          guide.category,
          ...guide.aliases,
          ...methods.flatMap((method) => [
            method.label,
            ...method.context,
            ...method.attributes,
          ]),
        ].join(' '),
      });
    }
    groups.forEach((group) =>
      group.entries.sort(
        (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
      ),
    );
    const populated = groups.filter((group) => group.entries.length);
    return {
      style,
      count: populated.reduce(
        (count, group) => count + group.entries.length,
        0,
      ),
      groups: populated,
    };
  });
}
