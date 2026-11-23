export interface NavigationMethod {
  id: string;
  label: string;
  styles: string[];
  attributes: string[];
  context: string[];
}
export interface NavigationGuide {
  id: string;
  styles: string[];
  attributes: string[];
  methods: NavigationMethod[];
  sections: { types: string[]; methodIds: string[] }[];
}
export function methodsForTab(guide: NavigationGuide, tab: string) {
  const sections = guide.sections.filter((s) => s.types.includes(tab));
  const ids = new Set(sections.flatMap((s) => s.methodIds));
  return guide.methods.filter((m) => !sections.length || ids.has(m.id));
}
export function methodMatches(
  method: NavigationMethod,
  style: string,
  variant: string,
) {
  return (
    (!style || !method.styles.length || method.styles.includes(style)) &&
    (!variant || method.attributes.includes(variant))
  );
}
export function guideMatches(
  guide: NavigationGuide,
  tab: string,
  style: string,
  variant: string,
) {
  const methods = methodsForTab(guide, tab);
  return methods.length
    ? methods.some((m) => methodMatches(m, style, variant))
    : (!style || guide.styles.includes(style)) &&
        (!variant || guide.attributes.includes(variant));
}
