/** Native textarea values normalise CRLF/CR; parser offsets never do.
 * Only translate when the complete displayed value matches that transformation.
 */
export function textareaSourceOffset(
  source: string,
  displayed: string,
  offset: number,
): number | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return;
  if (displayed === source) return offset;
  if (displayed === source.replace(/\r\n|\r/g, '\n'))
    return source.slice(0, offset).replace(/\r\n|\r/g, '\n').length;
}
