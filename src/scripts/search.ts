import { searchEntries, type SearchEntry } from '../lib/search';
const indexes = new Map<string, Promise<SearchEntry[]>>();
function loadIndex(url: string) {
  let pending = indexes.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((r) => {
        if (!r.ok) throw Error('Search unavailable');
        return r.json() as Promise<SearchEntry[]>;
      })
      .catch((error) => {
        indexes.delete(url);
        throw error;
      });
    indexes.set(url, pending);
  }
  return pending;
}
export function initializeSearch(
  root: HTMLElement,
  loader = () => loadIndex(root.dataset.index!),
) {
  const doc = root.ownerDocument,
    input = root.querySelector<HTMLInputElement>('input')!,
    results = root.querySelector<HTMLElement>('.search-results')!,
    clear = root.querySelector<HTMLButtonElement>('[data-search-clear]')!;
  let generation = 0,
    suppressFocus = false;
  const close = () => {
    generation++;
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };
  const mobileContainer = root.closest<HTMLElement>('.sidebar-search');
  const mobileToggle = mobileContainer?.querySelector<HTMLButtonElement>(
    '[data-mobile-search-toggle]',
  );
  const closeMobile = (restoreFocus = false) => {
    if (!mobileContainer?.hasAttribute('data-mobile-search-open')) return;
    mobileContainer.removeAttribute('data-mobile-search-open');
    mobileToggle?.setAttribute('aria-expanded', 'false');
    close();
    if (restoreFocus) mobileToggle?.focus();
  };
  const openMobile = () => {
    if (
      !mobileContainer ||
      !mobileToggle ||
      (doc.defaultView?.matchMedia &&
        !doc.defaultView.matchMedia('(max-width: 760px)').matches)
    )
      return;
    mobileContainer.setAttribute('data-mobile-search-open', '');
    mobileToggle.setAttribute('aria-expanded', 'true');
    const menu = mobileContainer
      .closest('.sidebar-navigation')
      ?.querySelector<HTMLDetailsElement>('.mobile-nav');
    if (menu) menu.open = false;
  };
  mobileToggle?.addEventListener('click', () => {
    if (mobileContainer?.hasAttribute('data-mobile-search-open'))
      closeMobile(true);
    else {
      openMobile();
      input.focus();
    }
  });
  const run = async () => {
    const query = input.value.trim(),
      request = ++generation;
    clear.hidden = !query;
    if (!query) {
      close();
      return;
    }
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    results.textContent = 'Searching…';
    try {
      const rows = await loader();
      if (request !== generation) return;
      const found = searchEntries(rows, query);
      results.replaceChildren();
      found.forEach((entry, i) => {
        const a = doc.createElement('a');
        a.href = entry.href;
        a.id = `${results.id}-option-${i}`;
        a.setAttribute('role', 'option');
        a.setAttribute('aria-selected', 'false');
        a.tabIndex = -1;
        const title = doc.createElement('span');
        title.className = 'search-result-title';
        const style = entry.styles
          ?.filter(
            (style) => !entry.title.toLowerCase().includes(style.toLowerCase()),
          )
          .join(' / ');
        title.textContent = [entry.title, entry.section, style]
          .filter(Boolean)
          .join(' - ');
        const tags = doc.createElement('span');
        tags.className = 'search-result-tags';
        const tag = doc.createElement('small');
        tag.textContent = entry.category;
        tags.append(tag);
        a.append(title, tags);
        a.addEventListener('focus', () => {
          results
            .querySelectorAll('a')
            .forEach((row) =>
              row.setAttribute('aria-selected', String(row === a)),
            );
        });
        results.append(a);
      });
      if (!found.length)
        results.textContent =
          'No results found. Try a boss, topic, abbreviation or combat style.';
    } catch {
      if (request === generation)
        results.textContent =
          'Search is unavailable. You can still browse the guide directories.';
    }
  };
  input.addEventListener('input', () => {
    void run();
  });
  input.addEventListener('focus', () => {
    if (!suppressFocus && input.value.trim()) void run();
  });
  clear.addEventListener('click', () => {
    input.value = '';
    clear.hidden = true;
    close();
    input.focus();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      if (mobileContainer?.hasAttribute('data-mobile-search-open')) {
        closeMobile(true);
        return;
      }
      suppressFocus = true;
      input.focus();
      suppressFocus = false;
      return;
    }
    const links = [...results.querySelectorAll<HTMLAnchorElement>('a')];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.hidden) {
        void run();
        return;
      }
      const index = links.indexOf(doc.activeElement as HTMLAnchorElement);
      links[(index + 1) % links.length]?.focus();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const index = links.indexOf(doc.activeElement as HTMLAnchorElement);
      if (index <= 0) {
        suppressFocus = true;
        input.focus();
        suppressFocus = false;
      } else links[index - 1]?.focus();
    }
    if (e.key === 'Enter' && doc.activeElement === input && !results.hidden) {
      e.preventDefault();
      links[0]?.click();
    }
  });
  doc.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const editing =
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      !!target.closest('[contenteditable="true"]');
    if (
      (e.key === '/' && !editing && !root.classList.contains('compact')) ||
      ((e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'k' &&
        (root.classList.contains('compact') ||
          !doc.querySelector('[data-search].compact')))
    ) {
      e.preventDefault();
      openMobile();
      input.focus();
    }
  });
  doc.addEventListener('click', (e) => {
    if (
      !root.contains(e.target as Node) &&
      !mobileToggle?.contains(e.target as Node)
    )
      close();
    if (mobileContainer && !mobileContainer.contains(e.target as Node))
      closeMobile();
  });
  root.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !root.contains(e.relatedTarget as Node)) close();
  });
  return { close, run };
}
if (typeof document !== 'undefined')
  document
    .querySelectorAll<HTMLElement>('[data-search]')
    .forEach((root) => initializeSearch(root));
