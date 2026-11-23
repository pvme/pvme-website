type DirectoryBrowser = Pick<
  Window,
  'location' | 'history' | 'addEventListener'
>;
export function initializeDirectory(
  root: HTMLElement,
  browser: DirectoryBrowser = window,
) {
  const toolbar = root.querySelector<HTMLElement>('.sticky-directory-controls');
  const view = root.ownerDocument.defaultView;
  if (toolbar && view?.requestAnimationFrame) {
    let scheduled = false;
    const updateSticky = () => {
      scheduled = false;
      const bounds = toolbar.getBoundingClientRect();
      const content = root.closest('main')?.getBoundingClientRect();
      if (content) {
        // Follow the content area's edges, including centred page gutters.
        toolbar.style.setProperty(
          '--sticky-inset-left',
          `${content.left - bounds.left}px`,
        );
        toolbar.style.setProperty(
          '--sticky-inset-right',
          `${bounds.right - content.right}px`,
        );
      }
      toolbar.classList.toggle('is-stuck', bounds.top <= 0);
    };
    const scheduleSticky = () => {
      if (scheduled) return;
      scheduled = true;
      view.requestAnimationFrame(updateSticky);
    };
    view.addEventListener('scroll', scheduleSticky, { passive: true });
    view.addEventListener('resize', scheduleSticky);
    scheduleSticky();
  }
  const input = root.querySelector<HTMLInputElement>('[data-directory-query]')!;
  const entries = [...root.querySelectorAll<HTMLElement>('[data-entry]')];
  const reset = [
    ...root.querySelectorAll<HTMLButtonElement>('[data-directory-reset]'),
  ];
  const controls = [
    ...root.querySelectorAll<HTMLButtonElement>('[data-dir-key]'),
  ];
  let params = new URLSearchParams(browser.location.search);
  // Keep existing bookmarked exact catalogue values usable after grouping filters.
  const canonicalAttribute = (value: string) =>
    controls.find(
      (c) =>
        c.dataset.dirKey === 'attribute' &&
        JSON.parse(c.dataset.matchValues || '[]').includes(value),
    )?.dataset.value || value;
  const valid = (key: string) => {
    const raw = params.get(key) || '';
    const value = key === 'attribute' ? canonicalAttribute(raw) : raw;
    return controls.some(
      (c) => c.dataset.dirKey === key && c.dataset.value === value,
    )
      ? value
      : '';
  };
  const apply = (persist = false) => {
    const q = input.value.trim().toLowerCase(),
      style = valid('style'),
      topic = valid('topic'),
      attribute = valid('attribute');
    const words = q.split(/\s+/).filter(Boolean);
    const attributeValues: string[] = JSON.parse(
      controls.find(
        (c) =>
          c.dataset.dirKey === 'attribute' && c.dataset.value === attribute,
      )?.dataset.matchValues || '[]',
    );
    root
      .querySelectorAll<HTMLElement>('[data-alphabet-heading]')
      .forEach((heading) => {
        heading.hidden = !!(q || style || topic || attribute);
      });
    for (const entry of entries) {
      const strings = (key: string): string[] =>
        JSON.parse(entry.dataset[key] || '[]');
      entry.hidden =
        !words.every((word) => entry.dataset.terms!.includes(word)) ||
        (!!style && !strings('styles').includes(style)) ||
        (!!topic && entry.dataset.category !== topic) ||
        (!!attribute &&
          !strings('attributes').some((a) => attributeValues.includes(a)));
    }
    root
      .querySelectorAll<HTMLElement>('[data-directory-card-group]')
      .forEach((group) => {
        const heading = group.querySelector<HTMLElement>(
          '[data-directory-group-heading]',
        );
        if (heading)
          heading.hidden =
            !!(q || style || topic || attribute) ||
            ![...group.querySelectorAll<HTMLElement>('[data-entry]')].some(
              (entry) => !entry.hidden,
            );
      });
    const count = entries.filter((e) => !e.hidden).length;
    root.querySelector<HTMLElement>('.filter-status')!.textContent =
      `${count} ${root.dataset.directoryLabel}${style ? ' · ' + style : ''}${topic ? ' · ' + topic : ''}`;
    root.querySelector<HTMLElement>('.empty-state')!.hidden = count > 0;
    reset.forEach((b) => (b.hidden = !(q || style || topic || attribute)));
    controls.forEach((b) =>
      b.setAttribute(
        'aria-pressed',
        String(
          (b.dataset.dirKey === 'style'
            ? style
            : b.dataset.dirKey === 'topic'
              ? topic
              : attribute) === b.dataset.value,
        ),
      ),
    );
    if (persist) {
      // Resources tabs can update the URL without a popstate event.
      // Preserve their current state when writing directory filters.
      params = new URLSearchParams(browser.location.search);
      q ? params.set('q', input.value.trim()) : params.delete('q');
      for (const [key, value] of [
        ['style', style],
        ['topic', topic],
        ['attribute', attribute],
      ])
        value ? params.set(key, value) : params.delete(key);
      browser.history.replaceState(
        null,
        '',
        browser.location.pathname +
          (params.size ? '?' + params : '') +
          browser.location.hash,
      );
    }
  };
  input.value = params.get('q') || '';
  input.addEventListener('input', () => apply(true));
  controls.forEach((b) =>
    b.addEventListener('click', () => {
      params.set(b.dataset.dirKey!, b.dataset.value!);
      apply(true);
    }),
  );
  reset.forEach((b) =>
    b.addEventListener('click', () => {
      for (const key of ['q', 'style', 'topic', 'attribute'])
        params.delete(key);
      input.value = '';
      apply(true);
      input.focus({ preventScroll: true });
    }),
  );
  browser.addEventListener('popstate', () => {
    params = new URLSearchParams(browser.location.search);
    input.value = params.get('q') || '';
    apply();
  });
  apply();
}
if (typeof document !== 'undefined')
  document
    .querySelectorAll<HTMLElement>('[data-directory]')
    .forEach((root) => initializeDirectory(root));
