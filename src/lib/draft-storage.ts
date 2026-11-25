import type { EditSession, PendingChange } from './edit-session';

export interface StoredDraft {
  schemaVersion: 1;
  path: string;
  sourceHash: string;
  edits: PendingChange[];
  updatedAt: string;
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
  constructor(
    private readonly storage: DraftStore,
    readonly identity = 'local-development',
  ) {}
  key(path: string) {
    return `pvme-inline-draft:1:${encodeURIComponent(this.identity)}:${encodeURIComponent(path)}`;
  }
  hasDraft(path: string): boolean {
    try {
      return this.storage.getItem(this.key(path)) !== null;
    } catch {
      return false;
    }
  }
  save(session: EditSession): string | undefined {
    try {
      if (!session.count) this.storage.removeItem(this.key(session.path));
      else
        this.storage.setItem(
          this.key(session.path),
          JSON.stringify({
            schemaVersion: 1,
            path: session.path,
            sourceHash: session.sourceHash,
            edits: session.changes,
            updatedAt: new Date().toISOString(),
          } satisfies StoredDraft),
        );
    } catch {
      return 'Draft storage is unavailable or full. Your changes remain in this tab; export them before leaving.';
    }
  }
  discard(path: string): string | undefined {
    try {
      this.storage.removeItem(this.key(path));
    } catch {
      return 'Could not remove the stored draft. It may still be offered after a refresh.';
    }
  }
  restore(session: EditSession): DraftRestore {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key(session.path));
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
