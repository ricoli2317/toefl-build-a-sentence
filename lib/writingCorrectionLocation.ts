import type { Ledger } from "./writingRevisionLedger.ts";
import { offsetAt } from "./writingRevisionLedger.ts";

type Range = { from: number; to: number };
export type CorrectionLocation = { ranges: Range[]; deletions: Array<{ id: string; position: number; ranges?: Range[] }> };

/** Presentation-only provenance projection. Never modifies/reconstructs a ledger. */
export function correctionIssueLocation(ledger: Ledger, issue: {
  original_text: string | null; original_sentence: string | null; source_start?: number; source_end?: number;
}): CorrectionLocation | null {
  const text = issue.original_text || issue.original_sentence || "";
  let from = issue.source_start;
  let to = issue.source_end;
  if (from === undefined || to === undefined || !Number.isInteger(from) || !Number.isInteger(to)
    || from < 0 || to <= from || to > ledger.original.length || (text && ledger.original.slice(from, to) !== text)) {
    const at = text ? ledger.original.indexOf(text) : -1;
    // Ambiguous quotes must not highlight an arbitrary occurrence.
    if (at < 0 || ledger.original.indexOf(text, at + 1) !== -1) return null;
    from = at; to = at + text.length;
  }
  const selected = new Set<number>();
  ledger.sources.forEach((source, index) => {
    if (typeof source !== "number" || source < from! || source >= to!) return;
    selected.add(index);
  });
  const deletions = ledger.deletions.flatMap(deletion => {
    const indices = deletion.sources.flatMap((source, index) => source >= from! && source < to! ? [index] : []);
    return indices.length ? [{ id: deletion.id, position: offsetAt(ledger.text, deletion.position), ranges: contiguousRanges(indices) }] : [];
  });

  // Insertions carry transaction identities, not baseline offsets. Project each
  // contiguous inserted run through its surviving baseline neighbours AND the
  // actual deletion anchor. Never search the final essay for a similar phrase.
  for (let index = 0; index < ledger.sources.length;) {
    if (typeof ledger.sources[index] === "number") { index++; continue; }
    const start = index;
    while (index < ledger.sources.length && typeof ledger.sources[index] === "string") index++;
    const left = start > 0 ? (ledger.sources[start - 1] as number) + 1 : 0;
    const right = index < ledger.sources.length ? ledger.sources[index] as number : ledger.original.length;
    const replacesTarget = left < to && right > from && deletions.some(deletion => deletion.position >= start && deletion.position <= index);
    const insertedInsideTarget = left === right && left > from && left < to;
    if (replacesTarget || insertedInsideTarget) for (let at = start; at < index; at++) selected.add(at);
  }
  return { ranges: contiguousRanges(Array.from(selected).sort((a, b) => a - b)), deletions };
}

function contiguousRanges(indices: number[]): Range[] {
  const ranges: Range[] = [];
  for (const index of indices) {
    const last = ranges.at(-1);
    if (last?.to === index) last.to++;
    else ranges.push({ from: index, to: index + 1 });
  }
  return ranges;
}
