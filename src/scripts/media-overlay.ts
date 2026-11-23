import { mediaLink } from '../lib/media-links';
export function initializeMediaOverlay(doc: Document = document) {
  const dialog = doc.querySelector<HTMLDialogElement>('[data-media-dialog]');
  if (!dialog || dialog.dataset.ready) return;
  const stage = dialog.querySelector<HTMLElement>('[data-media-stage]')!;
  const title = dialog.querySelector<HTMLElement>('#media-overlay-title')!;
  const original = dialog.querySelector<HTMLAnchorElement>(
    '[data-media-original]',
  )!;
  const status = dialog.querySelector<HTMLElement>('[data-media-status]')!;
  const close = dialog.querySelector<HTMLButtonElement>('[data-media-close]')!;
  let trigger: HTMLAnchorElement | undefined,
    overflow = '';
  const clear = () => {
    stage
      .querySelectorAll('iframe')
      .forEach((frame) => frame.removeAttribute('src'));
    stage.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
      video.pause?.();
      video.removeAttribute('src');
      video.load?.();
    });
    stage.replaceChildren();
    dialog.style.removeProperty('--media-natural-width');
  };
  doc.addEventListener('click', (event) => {
    const link = (event.target as Element).closest?.<HTMLAnchorElement>(
      'a[href]',
    );
    const mouse = event as MouseEvent;
    if (
      !link ||
      event.defaultPrevented ||
      mouse.button > 0 ||
      mouse.ctrlKey ||
      mouse.metaKey ||
      mouse.shiftKey ||
      mouse.altKey
    )
      return;
    const raw = link.getAttribute('href') || '';
    const media = mediaLink(raw);
    if (
      !media ||
      link === original ||
      (!link.hasAttribute('data-media-overlay') && media.kind !== 'youtube')
    )
      return;
    event.preventDefault();
    clear();
    trigger = link;
    const label =
      link.getAttribute('aria-label') ||
      link.textContent?.trim() ||
      'Media preview';
    title.textContent = label;
    original.href = raw;
    original.textContent =
      media.kind === 'youtube' ? 'Open on YouTube ↗' : 'Open original ↗';
    status.hidden = true;
    const element =
      media.kind === 'youtube'
        ? doc.createElement('iframe')
        : media.kind === 'video'
          ? doc.createElement('video')
          : doc.createElement('img');
    if (media.kind === 'youtube') {
      element.setAttribute('title', label);
      element.setAttribute(
        'allow',
        'encrypted-media; picture-in-picture; fullscreen',
      );
      element.setAttribute('allowfullscreen', '');
      element.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    } else if (media.kind === 'video') {
      const video = element as HTMLVideoElement;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      element.setAttribute('aria-label', label);
    } else element.setAttribute('alt', label);
    if (media.kind !== 'youtube')
      element.addEventListener(
        media.kind === 'video' ? 'loadedmetadata' : 'load',
        () => {
          if (!stage.contains(element)) return;
          const width =
            media.kind === 'video'
              ? (element as HTMLVideoElement).videoWidth
              : (element as HTMLImageElement).naturalWidth;
          if (width > 0) {
            element.style.width = `${width}px`;
            dialog.style.setProperty('--media-natural-width', `${width}px`);
          }
        },
      );
    element.addEventListener('error', () => {
      status.textContent = `This media could not load. Use ${media.kind === 'youtube' ? 'Open on YouTube' : 'Open original'} to view its source.`;
      status.hidden = false;
    });
    element.setAttribute('src', media.kind === 'youtube' ? media.source : raw);
    stage.append(element);
    if (!dialog.open) {
      overflow = doc.documentElement.style.overflow;
      doc.documentElement.style.overflow = 'hidden';
      dialog.showModal();
    }
    close.focus?.();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    clear();
    doc.documentElement.style.overflow = overflow;
    if (trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus?.();
    trigger = undefined;
  });
  dialog.dataset.ready = 'true';
}
if (typeof document !== 'undefined') initializeMediaOverlay();
