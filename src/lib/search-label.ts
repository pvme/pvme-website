import type { Guide, Hub, Method } from './catalogue';
import { pageLinkTitle } from './page-link-title';
import { navigationSettings } from '../../catalogue/src/navigation-definitions';
import { tabChoices } from './hub-menu';

export function searchTabLabel(href: string, hub?: Hub) {
  const address = new URL(href, 'https://local');
  if (hub?.isCollection && address.pathname === hub.href) return 'Collection';
  if (address.pathname.startsWith('/slayer/')) return 'Slayer';
  const tabs = hub?.href.startsWith('/slayer/')
    ? navigationSettings.slayerTabs
    : navigationSettings.bossTabs;
  const explicit = tabs.find(
    (tab) => tab.id === address.searchParams.get('tab'),
  );
  if (explicit) return explicit.label;
  if (hub && !hub.isCollection && address.pathname === hub.href) {
    const guides = hub.guides.map((guide) => ({ ...guide, navigation: [] }));
    return (
      tabs.find((tab) => tabChoices(guides, tab.id, hub.name).length)?.label ||
      'Guide'
    );
  }
  return 'Guide';
}

export function searchSectionLabel(
  section: string | undefined,
  category: string,
) {
  if (!section) return;
  const labels = [
    ...new Set([
      category,
      ...category.split('/').map((label) => label.trim()),
      category.replace(/s$/, ''),
    ]),
  ];
  const pattern = labels
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  let result = section
    .replace(new RegExp(`\\b(?:${pattern})\\b`, 'gi'), '')
    .replace(/^General\s*(?=\()/i, '')
    .replace(/^[\s/—–:-]+|[\s/—–:-]+$/g, '')
    .trim();
  if (result.startsWith('(') && result.endsWith(')'))
    result = result.slice(1, -1).trim();
  return /^(?:general|guide|method)s?$/i.test(result)
    ? undefined
    : result || undefined;
}

const plain = (text: string) =>
  text
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function guideSearchLabel(guide: Guide, hub?: Hub, method?: Method) {
  const title = pageLinkTitle(plain(hub?.name || guide.title));
  const details: string[] = [];
  const cleanSection = (text: string) => {
    const withoutDetails = plain(text).replace(
      /\(([^)]+)\)/g,
      (_match, detail: string) => {
        for (const role of detail.match(
          /\b(?:minion\s+tank|bomb\s+tank|base(?:\s+tank)?|dps|tank|normal\s+mode|hard\s+mode|nm|hm)\b/gi,
        ) || []) {
          details.push(
            pageLinkTitle(role)
              .replace(/^NM$/i, 'Normal Mode')
              .replace(/^HM$/i, 'Hard Mode'),
          );
        }
        return '';
      },
    );
    return pageLinkTitle(
      withoutDetails
        .replace(
          /\b(?:necromancy|necro|magic|mage|melee|ranged|range|hybrid)\b/gi,
          '',
        )
        .replace(/\s*[/+:—–-]\s*$/g, '')
        .replace(/^\s*[/+:—–-]\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  };
  const tabs = [
    ...navigationSettings.bossTabs,
    ...navigationSettings.slayerTabs,
  ];
  const tab = tabs.find(
    (tab) =>
      tab.id === new URL(guide.href, 'https://local').searchParams.get('tab'),
  );
  const section = method
    ? cleanSection(method.label) || 'Method'
    : hub
      ? tab?.label || 'Guide'
      : undefined;
  cleanSection(guide.title);
  const roles = [...new Set(details)].filter(
    (detail) => !section?.toLowerCase().includes(detail.toLowerCase()),
  );
  const declaration = method || guide;
  const styles = [
    ...new Set([
      ...declaration.styles,
      ...declaration.combatSetups.flatMap((setup) => setup.components),
    ]),
  ];
  return {
    title,
    section:
      roles.length && section ? `${section} (${roles.join(' / ')})` : section,
    styles: styles.filter((style) => style !== 'Hybrid' || styles.length === 1),
  };
}
