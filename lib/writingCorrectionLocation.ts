import type { Ledger } from "./writingRevisionLedger.ts";
import { offsetAt } from "./writingRevisionLedger.ts";

export type CorrectionLocation = { ranges: Array<{ from: number; to: number }>; deletions: Array<{ id: string; position: number }> };

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
  const ranges: CorrectionLocation["ranges"] = [];
  ledger.sources.forEach((source, index) => {
    if (typeof source !== "number" || source < from! || source >= to!) return;
    const last = ranges.at(-1);
    if (last?.to === index) last.to++;
    else ranges.push({ from: index, to: index + 1 });
  });
  const deletions = ledger.deletions.filter(deletion => deletion.sources.some(source => source >= from! && source < to!))
    .map(deletion => ({ id: deletion.id, position: offsetAt(ledger.text, deletion.position) }));
  return { ranges, deletions };
}
