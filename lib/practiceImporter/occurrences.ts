import type { PracticeOccurrence } from "./types.ts";

export class OccurrenceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OccurrenceParseError";
  }
}

export function parseBuildSentenceOccurrences(setId: string, setTitle?: string) {
  for (const source of [setId, setTitle ?? ""]) {
    const match = source.match(/(\d{4})(\d{2})[-_](\d{2})(\d{2})(?:[-_]|$)/);
    if (!match) continue;
    const occurredOn = validDate(Number(match[1]), Number(match[3]), Number(match[4]));
    if (!occurredOn) continue;
    return [{ occurredOn, sourceLabel: setTitle?.trim() || setId.trim() }];
  }
  throw new OccurrenceParseError(`无法从 BAS set_id / set_title 解析真实日期：${setId}`);
}

export function parseWritingOccurrences(input: {
  sourceLabels: string;
  yearMonth: string;
  setTitle?: string;
  setId?: string;
}) {
  const yearMatch = input.yearMonth.trim().match(/^(\d{4})(\d{2})$/);
  if (!yearMatch) {
    throw new OccurrenceParseError(`year_month 必须为 YYYYMM：${input.yearMonth}`);
  }
  const year = Number(yearMatch[1]);
  const sources = [input.sourceLabels, input.setTitle ?? "", input.setId ?? ""];

  for (const source of sources) {
    const labels = source
      .split(/\s*(?:\||\/|；|;)\s*/)
      .map((label) => label.trim())
      .filter(Boolean);
    const occurrences: PracticeOccurrence[] = [];
    let parseFailed = false;

    for (const label of labels) {
      const match = label.match(
        /(?:^|\s)(\d{1,2})[.\-月](\d{1,2})(?:日)?\s*(?:[A-Za-z]|-\d+)?\s*$/
      );
      if (!match) {
        parseFailed = true;
        break;
      }
      const occurredOn = validDate(year, Number(match[1]), Number(match[2]));
      if (!occurredOn) {
        parseFailed = true;
        break;
      }
      occurrences.push({ occurredOn, sourceLabel: label });
    }

    if (!parseFailed && occurrences.length > 0) return deduplicateOccurrences(occurrences);
  }
  const setIdMatch = input.setId?.match(/^(\d{4})(\d{2})[-_](\d{2})(\d{2})(?:[-_]|$)/);
  if (setIdMatch && Number(setIdMatch[1]) === year) {
    const occurredOn = validDate(year, Number(setIdMatch[3]), Number(setIdMatch[4]));
    if (occurredOn) {
      return [{ occurredOn, sourceLabel: input.setId?.trim() || occurredOn }];
    }
  }
  throw new OccurrenceParseError(
    `无法从 source_labels / set_title / set_id 解析真实日期：${input.sourceLabels || "(empty)"}`
  );
}

function validDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function deduplicateOccurrences(occurrences: PracticeOccurrence[]) {
  return Array.from(
    new Map(occurrences.map((occurrence) => [`${occurrence.occurredOn}\u0000${occurrence.sourceLabel}`, occurrence])).values()
  );
}
