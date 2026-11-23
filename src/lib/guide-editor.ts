import type { Guide } from './catalogue';

export function guideEditorHref(guide: Pick<Guide, 'path'>): string {
  const editor = new URL('https://pvme.io/guide-editor/');
  editor.searchParams.set('id', guide.path);
  return editor.href;
}
