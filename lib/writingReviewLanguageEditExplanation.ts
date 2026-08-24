type ExplanationChange = {
  original_text: string;
  replacement_text: string;
};

type SplitWorkingEdit = ExplanationChange & {
  edit_id: string;
  explanation: string;
  source?: "ai" | "teacher";
};

function reasonClauses(reason: string) {
  const sentences = reason.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [reason];
  return sentences
    .flatMap((sentence) => sentence.split(/[，,]\s*(?=(?:且|并且|同时|另外|此外))/))
    .map((clause) => clause.trim().replace(/^(?:且|并且|同时|另外|此外)\s*/, ""))
    .filter(Boolean);
}

function asciiTerms(value: string) {
  return Array.from(value.toLowerCase().matchAll(/[a-z0-9]+(?:[.'’-][a-z0-9]+)*/g))
    .map((match) => match[0])
    .filter(Boolean);
}

function containsTerm(value: string, term: string) {
  const haystack = value.toLowerCase();
  const needle = term.toLowerCase();
  if (!needle) return false;
  if (/^[a-z0-9]+$/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(
      haystack
    );
  }
  return haystack.includes(needle);
}

function clauseScore(clause: string, change: ExplanationChange) {
  const original = change.original_text.trim();
  const replacement = change.replacement_text.trim();
  let score = 0;
  if (containsTerm(clause, original)) score += 8;
  if (containsTerm(clause, replacement)) score += 10;
  for (const term of Array.from(new Set([
    ...asciiTerms(original),
    ...asciiTerms(replacement)
  ]))) {
    if (containsTerm(clause, term)) score += term.length > 2 ? 3 : 1;
  }
  return score;
}

function finishClause(value: string) {
  const trimmed = value.trim();
  return /[。！？!?；;]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

/**
 * A provider occasionally returns several aligned token corrections inside
 * one semantic revision even though the prompt asks for independent items.
 * When its Chinese reason already contains matching clauses, attach only the
 * uniquely matching clause to each deterministic token split. If a clause
 * cannot be matched safely, preserve the complete reason instead of guessing.
 */
export function allocateLanguageEditExplanations(
  changes: ExplanationChange[],
  reason: string
) {
  if (changes.length < 2) return changes.map(() => reason);
  const clauses = reasonClauses(reason);
  if (clauses.length < 2) return changes.map(() => reason);

  return changes.map((change) => {
    const scored = clauses
      .map((clause, index) => ({ clause, index, score: clauseScore(clause, change) }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const best = scored[0];
    if (!best || best.score <= 0 || best.score === scored[1]?.score) return reason;
    return finishClause(best.clause);
  });
}

/** Repair already-persisted `-part-NN` C3 edits without changing AI raw data. */
export function allocatePersistedSplitEditExplanations<
  T extends SplitWorkingEdit
>(edits: T[]): T[] {
  const groups = new Map<string, number[]>();
  edits.forEach((edit, index) => {
    if (edit.source === "teacher") return;
    const match = /^(.*)-part-\d+$/.exec(edit.edit_id);
    if (!match) return;
    const indexes = groups.get(match[1]) ?? [];
    indexes.push(index);
    groups.set(match[1], indexes);
  });

  const result = edits.map((edit) => ({ ...edit }));
  for (const indexes of Array.from(groups.values())) {
    if (indexes.length < 2) continue;
    const explanations = new Set(indexes.map((index) => edits[index].explanation));
    if (explanations.size !== 1) continue;
    const reason = edits[indexes[0]].explanation;
    const allocated = allocateLanguageEditExplanations(
      indexes.map((index) => edits[index]),
      reason
    );
    indexes.forEach((editIndex, partIndex) => {
      result[editIndex].explanation = allocated[partIndex];
    });
  }
  return result;
}
