const pendingPlayers = new WeakMap<HTMLIFrameElement, IntersectionObserver>();

function syncPlayer(frame: HTMLIFrameElement, active: boolean) {
  if (!active) {
    pendingPlayers.get(frame)?.disconnect();
    pendingPlayers.delete(frame);
    frame.removeAttribute('src');
    return;
  }
  if (frame.hasAttribute('src') || pendingPlayers.has(frame)) return;
  const Observer = frame.ownerDocument.defaultView?.IntersectionObserver;
  if (!Observer) {
    frame.setAttribute('src', frame.dataset.mediaSrc!);
    return;
  }
  // An off-screen YouTube error/player UI can claim focus and scroll the page.
  // Load only when the selected player actually enters the reader's viewport.
  const observer = new Observer((entries) => {
    if (pendingPlayers.get(frame) !== observer) return;
    if (
      !entries.some((entry) => entry.target === frame && entry.isIntersecting)
    )
      return;
    if (frame.closest('[hidden]')) return;
    frame.setAttribute('src', frame.dataset.mediaSrc!);
    observer.disconnect();
    pendingPlayers.delete(frame);
  });
  pendingPlayers.set(frame, observer);
  observer.observe(frame);
}

export function initializePresetCarousel(root: HTMLElement) {
  if (root.dataset.carouselReady) return;
  const track = root.querySelector<HTMLElement>('[data-preset-track]')!;
  const slides = [...root.querySelectorAll<HTMLElement>('[data-preset-slide]')];
  const previous = root.querySelector<HTMLButtonElement>('[data-preset-prev]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-preset-next]')!;
  const count = root.querySelector<HTMLElement>('[data-preset-count]')!;
  const view = root.ownerDocument.defaultView;
  const group = root.closest<HTMLElement>('[data-media-switcher-group]');
  const destinations = slides.map((slide) =>
    slide
      .querySelector<HTMLAnchorElement>(
        '.preset-preview-card,.preset-preview-action',
      )
      ?.getAttribute('href'),
  );
  const triggers = group
    ? [...group.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .filter(
          (link) =>
            !root.contains(link) &&
            link.dataset.mediaOverlay !== 'youtube' &&
            link.closest('[data-media-switcher-group]') === group,
        )
        .map((link) => ({
          link,
          position: destinations.indexOf(link.getAttribute('href')),
        }))
        .filter(({ position }) => position >= 0)
    : [];
  let index = 0;
  const syncMedia = () => {
    slides.forEach((slide, position) => {
      const active = position === index && !root.closest('[hidden]');
      slide
        .querySelectorAll<HTMLIFrameElement>('iframe[data-media-src]')
        .forEach((frame) => {
          syncPlayer(frame, active);
        });
      if (!active)
        slide.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
          if (!video.paused) video.pause?.();
        });
    });
  };
  const display = (value: number) => {
    index = Math.max(0, Math.min(slides.length - 1, value));
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    count.textContent = `${index + 1} / ${slides.length}`;
    triggers.forEach(({ link, position }) => {
      if (position === index) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
    syncMedia();
  };
  const update = () => {
    if (track.clientWidth)
      display(Math.round(track.scrollLeft / track.clientWidth));
    else syncMedia();
  };
  const go = (value: number, instant = false) => {
    display(value);
    track.scrollTo({
      left: index * track.clientWidth,
      behavior:
        instant ||
        view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
    });
  };
  triggers.forEach(({ link, position }) => {
    link.dataset.switcherTrigger = '';
    link.title = 'Show this item in the preview';
    link.addEventListener('click', (event) => {
      const mouse = event as MouseEvent;
      if (
        event.defaultPrevented ||
        mouse.button > 0 ||
        mouse.ctrlKey ||
        mouse.metaKey ||
        mouse.shiftKey ||
        mouse.altKey
      )
        return;
      event.preventDefault();
      go(position, true);
      root.scrollIntoView?.({
        block: 'nearest',
        behavior: view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
      slides[position]
        .querySelector<HTMLAnchorElement>(
          '.preset-preview-card,.preset-preview-action',
        )
        ?.focus?.({ preventScroll: true });
    });
  });
  previous.addEventListener('click', () => go(index - 1));
  next.addEventListener('click', () => go(index + 1));
  track.addEventListener('scroll', update, { passive: true });
  track.addEventListener('keydown', (event) => {
    if ((event.target as Element).closest('a,button,video,iframe')) return;
    const destination =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? slides.length - 1
              : undefined;
    if (destination === undefined) return;
    event.preventDefault();
    go(destination);
  });
  view?.addEventListener('resize', update);
  root.ownerDocument.addEventListener('pvme:guide-change', update);
  root.querySelector<HTMLElement>('.preset-carousel-controls')!.hidden = false;
  root.dataset.carouselReady = 'true';
  display(0);
}
export function initializeStandaloneMedia(
  root: Document | HTMLElement = document,
) {
  root
    .querySelectorAll<HTMLIFrameElement>(
      '.media-preview-card iframe[data-media-src]',
    )
    .forEach((frame) => {
      if (frame.closest('[data-preset-carousel]')) return;
      syncPlayer(frame, !frame.closest('[hidden]'));
    });
  root
    .querySelectorAll<HTMLVideoElement>('.media-preview-card video')
    .forEach((video) => {
      if (video.closest('[hidden]') && !video.paused) video.pause?.();
    });
}
if (typeof document !== 'undefined') {
  document
    .querySelectorAll<HTMLElement>('[data-preset-carousel]')
    .forEach(initializePresetCarousel);
  initializeStandaloneMedia();
  document.addEventListener('pvme:guide-change', () =>
    initializeStandaloneMedia(),
  );
}
