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
