import { initializeInlineEditor } from './inline-editor';
import { DraftStorage, type DraftStore } from '../lib/draft-storage';
import type { GuideSourceProvider } from '../lib/guide-source-provider';

// This module is referenced only by development-only markup. No production API fallback.
if (import.meta.env.DEV) {
  const provider: GuideSourceProvider = {
    async load(path) {
      const response = await fetch(
        `/__dev/guide-source?${new URLSearchParams({ path })}`,
        {
          credentials: 'omit',
          cache: 'no-store',
        },
      );
      if (!response.ok)
        throw new Error(
          'Local guide source unavailable. Check the development flag or use Guide Editor.',
        );
      return response.json();
    },
  };
  let storage: DraftStore;
  try {
    storage = window.localStorage;
  } catch {
    storage = {
      getItem() {
        throw new Error('Storage unavailable');
      },
      setItem() {
        throw new Error('Storage unavailable');
      },
      removeItem() {
        throw new Error('Storage unavailable');
      },
    };
  }
  initializeInlineEditor(document, {
    pageCanvas: true,
    refreshEmojis: true,
    provider,
    drafts: new DraftStorage(storage),
  });
}
