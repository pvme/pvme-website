import configuration from '../collections.json';

export interface HubTabDefinition {
  id: string;
  label: string;
  icon: string;
  mode: 'pages' | 'methods';
  breadcrumbLabel?: string;
  showStyles?: boolean;
  dropdown?: boolean;
}
export interface GuideNavigationRule {
  tabs?: string[];
  preferredTab?: string;
}
export interface NavigationSettings {
  bossTabs: HubTabDefinition[];
  slayerTabs: HubTabDefinition[];
  overview?: {
    tab: string;
    preferredPathPrefix: string;
    preferredFilenameSuffix: string;
    hideOtherTabsFromPathPrefixes: string[];
  };
  tabRules: { pathPrefix?: string; onlyTypes?: string[]; hasMethods?: boolean; tabs: string[] }[];
  guides: Record<string, GuideNavigationRule>;
  routes: { standaloneTypes: string[]; collectionGuideSegment: string };
}

export function parseNavigationSettings(input: unknown): NavigationSettings {
  const fail = (path: string, message: string): never => { throw new Error(`collections.json: navigation.${path} ${message}`); };
  const object = (value: unknown, path: string, keys?: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object.');
    const result = value as Record<string, unknown>;
    for (const key of Object.keys(result)) if (keys && !keys.includes(key)) fail(`${path}.${key}`, 'is not a supported field.');
    return result;
  };
  const text = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail(path, 'must be a non-empty string without surrounding spaces.');
    return value as string;
  };
  const strings = (value: unknown, path: string): string[] => {
    if (!Array.isArray(value)) fail(path, 'must be an array of strings.');
    const result = (value as unknown[]).map((item, index) => text(item, `${path}[${index}]`));
    if (new Set(result).size !== result.length) fail(path, 'must not contain duplicates.');
    return result;
  };
  const boolean = (value: unknown, path: string): boolean => {
    if (typeof value !== 'boolean') fail(path, 'must be true or false.');
    return value as boolean;
  };
  const relative = (value: unknown, path: string): string => {
    const result = text(value, path);
    if (result.startsWith('/') || result.includes(':') || result.includes('\\') || result.split('/').some(part => part === '.' || part === '..')) fail(path, 'must be a relative guide path or prefix.');
    return result;
  };
  const root = object(input, 'root', ['bossTabs', 'slayerTabs', 'overview', 'tabRules', 'guides', 'routes']);
  const ids = new Set<string>();
  const tabDefinitions = (value: unknown, path: string): HubTabDefinition[] => {
    if (!Array.isArray(value) || !value.length) fail(path, 'must contain at least one tab.');
    return (value as unknown[]).map((item, index) => {
      const key = `${path}[${index}]`;
      const tab = object(item, key, ['id', 'label', 'icon', 'mode', 'breadcrumbLabel', 'showStyles', 'dropdown']);
      const id = text(tab.id, `${key}.id`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) fail(`${key}.id`, 'must be a unique lowercase tab ID.');
      ids.add(id);
      if (tab.mode !== 'pages' && tab.mode !== 'methods') fail(`${key}.mode`, 'must be pages or methods.');
      return { id, label: text(tab.label, `${key}.label`), icon: text(tab.icon, `${key}.icon`), mode: tab.mode as HubTabDefinition['mode'],
        ...(tab.breadcrumbLabel === undefined ? {} : { breadcrumbLabel: text(tab.breadcrumbLabel, `${key}.breadcrumbLabel`) }),
        ...(tab.showStyles === undefined ? {} : { showStyles: boolean(tab.showStyles, `${key}.showStyles`) }),
        ...(tab.dropdown === undefined ? {} : { dropdown: boolean(tab.dropdown, `${key}.dropdown`) }) };
    });
  };
  const bossTabs = tabDefinitions(root.bossTabs, 'bossTabs');
  const slayerTabs = tabDefinitions(root.slayerTabs, 'slayerTabs');
  const tabs = (value: unknown, path: string): string[] => {
    const result = strings(value, path);
    if (!result.length || result.some(id => !ids.has(id))) fail(path, 'must name at least one configured tab.');
    return result;
  };
  let overview: NavigationSettings['overview'];
  if (root.overview != null) {
    const value = object(root.overview, 'overview', ['tab', 'preferredPathPrefix', 'preferredFilenameSuffix', 'hideOtherTabsFromPathPrefixes']);
    const tab = text(value.tab, 'overview.tab');
    if (!bossTabs.some(item => item.id === tab)) fail('overview.tab', 'must name a configured boss tab.');
    overview = { tab, preferredPathPrefix: relative(value.preferredPathPrefix, 'overview.preferredPathPrefix'),
      preferredFilenameSuffix: text(value.preferredFilenameSuffix, 'overview.preferredFilenameSuffix'),
      hideOtherTabsFromPathPrefixes: strings(value.hideOtherTabsFromPathPrefixes, 'overview.hideOtherTabsFromPathPrefixes').map((prefix, index) => relative(prefix, `overview.hideOtherTabsFromPathPrefixes[${index}]`)) };
  }
  if (!Array.isArray(root.tabRules)) fail('tabRules', 'must be an array.');
  const tabRules = (root.tabRules as unknown[]).map((item, index) => {
    const path = `tabRules[${index}]`, rule = object(item, path, ['pathPrefix', 'onlyTypes', 'hasMethods', 'tabs']);
    if (rule.pathPrefix === undefined && rule.onlyTypes === undefined && rule.hasMethods === undefined) fail(path, 'needs a pathPrefix, onlyTypes or hasMethods condition.');
    return { ...(rule.pathPrefix === undefined ? {} : {pathPrefix: relative(rule.pathPrefix, `${path}.pathPrefix`)}),
      ...(rule.onlyTypes === undefined ? {} : {onlyTypes: strings(rule.onlyTypes, `${path}.onlyTypes`)}),
      ...(rule.hasMethods === undefined ? {} : {hasMethods: boolean(rule.hasMethods, `${path}.hasMethods`)}), tabs: tabs(rule.tabs, `${path}.tabs`) };
  });
  const guides: Record<string, GuideNavigationRule> = {};
  for (const [path, item] of Object.entries(object(root.guides, 'guides'))) {
    relative(path, `guides[${path}]`);
    const key = `guides[${path}]`, rule = object(item, key, ['tabs', 'preferredTab']);
    const configured: GuideNavigationRule = {};
    if (rule.tabs !== undefined) configured.tabs = tabs(rule.tabs, `${key}.tabs`);
    if (rule.preferredTab !== undefined) {
      configured.preferredTab = text(rule.preferredTab, `${key}.preferredTab`);
      if (!bossTabs.some(tab => tab.id === configured.preferredTab) || (configured.tabs && !configured.tabs.includes(configured.preferredTab))) fail(`${key}.preferredTab`, 'must name an available boss tab.');
    }
    guides[path] = configured;
  }
  const routes = object(root.routes, 'routes', ['standaloneTypes', 'collectionGuideSegment']);
  const collectionGuideSegment = text(routes.collectionGuideSegment, 'routes.collectionGuideSegment');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(collectionGuideSegment)) fail('routes.collectionGuideSegment', 'must be a single lowercase URL segment.');
  return { bossTabs, slayerTabs, ...(overview ? {overview} : {}), tabRules, guides,
    routes: {standaloneTypes: strings(routes.standaloneTypes, 'routes.standaloneTypes'), collectionGuideSegment} };
}

export const navigationSettings = parseNavigationSettings(configuration.navigation);
