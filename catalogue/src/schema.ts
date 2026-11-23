export type BaseStyle = 'Melee' | 'Magic' | 'Ranged' | 'Necromancy';
export type Style = BaseStyle | 'Hybrid';
export type GuideType = 'boss-overview' | 'boss-rotation' | 'boss-mechanics' | 'boss-afk' | 'slayer' | 'upgrade-order' | 'combat-achievement' | 'general-pvm';
export interface GuideSection {
  id: string; match: { tag?: string; heading?: string; parents?: string[]; occurrence?: number };
  heading: Heading; tag: string | null; types: GuideType[]; methodIds: string[]; typeEvidence: Finding[];
}
export interface CombatSetup {
  style: Style; components: BaseStyle[]; origin: Finding['origin']; evidence: string;
  label?: string; line?: number; url?: string;
}
export type Confidence = 'High' | 'Medium' | 'Low';
export interface Finding { value: string; origin: 'explicit' | 'inferred'; evidence: string }
export interface Heading { text: string; label: string; level: number; line: number; endLine: number; parents: string[]; emojiNames: string[] }
export interface Method {
  anchor?: string;
  locations?: Heading[];
  type?: 'Combat Achievement' | 'Method';
  id: string; label: string; styles: Style[]; styleEvidence: Finding[];
  combatSetups?: CombatSetup[];
  attributes: Finding[]; tag: string | null; tagLine: number | null;
  heading: Heading; context: Finding[]; keywords: string[];
  confidence: Confidence; evidence: string[]; review: boolean;
}
export type ReviewLevel = 'action' | 'review' | 'info';
export type ReviewDecision = 'reviewed' | 'dismissed';
export interface IssueSource {
  kind: 'context-heading' | 'method-heading' | 'guide-title' | 'source-location'; label: string; text: string; line: number;
}
export interface Issue {
  rootCause?: string; supportingEvidence?: string[]; contradictingEvidence?: string[];
  type: string; severity: 'warning' | 'info' | 'error'; path: string; line?: number; methodId?: string; message: string;
  id?: string; reviewLevel?: ReviewLevel; explanation?: string; impact?: string; correction?: string;
  fixNecessary?: boolean; decision?: ReviewDecision;
  sources?: IssueSource[];
}
export interface DecisionRecord { decision: ReviewDecision; sourceHash: string; updatedAt: string }
export type Decisions = Record<string, DecisionRecord>;
export interface Resolution { id: string; path: string; title: string; key: string; issue: Issue; resolvedAt: string; reopenedAt?: string }
export interface SavedChange { id: string; savedAt: string; target: 'guide' | 'catalogue'; operation: 'metadata' | 'rename' | 'move'; from: string; to: string; beforeYaml?: string; afterYaml?: string }
export interface Guide {
  sourceTitle?: string;
  subjectId?: string | null;
  diagnostics?: Issue[];
  types?: GuideType[];
  sections?: GuideSection[];
  id: string; path: string; absolutePath: string; title: string; category: string;
  subject: Finding | null; metadata: unknown; styles: Style[]; attributes: Finding[];
  methods: Method[]; issues: Issue[]; status: 'classified' | 'review' | 'excluded' | 'error';
  excludedReason: string | null; parsed: { sections: number; messages: number; tags: number; diagnostics: unknown[] };
  sourceHash?: string;
  kind?: 'guide' | 'boss-overview' | 'combat-achievement';
  subjectAliases?: Finding[];
  combatSetups?: CombatSetup[];
  inspectionCandidates?: Method[];
}
export interface Catalogue {
  quickReferences?: import('./quick-reference').QuickReference[];
  referenceAudit?: { excluded: import('./quick-reference').ReferenceFinding[]; warnings: import('./quick-reference').ReferenceFinding[] };
  resolutions?: Resolution[];
  changes?: SavedChange[];
  catalogueCorrections?: string[];
  schemaVersion: 1; rulesVersion: string; generatedAt: string; sourceRoot: string;
  run: { analysed: number; parsed: number; reused: number; deleted: number; excluded: number; forced: boolean };
  stats: { total: number; eligible: number; classified: number; multipleMethods: number; ambiguous: number; review: number; methods: number; confidence: Record<Confidence, number> };
  guides: Guide[];
  reviewSummary?: Record<ReviewLevel | ReviewDecision, number>;
  reviewPolicyVersion?: string;
}
