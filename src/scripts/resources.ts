import { writeClipboard } from '../lib/clipboard';
import type { ReferenceIndexEntry } from '../lib/references';
import { searchEntries } from '../lib/search';
import { initializeHeadingLinks } from './heading-links';
import {
  initializePresetCarousel,
  initializeStandaloneMedia,
} from './preset-carousel';

export interface ReferencePayload {
  id: string;
  title: string;
  html: string;
  source: string;
  notice?: string;
}
async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Reference unavailable');
  return response.json() as Promise<T>;
}
export function initializeResources(
  root: HTMLElement,
  options: {
    view?: Window;
    loadIndex?: () => Promise<ReferenceIndexEntry[]>;
    loadPayload?: (entry: ReferenceIndexEntry) => Promise<ReferencePayload>;
    writeText?: (text: string) => Promise<void>;
    enhance?: (content: HTMLElement) => void;
  } = {},
) {
  const doc = root.ownerDocument,
    view = options.view || doc.defaultView!;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  const tabs = [
    ...root.querySelectorAll<HTMLAnchorElement>('[data-resource-tab]'),
  ];
  const input = find<HTMLInputElement>('[data-reference-search]');
  const list = find('[data-reference-list]');
  const title = find('[data-reference-title]');
  const status = find('[data-reference-status]');
  const content = find('[data-reference-content]');
  const copy = find<HTMLButtonElement>('[data-reference-copy]');
  const source = find<HTMLAnchorElement>('[data-reference-source]');
  const notice = find('[data-reference-notice]');
  const retry = find('[data-reference-retry]');
  const retryIndex = find('[data-reference-retry-index]');
  const library = find('[data-reference-library]');
  const count = find('[data-reference-count]');
  const clear = find('[data-reference-clear]');
  let rows: ReferenceIndexEntry[] = [],
    indexPromise: Promise<ReferenceIndexEntry[]> | undefined;
  let generation = 0,
    selected = '',
    listScroll = 0;
  const payloads = new Map<string, Promise<ReferencePayload>>();
  const current = () => new URL(view.location.href);
  const writeUrl = (edit: (url: URL) => void, replace = false) => {
    const url = current();
    edit(url);
    url.hash = '';
    if (url.href !== view.location.href)
      view.history[replace ? 'replaceState' : 'pushState'](null, '', url.href);
  };
  const message = (text: string) => {
    status.textContent = text;
    status.hidden = !text;
  };
  const clearContent = () => {
    content.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
      video.pause?.();
      video.removeAttribute('src');
    });
    content
      .querySelectorAll('iframe')
      .forEach((frame) => frame.removeAttribute('src'));
    content.replaceChildren();
    source.hidden = true;
    notice.hidden = true;
    copy.hidden = true;
    retry.hidden = true;
  };
  const drawList = () => {
    const matches = input.value.trim()
      ? searchEntries(
          rows.map((row) => ({
            ...row,
            category: row.category || 'Quick Reference',
          })),
          input.value,
          rows.length,
        )
      : rows;
    list.replaceChildren();
    for (const entry of matches) {
      const link = doc.createElement('a');
      link.href = entry.href;
      link.textContent = entry.title;
      link.dataset.referenceId = entry.id;
      if (entry.id === selected) link.setAttribute('aria-current', 'true');
      list.append(link);
    }
    count.textContent = matches.length
      ? `${matches.length} ${matches.length === 1 ? 'topic' : 'topics'}`
      : 'No topics found. Try another name or abbreviation.';
    clear.hidden = !input.value;
    list.scrollTop = listScroll;
  };
  const ensureIndex = () =>
    (indexPromise ||= (
      options.loadIndex ||
      (() => json<ReferenceIndexEntry[]>(root.dataset.index!))
    )()
      .then((result) => {
        rows = result;
        return rows;
      })
      .catch((error) => {
        indexPromise = undefined;
        throw error;
      }));
  const load = (entry: ReferenceIndexEntry) => {
    let pending = payloads.get(entry.id);
    if (!pending) {
      pending = (
        options.loadPayload || ((row) => json<ReferencePayload>(row.payload))
      )(entry)
        .then((result) => {
          if (result.id !== entry.id || typeof result.html !== 'string')
            throw new Error('Invalid reference payload');
          return result;
        })
        .catch((error) => {
          payloads.delete(entry.id);
          throw error;
        });
      payloads.set(entry.id, pending);
    }
    return pending;
  };
  const sync = async (focus = false) => {
    const request = ++generation,
      params = current().searchParams;
    const tab =
      params.get('tab') === 'reference' ||
      (params.has('ref') && params.get('tab') !== 'guides')
        ? 'reference'
        : 'guides';
    tabs.forEach((link) => {
      const active = link.dataset.resourceTab === tab;
      link.setAttribute('aria-selected', String(active));
      link.tabIndex = active ? 0 : -1;
    });
    root
      .querySelectorAll<HTMLElement>('[data-resource-panel]')
      .forEach((panel) => {
        panel.hidden = panel.dataset.resourcePanel !== tab;
      });
    clearContent();
    if (tab !== 'reference') return;
    selected = params.get('ref') || '';
    input.value = params.get('qref') || '';
    library.dataset.reading = String(!!selected);
    title.textContent = 'Select a topic';
    message(
      selected
        ? 'Loading reference…'
        : 'Choose a topic to read its Quick Reference.',
    );
    retryIndex.hidden = true;
    count.textContent = 'Loading topics…';
    try {
      await ensureIndex();
    } catch {
      if (request !== generation) return;
      count.textContent = 'Topics could not be loaded.';
      retryIndex.hidden = false;
      message(
        'Quick Reference is temporarily unavailable. Try loading the topics again.',
      );
      return;
    }
    if (request !== generation) return;
    drawList();
    if (!selected) {
      if (focus) input.focus({ preventScroll: true });
      return;
    }
    const entry = rows.find((row) => row.id === selected);
    if (!entry) {
      title.textContent = 'Reference not found';
      message(
        'This topic is unavailable. Choose another reference from the list.',
      );
      return;
    }
    title.textContent = entry.title;
    copy.hidden = false;
    copy.textContent = 'Copy link';
    if (focus) title.focus({ preventScroll: true });
    content.setAttribute('aria-busy', 'true');
    try {
      const payload = await load(entry);
      if (request !== generation) return;
      content.innerHTML = payload.html;
      message('');
      if (payload.notice) {
        notice.textContent = payload.notice;
        notice.hidden = false;
      }
      source.href = payload.source;
      source.hidden = false;
      (
        options.enhance ||
        ((article) => {
          initializeHeadingLinks(article);
          article
            .querySelectorAll<HTMLElement>('[data-preset-carousel]')
            .forEach(initializePresetCarousel);
          initializeStandaloneMedia(article);
        })
      )(content);
      // Direct links may include a heading fragment copied by the shared renderer.
      if (current().hash) {
        const anchor = doc.getElementById(
          decodeURIComponent(current().hash.slice(1)),
        );
        if (anchor && content.contains(anchor)) anchor.scrollIntoView?.();
      }
    } catch {
      if (request !== generation) return;
      message('This reference could not be loaded. Please try again.');
      retry.hidden = false;
    } finally {
      if (request === generation) content.removeAttribute('aria-busy');
    }
  };
  const select = async (id: string) => {
    listScroll = list.scrollTop;
    writeUrl((url) => {
      url.searchParams.set('tab', 'reference');
      url.searchParams.set('ref', id);
    });
    await sync(true);
  };
  list.addEventListener('click', (event) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(
      '[data-reference-id]',
    );
    const mouse = event as MouseEvent;
    if (
      !link ||
      mouse.button > 0 ||
      mouse.ctrlKey ||
      mouse.metaKey ||
      mouse.shiftKey ||
      mouse.altKey
    )
      return;
    event.preventDefault();
    void select(link.dataset.referenceId!);
  });
  const setTab = (tab: string) => {
    listScroll = list.scrollTop;
    writeUrl((url) => url.searchParams.set('tab', tab));
    void sync();
  };
  tabs.forEach((link, index) => {
    link.addEventListener('click', (event) => {
      const mouse = event as MouseEvent;
      if (
        mouse.button > 0 ||
        mouse.ctrlKey ||
        mouse.metaKey ||
        mouse.shiftKey ||
        mouse.altKey
      )
        return;
      event.preventDefault();
      setTab(link.dataset.resourceTab!);
    });
    link.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
        return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? tabs[0]
          : event.key === 'End'
            ? tabs.at(-1)!
            : tabs[(index + 1) % tabs.length];
      next.focus();
      setTab(next.dataset.resourceTab!);
    });
  });
  const search = () => {
    listScroll = 0;
    writeUrl((url) => {
      if (input.value) url.searchParams.set('qref', input.value);
      else url.searchParams.delete('qref');
    }, true);
    drawList();
  };
  input.addEventListener('input', search);
  clear.addEventListener('click', () => {
    input.value = '';
    search();
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.querySelector<HTMLAnchorElement>('a')?.focus();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const id = list.querySelector<HTMLElement>('[data-reference-id]')?.dataset
        .referenceId;
      if (id) void select(id);
    }
  });
  list.addEventListener('keydown', (event) => {
    const links = [...list.querySelectorAll<HTMLAnchorElement>('a')],
      index = links.indexOf(doc.activeElement as HTMLAnchorElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      links[Math.min(links.length - 1, index + 1)]?.focus();
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index <= 0) input.focus();
      else links[index - 1]?.focus();
    }
    if (event.key === 'Home') {
      event.preventDefault();
      links[0]?.focus();
    }
    if (event.key === 'End') {
      event.preventDefault();
      links.at(-1)?.focus();
    }
  });
  find('[data-reference-back]').addEventListener('click', () => {
    writeUrl((url) => url.searchParams.delete('ref'));
    void sync(true);
  });
  retry.addEventListener('click', () => void sync());
  retryIndex.addEventListener('click', () => void sync());
  copy.addEventListener('click', async () => {
    const url = new URL(view.location.pathname, view.location.origin);
    url.searchParams.set('tab', 'reference');
    url.searchParams.set('ref', selected);
    try {
      await (
        options.writeText || ((value: string) => writeClipboard(doc, value))
      )(url.href);
      copy.textContent = 'Link copied';
    } catch {
      copy.textContent = 'Copy unavailable';
    }
  });
  view.addEventListener('popstate', () => void sync());
  return { ready: sync(), sync, select };
}
if (typeof document !== 'undefined')
  document
    .querySelectorAll<HTMLElement>('[data-resources]')
    .forEach((root) => initializeResources(root));
