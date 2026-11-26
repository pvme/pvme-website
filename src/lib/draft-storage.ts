import type { EditSession, PendingChange } from './edit-session';

export interface StoredDraft {
  schemaVersion: 1;
  path: string;
  sourceHash: string;
  edits: PendingChange[];
  updatedAt: string;
  source?: 'master' | 'user-pr';
  branch?: string;
  existingReviewBranch?: string;
  revision?: string;
}
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type DraftRestore =
  | { status: 'empty' | 'restored' }
  | { status: 'unavailable'; message: string }
  | { status: 'blocked'; message: string; raw?: string };

/** The identity namespace must be replaced when an authenticated contributor changes. */
export class DraftStorage {
  private static recovery = new WeakMap<
    DraftStore,
    Map<string, string | null>
  >();
  private get recovery() {
    let recovery = DraftStorage.recovery.get(this.storage);
    if (!recovery) {
      recovery = new Map();
      DraftStorage.recovery.set(this.storage, recovery);
    }
    return recovery;
  }
  constructor(
    private readonly storage: DraftStore,
    readonly identity = 'local-development',
  ) {}
  key(path: string) {
    return `pvme-inline-draft:1:${encodeURIComponent(this.identity)}:${encodeURIComponent(path)}`;
  }
  hasDraft(path: string): boolean {
    return typeof this.snapshot(path) === 'string';
  }
  save(session: EditSession): string | undefined {
    const key = this.key(session.path);
    const raw = session.count
      ? JSON.stringify({
          schemaVersion: 1,
          path: session.path,
          sourceHash: session.sourceHash,
          edits: session.changes,
          updatedAt: new Date().toISOString(),
          source: session.loaded.source,
          branch: session.loaded.branch,
          existingReviewBranch: session.loaded.existingReviewBranch || '',
          ...(/^(github|discord):/.test(this.identity)
            ? { revision: crypto.randomUUID() }
            : {}),
        } satisfies StoredDraft)
      : null;
    try {
      if (raw === null) this.storage.removeItem(key);
      else this.storage.setItem(key, raw);
      this.recovery.delete(key);
    } catch {
      this.recovery.set(key, raw);
      return 'Draft storage is unavailable or full. Your changes remain in this tab; export them before leaving.';
    }
  }
  discard(path: string): string | undefined {
    try {
      this.storage.removeItem(this.key(path));
      this.recovery.delete(this.key(path));
    } catch {
      return 'Could not remove the stored draft. It may still be offered after a refresh.';
    }
  }
  snapshot(path: string): string | null | undefined {
    try {
      const key = this.key(path);
      const raw = this.recovery.has(key)
        ? this.recovery.get(key)!
        : this.storage.getItem(key);
      if (raw === null) return null;
      try {
        const { revision } = JSON.parse(raw);
        const marker = this.storage.getItem(
          `${this.key(path)}:submitted:${revision || 'legacy'}`,
        );
        if (marker === (revision ? '1' : raw)) return null;
      } catch {
        /* Keep malformed drafts visible for recovery. */
      }
      return raw;
    } catch {
      return undefined;
    }
  }
  /** Captured store/namespace and byte-identical revision; never delete a newer saved draft. */
  discardSubmitted(path: string, snapshot: string | null | undefined): boolean {
    if (typeof snapshot !== 'string') return false;
    try {
      if (this.storage.getItem(this.key(path)) !== snapshot) return false;
      const { revision } = JSON.parse(snapshot);
      // A compare-then-remove of the shared head could erase a cross-tab save.
      // Retire this immutable revision instead. A newer head remains visible even
      // if another tab saves between this comparison and the atomic marker write.
      this.storage.setItem(
        `${this.key(path)}:submitted:${revision || 'legacy'}`,
        revision ? '1' : snapshot,
      );
      return true;
    } catch {
      return false;
    }
  }
  restore(session: EditSession): DraftRestore {
    let raw: string | null;
    try {
      const snapshot = this.snapshot(session.path);
      if (snapshot === undefined) throw new Error('Storage unavailable');
      raw = snapshot;
    } catch {
      return {
        status: 'unavailable',
        message:
          'Browser storage is unavailable. You can continue with changes in this tab.',
      };
    }
    if (raw === null) return { status: 'empty' };
    try {
      const draft = JSON.parse(raw) as StoredDraft;
      if (
        !draft ||
        draft.schemaVersion !== 1 ||
        draft.path !== session.path ||
        typeof draft.sourceHash !== 'string' ||
        !Array.isArray(draft.edits) ||
        typeof draft.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(draft.updatedAt))
      )
        throw new Error(
          'This stored draft has an unsupported or malformed format.',
        );
      if (draft.sourceHash !== session.sourceHash)
        throw new Error(
          'This draft belongs to an older source snapshot and cannot be reapplied.',
        );
      if (
        (draft.source !== undefined &&
          draft.source !== session.loaded.source) ||
        (draft.branch !== undefined &&
          draft.branch !== session.loaded.branch) ||
        (draft.existingReviewBranch !== undefined &&
          draft.existingReviewBranch !==
            (session.loaded.existingReviewBranch || ''))
      )
        throw new Error('This draft belongs to a different source or review.');
      // Ranges and kinds come exclusively from the freshly verified session map.
      session.setChanges(draft.edits);
      return { status: 'restored' };
    } catch (error) {
      return {
        status: 'blocked',
        raw,
        message: `${error instanceof Error ? error.message : 'Invalid stored draft.'} Export it for recovery or deliberately discard it. It has not been overwritten.`,
      };
    }
  }
}
