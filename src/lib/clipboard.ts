/** Copy links consistently, including the fallback for restricted clipboard access. */
export async function writeClipboard(
  doc: Document,
  value: string,
): Promise<void> {
  try {
    const clipboard = doc.defaultView?.navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(value);
      return;
    }
  } catch {
    // Older browsers and restricted contexts may still allow a selected-text copy.
  }
  const active = doc.activeElement as HTMLElement | null;
  const field = doc.createElement('textarea');
  field.value = value;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  doc.body.append(field);
  field.select();
  try {
    if (!doc.execCommand?.('copy')) throw new Error('Clipboard unavailable');
  } finally {
    field.remove();
    active?.focus?.({ preventScroll: true });
  }
}
