import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { Step, StepMap, StepResult, type Mappable } from '@tiptap/pm/transform';
import { writingCorrectionDiffSides } from './writingCorrectionDiff.ts';
import { exportDocument, textPosition } from './writingRevisionDocument.ts';

// Numbers are immutable baseline UTF-16 offsets; strings identify insertions.
export type Source = number | string;
export type Deletion = { id: string; text: string; sources: number[]; position: number };
export type Ledger = { original: string; text: string; sources: Source[]; deletions: Deletion[] };
export type TrackedPart = { kind: 'equal' | 'added' | 'deleted'; text: string; currentFrom: number; originalFrom: number; id?: string };
// Persistence adaptation only: a fresh session must never reuse a saved ID.
export const nextRevisionId = (kind: string) => `${kind}-${globalThis.crypto.randomUUID()}`;
export const transactionDiagnostics = { exactDiffCalls: 0, mappedTextSteps: 0 };

/** Inverse of the paragraph adapter, linear rather than scanning all prefixes. */
export function offsetAt(text: string, position: number) {
  let at = 1;
  for (let i = 0; i < text.length; i++) {
    if (at >= position) return i;
    at += text[i] === '\n' ? 2 : 1;
  }
  return text.length;
}

/** Only initial import may use Diff. No transaction calls this function. */
export function createLedger(original: string, current = original): Ledger {
  if (original === current) return { original, text: current, sources: Array.from({ length: current.length }, (_, i) => i), deletions: [] };
  transactionDiagnostics.exactDiffCalls++;
  const raw = writingCorrectionDiffSides(original, current);
  const left = raw.original.flatMap(p => p.text.split('').map(() => p.changed));
  const right = raw.current.flatMap(p => p.text.split('').map(() => p.added));
  const sources: Source[] = [], deletions: Deletion[] = [];
  let a = 0, b = 0;
  while (a < original.length || b < current.length) {
    const from = a;
    while (a < original.length && left[a]) a++;
    if (a > from) deletions.push({ id: nextRevisionId('delete'), text: original.slice(from, a),
      sources: Array.from({ length: a - from }, (_, i) => from + i), position: textPosition(current, b) });
    const id = nextRevisionId('insert');
    while (b < current.length && right[b]) { sources.push(id); b++; }
    if (a < original.length && b < current.length) {
      if (original[a] !== current[b]) throw Error('Canonical import matches disagree');
      sources.push(a++); b++;
    } else if (a < original.length && !left[a] || b < current.length && !right[b]) throw Error('Invalid import alignment');
  }
  return { original, text: current, sources, deletions };
}

/** Canonical provenance inventory, independent of visual widget order. */
export function originalProjection(ledger: Ledger) {
  const inventory = ledger.sources.filter((s): s is number => typeof s === 'number')
    .concat(ledger.deletions.flatMap(d => d.sources)).sort((a, b) => a - b);
  if (inventory.length !== ledger.original.length || inventory.some((v, i) => v !== i)) throw Error('Baseline provenance duplicated or lost');
  return inventory.map(i => ledger.original[i]).join('');
}

export function ledgerParts(ledger: Ledger): TrackedPart[] {
  const parts: TrackedPart[] = [];
  const ghosts = ledger.deletions.map(d => ({ ...d, offset: offsetAt(ledger.text, d.position) }))
    .sort((a, b) => a.offset - b.offset || a.sources[0] - b.sources[0]);
  let g = 0;
  for (let i = 0; i <= ledger.text.length;) {
    while (g < ghosts.length && ghosts[g].offset === i) {
      const d = ghosts[g++]; parts.push({ kind: 'deleted', text: d.text, currentFrom: i, originalFrom: d.sources[0], id: d.id });
    }
    if (i === ledger.text.length) break;
    const added = typeof ledger.sources[i] === 'string';
    let end = i + 1;
    while (end < ledger.text.length && (typeof ledger.sources[end] === 'string') === added && (!ghosts[g] || ghosts[g].offset !== end)) end++;
    parts.push({ kind: added ? 'added' : 'equal', text: ledger.text.slice(i, end), currentFrom: i,
      originalFrom: typeof ledger.sources[i] === 'number' ? ledger.sources[i] as number : -1 });
    i = end;
  }
  return parts;
}

/** StepMap positions at paragraph joins can share a collapsed gap. Keep their
 * provenance order, constrained by surviving original neighbours. This uses
 * stable source identities, NOT text matching, word expansion or old offsets.
 */
