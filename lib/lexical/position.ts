export type LexicalRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

export function lexicalPopupPosition(anchor: LexicalRect, panel: { width: number; height: number },
  viewport: { width: number; height: number; left?: number; top?: number }, previous?: "above" | "below") {
  const margin = 8; const gap = 8;
  const leftEdge = (viewport.left ?? 0) + margin; const topEdge = (viewport.top ?? 0) + margin;
  const rightEdge = leftEdge + Math.max(0, viewport.width - margin * 2);
  const bottomEdge = topEdge + Math.max(0, viewport.height - margin * 2);
  const width = Math.min(panel.width, Math.max(0, rightEdge - leftEdge));
  const below = Math.max(0, bottomEdge - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - topEdge);
  // Prefer below, but when neither side fits use the roomier side. A small
  // release margin avoids toggling at fractional-pixel/font rounding boundaries.
  const flip = previous === "above" ? panel.height + 16 > below && above >= below
    || panel.height > below && panel.height <= above
    : panel.height > below && above > below;
  const available = flip ? above : below;
  const maxHeight = Math.min(bottomEdge - topEdge, available >= 80 ? available : bottomEdge - topEdge);
  const height = Math.min(panel.height, maxHeight);
  return { left: Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)),
    top: Math.max(topEdge, Math.min(flip ? anchor.top - gap - height : anchor.bottom + gap, bottomEdge - height)),
    width, maxHeight, placement: flip ? "above" : "below" };
}

/** The outer panel's scrollHeight is capped by its inner scroller and is NOT
 * intrinsic content height. Measure the unconstrained content, including the
 * scroller's p-4 (32px) and the outer border, never its applied maxHeight. */
export function lexicalPopupNaturalHeight(content: { scrollHeight: number }, panel: { offsetHeight: number; clientHeight: number }) {
  return content.scrollHeight + 32 + panel.offsetHeight - panel.clientHeight;
}

/** DOM selection geometry, including browsers whose bounding rect is empty. */
export function lexicalRangeRect(range: Range): LexicalRect | null {
  const bounds = range.getBoundingClientRect();
  if (bounds.width > 0 && bounds.height > 0) return bounds;
  return Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0) ?? null;
}
