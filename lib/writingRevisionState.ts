import { createLedger, ledgerParts, offsetAt, originalProjection, type Ledger } from './writingRevisionLedger.ts';
import { textPosition } from './writingRevisionDocument.ts';

export type WritingRevisionState = { schema_version: 1; ledger: Ledger };

/** Untrusted API/database input. Fail closed; never replace a corrupt ledger
 * with a new Diff (that would silently lose durable identities). */
export function parseWritingRevisionState(value: unknown, original: string, text: string): WritingRevisionState {
  const invalid = () => { throw new Error('修订状态版本或正文不一致，已停止加载；未覆盖已保存正文。'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const state = value as WritingRevisionState;
  const ledger = state.ledger;
  if (state.schema_version !== 1 || !ledger || ledger.original !== original || ledger.text !== text ||
    !Array.isArray(ledger.sources) || ledger.sources.length !== text.length || !Array.isArray(ledger.deletions)) return invalid();
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128;
  let previousOriginal = -1;
  const inventory: Array<{ at: number; source: number }> = [];
  for (let i = 0; i < ledger.sources.length; i++) {
    const source = ledger.sources[i];
    if (typeof source === 'number' ? !Number.isSafeInteger(source) || source < 0 || source >= original.length || text[i] !== original[source] : !validId(source)) return invalid();
    if (typeof source === 'number') {
      if (source <= previousOriginal) return invalid();
      previousOriginal = source; inventory.push({ at: i * 2 + 1, source });
    }
  }
  const ids = new Set<string>();
  for (const d of ledger.deletions) {
    if (!d || !validId(d.id) || ids.has(d.id) || !Array.isArray(d.sources) || !d.sources.length ||
      typeof d.text !== 'string' || d.text.length !== d.sources.length || !Number.isSafeInteger(d.position) ||
      d.position !== textPosition(text, offsetAt(text, d.position))) return invalid();
    ids.add(d.id);
    const at = offsetAt(text, d.position) * 2;
    inventory.push(...d.sources.map(source => ({ at, source })));
    if (d.sources.some((s, i) => !Number.isSafeInteger(s) || s < 0 || s >= original.length ||
      (i > 0 && s !== d.sources[i - 1] + 1) || d.text[i] !== original[s])) return invalid();
  }
  try {
    inventory.sort((a, b) => a.at - b.at || a.source - b.source);
    if (inventory.length !== original.length || inventory.some((entry, i) => entry.source !== i) || ledger.sources.some(s => typeof s === 'string' && ids.has(s))) return invalid();
    originalProjection(ledger);
    const parts = ledgerParts(ledger);
    if (parts.filter(p => p.kind !== 'added').map(p => p.text).join('') !== original ||
      parts.filter(p => p.kind !== 'deleted').map(p => p.text).join('') !== text) return invalid();
  } catch { return invalid(); }
  // Whitelist fields; do not persist arbitrary editor/AI/HTML objects.
  return { schema_version: 1, ledger: { original, text, sources: ledger.sources.slice(),
    deletions: ledger.deletions.map(d => ({ id: d.id, text: d.text, sources: d.sources.slice(), position: d.position })) } };
}

/** Legacy migration is a single exact Diff, not recovered operation history. */
export function initializeWritingRevision(original: string, text: string, value?: WritingRevisionState | null) {
  return value == null ? { schema_version: 1 as const, ledger: createLedger(original, text) } : parseWritingRevisionState(value, original, text);
}

/** Compare semantic fields, not the incidental JS property insertion order of
 * transaction-produced objects versus a validated JSON round trip. */
export function revisionStateKey(state: WritingRevisionState) {
  const l = state.ledger;
  return JSON.stringify([state.schema_version,l.original,l.text,l.sources,l.deletions.map(d => [d.id,d.text,d.sources,d.position])]);
}
