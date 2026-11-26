import { initializeInlineEditor } from './inline-editor';
import { DraftStorage, type DraftStore } from '../lib/draft-storage';
import type { GuideSourceProvider } from '../lib/guide-source-provider';

const provider: GuideSourceProvider = {
  async load(path) {
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(`${base}/guide-source/${encodedPath}.json`, {
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok)
      throw new Error(
        'Guide source unavailable. Reload the page or use Guide Editor.',
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
