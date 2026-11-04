/**
 * Natural visual-line extraction for the teacher comparison view.
 *
 * A visual line is whatever the browser actually wrapped onto one line at the
 * current width. It is never derived from sentences, punctuation, semantic
 * segments, or diff blocks: the caller renders the plain text in the real
 * container and this module reports the character ranges the browser chose.
 *
 * The text is small (a writing response is normally under 300 words), so a
 * single linear pass over code points is cheaper than any index or cache.
 */

export type VisualLineRange = { start: number; end: number };

/** Tolerance for sub-pixel differences between rects on the same line. */
const LINE_TOP_TOLERANCE_PX = 1;

export function visualLineRanges(root: HTMLElement, text: string): VisualLineRange[] {
  const ranges = legacyParagraphRanges(text);
  if (typeof document === "undefined" || !root || text.length === 0) return ranges;

  const node = firstTextNode(root);
  if (!node || node.data !== text) return ranges;

  const measured: VisualLineRange[] = [];
  const range = document.createRange();
  let lineStart = 0;
  let lineTop: number | null = null;

  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    if (text[index] === "\n") {
      measured.push({ start: lineStart, end: index });
      index += 1;
      lineStart = index;
      lineTop = null;
      continue;
    }
    range.setStart(node, index);
    range.setEnd(node, index + width);
    const rect = firstRect(range);
    if (rect) {
      if (lineTop === null) {
        lineTop = rect.top;
      } else if (Math.abs(rect.top - lineTop) > LINE_TOP_TOLERANCE_PX) {
        measured.push({ start: lineStart, end: index });
        lineStart = index;
        lineTop = rect.top;
      }
    }
    index += width;
  }
  measured.push({ start: lineStart, end: text.length });
  return measured.length > 0 ? measured : ranges;
}

/** Paragraph fallback for environments without layout (SSR, unit tests). */
export function legacyParagraphRanges(text: string): VisualLineRange[] {
  const ranges: VisualLineRange[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === "\n") {
      ranges.push({ start, end: index });
      start = index + 1;
    }
  }
  return ranges;
}

function firstTextNode(root: HTMLElement): Text | null {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) return child as Text;
    if (child.nodeType === 1) {
      const nested = firstTextNode(child as HTMLElement);
      if (nested) return nested;
    }
  }
  return null;
}

function firstRect(range: Range): { top: number } | null {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0
  );
  if (rects.length > 0) return { top: rects[0].top };
  const bounds = range.getBoundingClientRect();
  return bounds.height > 0 ? { top: bounds.top } : null;
}

export type StyledSegment = {
  text: string;
  changed: boolean;
};

/**
 * Cuts the pre-computed diff parts at a line boundary so each visual line can
 * be rendered separately without recomputing the diff.
 */
export function sliceStyledParts(
  parts: Array<{ text: string; changed: boolean }>,
  line: VisualLineRange
): StyledSegment[] {
  const segments: StyledSegment[] = [];
  let offset = 0;
  for (const part of parts) {
    const start = offset;
    const end = offset + part.text.length;
    offset = end;
    if (end <= line.start || start >= line.end) continue;
    const from = Math.max(start, line.start);
    const to = Math.min(end, line.end);
    if (to <= from) continue;
    segments.push({
      text: part.text.slice(from - start, to - start),
      changed: part.changed
    });
  }
  return segments;
}