function orderedMappedAnchors(text: string, sources: Source[], deletions: Deletion[]) {
  const live = sources.flatMap((source, offset) => typeof source === 'number' ? [{ source, offset }] : []);
  if (live.some((entry, i) => i > 0 && entry.source <= live[i - 1].source)) throw Error('Original source order changed');
  let cursor = 0, lower = 0, previous = 0;
  const positions = new Map<string, number>();
  for (const deletion of deletions.slice().sort((a, b) => a.sources[0] - b.sources[0])) {
    while (cursor < live.length && live[cursor].source < deletion.sources[0]) lower = live[cursor++].offset + 1;
    const upper = live[cursor]?.offset ?? text.length;
    const offset = Math.max(lower, previous, Math.min(offsetAt(text, deletion.position), upper));
    if (offset > upper) throw Error('Deleted source order cannot be mapped into this document');
    positions.set(deletion.id, textPosition(text, offset)); previous = offset;
  }
  return deletions.map(deletion => ({ ...deletion, position: positions.get(deletion.id)! }));
}

/** Apply the actual replace/split/join maps. No text matching or word expansion. */
export function trackTransaction(before: Ledger, transaction: Transaction): Ledger {
  let ledger = before;
  const restoreId = transaction.getMeta('pocRestoreDeletion') as string | undefined;
  const restoring = before.deletions.find(d => d.id === restoreId);
  for (let index = 0; index < transaction.steps.length; index++) {
    if (transaction.steps[index] instanceof RevisionLedgerStep) continue;
    const oldDoc = transaction.docs[index];
    const newDoc = index + 1 < transaction.docs.length ? transaction.docs[index + 1] : transaction.doc;
    const oldText = exportDocument(oldDoc), text = exportDocument(newDoc);
    if (ledger.text !== oldText) throw Error('Transaction ledger/document coordinates disagree');
    const map = transaction.mapping.maps[index];
    const ranges: Array<{ from: number; to: number; newFrom: number; newTo: number }> = [];
    map.forEach((a, b, c, d) => ranges.push({ from: offsetAt(oldText, a), to: offsetAt(oldText, b), newFrom: offsetAt(text, c), newTo: offsetAt(text, d) }));
    if (!ranges.length) {
      if (oldText !== text) throw Error('Text changed without a position map');
      continue;
    }
    transactionDiagnostics.mappedTextSteps++;
    const sources = ledger.sources.slice();
    let reconstructed = oldText;
    const deletions = ledger.deletions.filter(d => d.id !== restoreId).map(d => {
      const sameAnchor = restoring && d.position === restoring.position;
      const association = sameAnchor && d.sources[0] > restoring.sources[0] ? 1 : -1;
      const position = map.map(d.position, association);
      return { ...d, position: textPosition(text, offsetAt(text, position)) };
    });
    for (const range of ranges.slice().reverse()) {
      const inserted = text.slice(range.newFrom, range.newTo);
      reconstructed = reconstructed.slice(0, range.from) + inserted + reconstructed.slice(range.to);
      if (!restoring) {
        let run: { text: string; sources: number[] } | null = null;
        const flush = () => {
          if (run) deletions.push({ ...run, id: nextRevisionId('delete'), position: textPosition(text, range.newFrom) });
          run = null;
        };
        for (let at = range.from; at < range.to; at++) {
          const source = ledger.sources[at];
          if (typeof source !== 'number') continue; // Newly inserted text never becomes an original deletion.
          if (run && source !== run.sources.at(-1)! + 1) flush();
          if (!run) run = { text: '', sources: [] };
          run.text += oldText[at]; run.sources.push(source);
        }
        flush();
      }
      const id = nextRevisionId('insert');
      const insertedSources: Source[] = restoring ? restoring.sources.slice() : Array.from({ length: inserted.length }, () => id);
      if (restoring && inserted !== restoring.text) throw Error('Restore is not the requested original payload');
      sources.splice(range.from, range.to - range.from, ...insertedSources);
    }
    if (reconstructed !== text || sources.length !== text.length) throw Error('Unsupported structural map: refusing to infer edit semantics with Diff');
    ledger = { original: before.original, text, sources, deletions: orderedMappedAnchors(text, sources, deletions) };
  }
  return ledger;
}

/** Empty document map, real history step: snapshots travel WITH local text undo.
 * These are local complete-history snapshots, not collaborative rebase patches.
 * The actual text Steps reverse in the same event; do not re-map snapshots onto
 * an intermediate undo document. Live anchors are mapped by trackTransaction.
 */
export class RevisionLedgerStep extends Step {
  readonly before: Ledger;
  readonly after: Ledger;
  constructor(before: Ledger, after: Ledger) { super(); this.before = before; this.after = after; }
  apply(doc: PMNode) { return StepResult.ok(doc); }
  invert() { return new RevisionLedgerStep(this.after, this.before); }
  map(_mapping: Mappable) { return this; }
  getMap() { return StepMap.empty; }
  toJSON() { return { stepType: 'pocRevisionLedger', before: this.before, after: this.after }; }
  static fromJSON(_schema: unknown, json: { before: Ledger; after: Ledger }) { return new RevisionLedgerStep(json.before, json.after); }
}
Step.jsonID('pocRevisionLedger', RevisionLedgerStep);
