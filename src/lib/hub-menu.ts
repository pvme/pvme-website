import { methodsForTab, type NavigationGuide } from './navigation';
import {
  navigationSettings,
  type NavigationSettings,
} from '../../catalogue/src/navigation-definitions';
export interface MenuGuide extends NavigationGuide {
  path?: string;
  title: string;
  types: string[];
  combatSetups: { style: string; components: string[] }[];
  navigation: { id: string; anchor: string; resolved: boolean }[];
}
export function hubGuideTypes(
  guide: Pick<MenuGuide, 'types' | 'path' | 'methods'>,
  settings: NavigationSettings = navigationSettings,
): string[] {
  const explicit = guide.path && settings.guides[guide.path]?.tabs;
  if (explicit) return explicit;
  const rule = settings.tabRules.find(
    (rule) =>
      (rule.pathPrefix === undefined ||
        guide.path?.startsWith(rule.pathPrefix)) &&
      (rule.onlyTypes === undefined ||
        (guide.types.length === rule.onlyTypes.length &&
          rule.onlyTypes.every((type) => guide.types.includes(type)))) &&
      (rule.hasMethods === undefined ||
        rule.hasMethods === guide.methods.length > 0),
  );
  return rule?.tabs || guide.types;
}
export interface MenuChoice {
  id: string;
  guideId: string;
  methodId?: string;
  label: string;
  styles: string[];
  anchor?: string;
}
export function hubChoiceHref(
  path: string,
  tab: string,
  choice: MenuChoice,
  defaultTab: string,
  defaultGuide: string,
) {
  const query =
    tab === defaultTab && choice.guideId === defaultGuide
      ? ''
      : `?${new URLSearchParams({ tab, guide: choice.guideId })}`;
  return (
    path +
    query +
    (choice.anchor ? `#${encodeURIComponent(choice.anchor)}` : '')
  );
}
export function hubBreadcrumbTitle(
  subject: string,
  guideTitle: string,
  tab: string,
  settings: NavigationSettings = navigationSettings,
): string {
  const label = [...settings.bossTabs, ...settings.slayerTabs].find(
    (item) => item.id === tab,
  )?.breadcrumbLabel;
  return label ? `${subject} - ${label}` : guideTitle;
}
const compactTitle = (title: string, subject: string) => {
  const name = subject.split(',')[0];
  const escaped = name
    .split(/[\s-]+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]+');
  const prefix = title.match(new RegExp(`^${escaped}(?=\\b|:)`, 'i'));
  if (prefix) {
    const shortened = title
      .slice(prefix[0].length)
      .replace(/^\s*[-:–—]\s*/, '')
      .trim();
    if (shortened && shortened.length < title.length) return shortened;
  }
  return title;
};
export function tabChoices(
  guides: MenuGuide[],
  tab: string,
  subject: string,
  settings: NavigationSettings = navigationSettings,
): MenuChoice[] {
  const overview = settings.overview;
  const definition = [...settings.bossTabs, ...settings.slayerTabs].find(
    (item) => item.id === tab,
  );
  if (!definition) return [];
  const hasBasicOverview = guides.some(
    (g) =>
      overview &&
      g.path?.startsWith(overview.preferredPathPrefix) &&
      hubGuideTypes(g, settings).includes(overview.tab),
  );
  const eligible = guides.filter((g) => {
    const types = hubGuideTypes(g, settings);
    if (!types.includes(tab)) return false;
    return !(
      overview &&
      tab === overview.tab &&
      hasBasicOverview &&
      overview.hideOtherTabsFromPathPrefixes.some((prefix) =>
        g.path?.startsWith(prefix),
      ) &&
      types.some(
        (type) =>
          type !== overview.tab &&
          settings.bossTabs.some((item) => item.id === type),
      )
    );
  });
  const seen = new Set<string>();
  const choices = eligible.flatMap<MenuChoice>((g) => {
    const methods = definition.mode === 'pages' ? [] : methodsForTab(g, tab);
    const styles = [
      ...new Set(
        g.combatSetups
          .flatMap((s) => (s.components.length ? s.components : [s.style]))
          .filter((s) => s !== 'Hybrid'),
      ),
    ];
    if (!methods.length)
      return [
        {
          id: g.id,
          guideId: g.id,
          label: compactTitle(g.title, subject),
          styles: styles.length ? styles : g.styles,
        },
      ];
    return methods.flatMap((m) => {
      const target = g.navigation.find((n) => n.id === m.id);
      const identity = `${g.id}:${target?.resolved ? target.anchor : m.id}`;
      if (seen.has(identity)) return [];
      seen.add(identity);
      return [
        {
          id: `${g.id}:${m.id}`,
          guideId: g.id,
          methodId: m.id,
          label: m.label,
          styles: m.styles.includes('Hybrid') ? styles : m.styles,
          anchor: target?.resolved ? target.anchor : undefined,
        },
      ];
    });
  });
  // Distinguish genuine same-label methods using declared context/source names.
  const counts = new Map<string, number>();
  for (const c of choices) counts.set(c.label, (counts.get(c.label) || 0) + 1);
  const labelled = choices.map((c) => {
    if (counts.get(c.label)! < 2) return c;
    const g = guides.find((g) => g.id === c.guideId)!;
    const m = g.methods.find((m) => m.id === c.methodId);
    const detail =
      m?.context.slice(1).join(' / ') || compactTitle(g.title, subject);
    return detail && detail !== c.label
      ? { ...c, label: `${c.label} — ${detail}` }
      : c;
  });
  if (!overview || tab !== overview.tab) return labelled;
  return labelled.sort((a, b) => {
    const ga = guides.find((g) => g.id === a.guideId)!,
      gb = guides.find((g) => g.id === b.guideId)!;
    const basic = (g: MenuGuide) =>
      Number(g.path?.startsWith(overview.preferredPathPrefix));
    const canonicalBasic = (g: MenuGuide) =>
      Number(
        g.path
          ?.toLowerCase()
          .endsWith(overview.preferredFilenameSuffix.toLowerCase()),
      );
    const exact = (g: MenuGuide) =>
      Number(g.title.toLowerCase() === subject.toLowerCase());
    return (
      basic(gb) - basic(ga) ||
      canonicalBasic(gb) - canonicalBasic(ga) ||
      exact(gb) - exact(ga) ||
      ga.types.length - gb.types.length ||
      ga.title.length - gb.title.length
    );
  });
}
export function overviewChoice(
  guides: MenuGuide[],
  subject: string,
): MenuChoice | undefined {
  return navigationSettings.overview
    ? tabChoices(guides, navigationSettings.overview.tab, subject)[0]
    : undefined;
}
