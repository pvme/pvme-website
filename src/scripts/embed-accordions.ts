function panelFor(element: Element) {
  if (element.matches('.mechanic-message')) return element;
  if (element.matches('.guide-embed')) return element;
  if (
    element.matches('.guide-message') &&
    element.children.length === 1 &&
    element.firstElementChild?.matches('.guide-embed')
  )
    return element.firstElementChild;
}

function titleFor(panel: Element) {
  const first = panel.firstElementChild;
  return first?.matches('h2,h3,h4,strong') ? first : undefined;
}

export function initializeEmbedAccordions(root: HTMLElement) {
  // Enhance existing markup; without JavaScript every panel stays readable.
  for (const parent of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    let run: { element: Element; panel: Element; title: Element }[] = [];
    const flush = () => {
      if (run.length > 1)
        run.forEach(({ element, panel, title }, index) => {
          const details = root.ownerDocument.createElement('details');
          details.className = 'embed-accordion';
          details.open = index === 0;
          const summary = root.ownerDocument.createElement('summary');
          element.before(details);
          summary.append(title);
          details.append(summary, element);
          panel.classList.add('embed-accordion-body');
        });
      run = [];
    };
    for (const element of [...parent.children]) {
      if (element.matches('.anchor')) continue;
      const panel = panelFor(element);
      const title = panel && titleFor(panel);
      if (panel && title) run.push({ element, panel, title });
      else flush();
    }
    flush();
  }
}

export function revealEmbedAnchor(doc: Document, hash: string) {
  let id: string;
  try {
    id = decodeURIComponent(hash.replace(/^#/, ''));
  } catch {
    return;
  }
  if (!id) return;
  const target = doc.getElementById(id);
  if (!target) return;
  let panel = target.closest('details.embed-accordion');
  if (!panel && target.matches('.anchor')) {
    let next = target.nextElementSibling;
    while (next?.matches('.anchor')) next = next.nextElementSibling;
    if (next?.matches('details.embed-accordion')) panel = next;
  }
  if (panel) (panel as HTMLDetailsElement).open = true;
}

if (typeof document !== 'undefined') {
  document
    .querySelectorAll<HTMLElement>('.reader-layout .guide-content')
    .forEach(initializeEmbedAccordions);
  const reveal = () => revealEmbedAnchor(document, location.hash);
  reveal();
  window.addEventListener('hashchange', reveal);
  document.addEventListener('pvme:guide-change', reveal);
  document.addEventListener(
    'click',
    (event) => {
      const link = (event.target as Element).closest?.<HTMLAnchorElement>(
        'a[href]',
      );
      if (!link) return;
      const destination = new URL(link.href, location.href);
      if (
        destination.origin === location.origin &&
        destination.pathname === location.pathname
      )
        revealEmbedAnchor(document, destination.hash);
    },
    true,
  );
}
