import type { WritingOvertimeRange } from "./writing.ts";

export function normalizeWritingOvertimeRanges(
  value: unknown,
  textLength: number
): WritingOvertimeRange[] {
  if (!Array.isArray(value)) return [];
  const limit = Math.max(0, Math.floor(textLength));
  const ranges = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const start = Math.max(0, Math.min(limit, Math.floor(Number((item as WritingOvertimeRange).start))));
    const end = Math.max(0, Math.min(limit, Math.floor(Number((item as WritingOvertimeRange).end))));
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [{ start, end }] : [];
  }).sort((left, right) => left.start - right.start || left.end - right.end);

  return ranges.reduce<WritingOvertimeRange[]>((merged, range) => {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
    return merged;
  }, []);
}

export function updateWritingOvertimeRanges({
  nextText,
  overtime,
  previousRanges,
  previousText
}: {
  nextText: string;
  overtime: boolean;
  previousRanges: WritingOvertimeRange[];
  previousText: string;
}) {
  let prefix = 0;
  while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < previousText.length - prefix &&
    suffix < nextText.length - prefix &&
    previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix += 1;

  const oldEnd = previousText.length - suffix;
  const newEnd = nextText.length - suffix;
  const delta = newEnd - oldEnd;
  const updated: WritingOvertimeRange[] = [];
  for (const range of normalizeWritingOvertimeRanges(previousRanges, previousText.length)) {
    if (range.end <= prefix) updated.push(range);
    else if (range.start >= oldEnd) updated.push({ start: range.start + delta, end: range.end + delta });
    else {
      if (range.start < prefix) updated.push({ start: range.start, end: prefix });
      if (range.end > oldEnd) updated.push({ start: newEnd, end: newEnd + range.end - oldEnd });
    }
  }
  if (overtime && newEnd > prefix) updated.push({ start: prefix, end: newEnd });
  return normalizeWritingOvertimeRanges(updated, nextText.length);
}

export function splitWritingTextByOvertime(
  text: string,
  ranges: WritingOvertimeRange[] | null | undefined,
  sourceStart = 0
) {
  const sourceEnd = sourceStart + text.length;
  const boundaries = new Set([sourceStart, sourceEnd]);
  for (const range of normalizeWritingOvertimeRanges(ranges, sourceEnd)) {
    if (range.end <= sourceStart || range.start >= sourceEnd) continue;
    boundaries.add(Math.max(sourceStart, range.start));
    boundaries.add(Math.min(sourceEnd, range.end));
  }
  const points = Array.from(boundaries).sort((left, right) => left - right);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    return {
      end,
      overtime: ranges?.some((range) => range.start < end && range.end > start) === true,
      start,
      text: text.slice(start - sourceStart, end - sourceStart)
    };
  });
}
