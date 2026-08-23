export type WritingReviewTextUnit = { unitId: string; startOffset: number; endOffset: number; text: string };
const ABBREVIATION = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr)\.|\b(?:e\.g|i\.e)\.|\b(?:[A-Z]\.)+)$/;
export function buildWritingReviewTextUnits(responseText: string): WritingReviewTextUnit[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const candidates: Array<{ start: number; end: number }> = [];
  const linePattern = /[^\r\n]+/g;
  for (let line = linePattern.exec(responseText); line; line = linePattern.exec(responseText)) {
    const lineStart = line.index; const lineText = line[0];
    const parts = Array.from(segmenter.segment(lineText) as unknown as ArrayLike<{ index: number; segment: string }>);
    for (const part of parts) {
      let start = lineStart + part.index; let end = start + part.segment.length;
      while (start < end && /\s/.test(responseText[start])) start++;
      while (end > start && /\s/.test(responseText[end - 1])) end--;
      if (start < end) candidates.push({ start, end });
    }
  }
  const merged: Array<{ start: number; end: number }> = [];
  for (const next of candidates) { const previous = merged.at(-1); if (previous && ABBREVIATION.test(responseText.slice(previous.start, previous.end)) && /^[A-Z]/.test(responseText.slice(next.start, next.end))) previous.end = next.end; else merged.push(next); }
  const units = merged.map((unit, index) => ({ unitId: `U${String(index + 1).padStart(2, "0")}`, startOffset: unit.start, endOffset: unit.end, text: responseText.slice(unit.start, unit.end) }));
  validateWritingReviewTextUnits(responseText, units); return units;
}
export function validateWritingReviewTextUnits(responseText: string, units: WritingReviewTextUnit[]) {
  let previousEnd = 0; const ids = new Set<string>();
  for (const unit of units) { if (!/^U\d{2}$/.test(unit.unitId) || ids.has(unit.unitId) || !Number.isInteger(unit.startOffset) || !Number.isInteger(unit.endOffset) || unit.startOffset < previousEnd || unit.endOffset <= unit.startOffset || unit.endOffset > responseText.length || unit.text !== responseText.slice(unit.startOffset, unit.endOffset) || !unit.text.trim()) throw Object.assign(new Error("Invalid writing review text units."), { code: "PREPROCESSING_INVALID" }); ids.add(unit.unitId); previousEnd = unit.endOffset; }
  if (units.map((unit) => unit.text.replace(/\s/g, "")).join("") !== responseText.replace(/\s/g, "")) throw Object.assign(new Error("Writing review text units do not cover source exactly."), { code: "PREPROCESSING_INVALID" });
}
