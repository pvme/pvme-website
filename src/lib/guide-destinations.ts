import type { Guide, Hub } from './catalogue';
import {
  collectionDefinitions,
  type CollectionDefinition,
} from '../../catalogue/src/collection-definitions';
import { tabChoices, hubChoiceHref } from './hub-menu';
import {
  navigationSettings,
  type NavigationSettings,
} from '../../catalogue/src/navigation-definitions';

export function collectionGuideDestinations(
  guides: Guide[],
  definitions: CollectionDefinition[] = collectionDefinitions.collections,
  settings: NavigationSettings = navigationSettings,
): Map<string, string> {
  const destinations = new Map<string, string>();
  for (const definition of definitions.filter(
    (definition) => definition.sourcePath,
  )) {
    for (const guide of guides.filter(
      (guide) =>
        !guide.sourceGuideId &&
        (guide.path === definition.sourcePath ||
          guide.subjectId === definition.subjectId),
    )) {
      if (
        guide.types.some((type) =>
          settings.routes.standaloneTypes.includes(type),
        )
      )
        continue;
      if (!destinations.has(guide.id))
        destinations.set(
          guide.id,
          `${definition.parent}${definition.subjectId}/${settings.routes.collectionGuideSegment}/${guide.slug}/`,
        );
    }
  }
  return destinations;
}

export function hubGuideDestinations(
  hubs: Hub[],
  settings: NavigationSettings = navigationSettings,
): Map<string, string> {
  const destinations = new Map<string, string>();
  for (const boss of hubs) {
    const guides = boss.guides.map((guide) => ({ ...guide, navigation: [] }));
    const definitions = boss.href.startsWith('/slayer/')
      ? settings.slayerTabs
      : settings.bossTabs;
    const tabs = definitions.map((tab) => ({
      id: tab.id,
      choices: tabChoices(guides, tab.id, boss.name, settings),
    }));
    const defaultGuide = tabs.find((tab) => tab.choices.length)?.choices[0]
      .guideId;
    for (const guide of guides) {
      const rule = settings.guides[guide.path];
      if (
        guide.types.some((type) =>
          settings.routes.standaloneTypes.includes(type),
        )
      )
        continue;
      const available = tabs.filter((tab) =>
        tab.choices.some((choice) => choice.guideId === guide.id),
      );
      const tab = rule?.preferredTab
        ? available.find((tab) => tab.id === rule.preferredTab)
        : available[0];
      if (rule?.preferredTab && !tab)
        throw new Error(
          `collections.json: navigation.guides[${guide.path}].preferredTab does not contain this guide.`,
        );
      if (!tab) continue;
      if (boss.isCollection) {
        destinations.set(
          guide.id,
          `${boss.href}${settings.routes.collectionGuideSegment}/${guide.slug}/`,
        );
        continue;
      }
      if (guide.id === defaultGuide) {
        destinations.set(guide.id, boss.href);
        continue;
      }
      const query = new URLSearchParams({ tab: tab.id, guide: guide.id });
      destinations.set(guide.id, `${boss.href}?${query}`);
    }
  }
  return destinations;
}

export function guideDestination(
  guide: Pick<Guide, 'id' | 'path' | 'href'>,
  destinations: Map<string, string>,
): string {
  return destinations.get(guide.id) || guide.href;
}

export function methodDestination(
  guide: Guide,
  methodId: string,
  navigation: { id: string; anchor: string; resolved: boolean }[],
  hub: Hub | undefined,
  settings: NavigationSettings = navigationSettings,
): string {
  const rule = settings.guides[guide.path];
  const target = navigation.find((item) => item.id === methodId);
  const fragment = `#${encodeURIComponent(target?.anchor || `${guide.id}--guide-start`)}`;
  const excluded = guide.types.some((type) =>
    settings.routes.standaloneTypes.includes(type),
  );
  if (!hub || excluded || hub.isCollection) return guide.href + fragment;
  const definitions = hub.href.startsWith('/slayer/')
    ? settings.slayerTabs
    : settings.bossTabs;
  const section = guide.sections.find((section) =>
    section.methodIds.includes(methodId),
  );
  const guides = hub.guides.map((member) => ({
    ...member,
    navigation: member.id === guide.id ? navigation : [],
  }));
  const choices = definitions.flatMap((definition) => {
    const choice = tabChoices(guides, definition.id, hub.name, settings).find(
      (choice) =>
        choice.guideId === guide.id &&
        (!choice.methodId ||
          choice.methodId === methodId ||
          (target?.resolved && choice.anchor === target.anchor)),
    );
    return choice ? [{ tab: definition.id, choice }] : [];
  });
  const selected =
    choices.find((item) => item.tab === rule?.preferredTab) ||
    choices.find((item) => section?.types.includes(item.tab)) ||
    choices[0];
  if (!selected) return guide.href + fragment;
  const defaultTab = definitions.find(
    (definition) =>
      tabChoices(guides, definition.id, hub.name, settings).length,
  )!;
  const defaultGuide = tabChoices(guides, defaultTab.id, hub.name, settings)[0]
    .guideId;
  return hubChoiceHref(
    hub.href,
    selected.tab,
    {
      ...selected.choice,
      anchor: target?.anchor || `${guide.id}--guide-start`,
    },
    defaultTab.id,
    defaultGuide,
  );
}

export function guideSectionDestination(
  guide: Pick<Guide, 'path' | 'href'>,
  anchor: string,
): string {
  return `${guide.href}#${encodeURIComponent(anchor)}`;
}
