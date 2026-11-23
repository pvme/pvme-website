export function initializeHeadingLinks(
  root: Document | HTMLElement = document,
  options: {
    currentUrl?: () => string;
    writeText?: (value: string) => Promise<void>;
  } = {},
) {
  const doc = root.ownerDocument || (root as Document);
  const view = doc.defaultView;
  const copy =
    options.writeText ||
    (async (value: string) => {
      try {
        if (view?.navigator.clipboard?.writeText) {
          await view.navigator.clipboard.writeText(value);
          return;
        }
      } catch {
        /* Fall back when clipboard access is unavailable. */
      }
      const active = doc.activeElement as HTMLElement | null;
      const field = doc.createElement('textarea');
      field.value = value;
      field.readOnly = true;
      field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      doc.body.append(field);
      field.select();
      let copied = false;
      try {
        copied = doc.execCommand?.('copy') || false;
      } finally {
        field.remove();
        active?.focus?.({ preventScroll: true });
      }
      if (!copied) throw new Error('Clipboard unavailable');
    });
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((heading) => {
    // Cards already have a destination; avoid nesting links inside their links.
    if (
      heading.closest('a,button,summary,dialog') ||
      heading.querySelector('[data-heading-link]')
    )
      return;
    const label = heading.textContent?.trim() || 'section';
    if (!heading.id) {
      const base =
        'heading-' +
        (label
          .normalize('NFKD')
          .toLowerCase()
          .replace(/\p{M}/gu, '')
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-|-$/g, '') || 'section');
      let id = base,
        suffix = 2;
      while (doc.getElementById(id)) id = `${base}-${suffix++}`;
      heading.id = id;
    }
    const link = doc.createElement('a');
    link.className = 'heading-permalink';
    link.dataset.headingLink = '';
    link.href = '#' + encodeURIComponent(heading.id);
    link.setAttribute('aria-label', `Copy link to ${label}`);
    link.title = 'Copy link to this heading';
    link.addEventListener('click', async (event) => {
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
      let status = doc.getElementById('heading-copy-status');
      if (!status) {
        status = doc.createElement('span');
        status.id = 'heading-copy-status';
        status.className = 'heading-copy-status';
        status.setAttribute('role', 'status');
        doc.body.append(status);
      }
      clearTimeout(statusTimer);
      try {
        const address = new URL(
          link.getAttribute('href')!,
          options.currentUrl?.() || view!.location.href,
        );
        await copy(address.href);
        status.textContent = 'Link copied';
      } catch {
        status.textContent =
          'Could not copy. Use the link’s context menu to copy its address.';
      }
      status.hidden = false;
      statusTimer = setTimeout(() => {
        status!.hidden = true;
      }, 2200);
    });
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute(
      'd',
      'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
    );
    svg.append(path);
    link.append(svg);
    heading.classList.add('has-permalink');
    heading.append(link);
  });
}
if (typeof document !== 'undefined') {
  const main = document.querySelector<HTMLElement>('main');
  if (main) {
    initializeHeadingLinks(main);
    // Page headings receive IDs during enhancement; honour a direct visit too.
    try {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id.startsWith('heading-')) {
        const target = document.getElementById(id);
        if (target && main.contains(target))
          requestAnimationFrame(() => target.scrollIntoView());
      }
    } catch {
      // Malformed fragments do not affect the reader.
    }
  }
}
