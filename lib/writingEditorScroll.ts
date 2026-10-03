/**
 * Geometry helpers for the transparent textarea + mirror pair used by the
 * writing editor. Both layers must lay out identical text at identical
 * widths, and the mirror must follow the textarea's real scroll position at
 * every synchronization point (not only on scroll events).
 */

/**
 * Width the textarea's layout scrollbar actually takes from its content box.
 * Classic scrollbars report the full width; overlay scrollbars report 0, so
 * the mirror only gives up space when the platform really consumes it.
 */
export function writingScrollbarWidth(offsetWidth: number, clientWidth: number) {
  if (!Number.isFinite(offsetWidth) || !Number.isFinite(clientWidth)) return 0;
  return Math.max(0, Math.round(offsetWidth - clientWidth));
}

/**
 * Resolves the mirror's scrollTop from the textarea's real scroll position.
 * Values are clamped to the mirror's own scrollable range; when the textarea
 * sits at its bottom edge, the mirror is pinned to its bottom as well so both
 * layers show the end of the document even if their heights differ by a
 * sub-pixel rounding amount.
 */
export function resolveMirrorScrollTop(input: {
  textareaScrollTop: number;
  textareaScrollHeight: number;
  textareaClientHeight: number;
  mirrorScrollHeight: number;
  mirrorClientHeight: number;
}) {
  const textareaMax = Math.max(0, input.textareaScrollHeight - input.textareaClientHeight);
  const mirrorMax = Math.max(0, input.mirrorScrollHeight - input.mirrorClientHeight);
  const scrollTop = Math.max(0, Number.isFinite(input.textareaScrollTop) ? input.textareaScrollTop : 0);
  const atBottom = textareaMax - scrollTop <= 1;
  return atBottom ? mirrorMax : Math.min(scrollTop, mirrorMax);
}
