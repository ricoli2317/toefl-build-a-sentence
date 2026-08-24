type ExplanationChange = {
  original_text: string;
  replacement_text: string;
};

type SplitWorkingEdit = ExplanationChange & {
  edit_id: string;
  explanation: string;
  category: string;
  severity: string;
  source?: "ai" | "teacher";
};

export type SplitLanguageEditMetadata = {
  explanation: string;
  category: string;
  severity: string;
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

function inferSplitCategory(
  change: ExplanationChange,
  explanation: string,
  fallback: string
) {
  const reason = explanation.toLowerCase();
  const original = change.original_text;
  const replacement = change.replacement_text;
  const atomic =
    asciiTerms(original).length <= 1 && asciiTerms(replacement).length <= 1;
  // A whole-clause rewrite may mention several different error types. Its
  // provider category remains the only honest aggregate label; local category
  // inference is reserved for the independently isolated token changes.
  if (!atomic) return fallback;
  if (
    original.toLowerCase() === replacement.toLowerCase() &&
    original !== replacement
  ) {
    return "capitalization";
  }
  if (
    /所有格|复数|单数|词形|word form/.test(reason) ||
    (/['’]$/.test(replacement) && !/['’]$/.test(original))
  ) {
    return "word_form";
  }
  if (/标点|缩写|punctuation/.test(reason)) return "punctuation";
  if (/拼写|spelling|misspell/.test(reason)) return "spelling";
  if (/介词|搭配|用法|usage|collocation|preposition/.test(reason)) {
    return "usage";
  }
  if (/用词|措辞|而非|word choice/.test(reason)) return "word_choice";
  if (/时态|过去时|现在时|主谓|动名词|不定式|语法|grammar|tense/.test(reason)) {
    return "grammar";
  }
  return fallback;
}

function specificExplanation(
  change: ExplanationChange,
  explanation: string,
  category: string
) {
  const original = change.original_text;
  const replacement = change.replacement_text;
  const atomic =
    asciiTerms(original).length <= 1 && asciiTerms(replacement).length <= 1;
  if (!atomic) return explanation;
  if (category === "spelling") {
    return `${original} 拼写错误，应改为 ${replacement}。`;
  }
  if (category === "capitalization") {
    return `${original} 的大小写不正确，应改为 ${replacement}。`;
  }
  if (category === "punctuation") {
    return `${original} 的标点格式不规范，此处应写为 ${replacement}`;
  }
  if (category === "word_form") {
    if (/['’]$/.test(replacement) && !/['’]$/.test(original)) {
      return `${original} 此处应使用复数所有格形式 ${replacement}。`;
    }
    if (replacement === `${original}s`) {
      return `${original} 此处应使用复数形式 ${replacement}。`;
    }
  }
  return explanation;
}

export function languageEditMetadataForSplits(
  changes: ExplanationChange[],
  reason: string,
  fallbackCategory: string,
  fallbackSeverity: string
): SplitLanguageEditMetadata[] {
  const explanations = allocateLanguageEditExplanations(changes, reason);
  return changes.map((change, index) => {
    const category = inferSplitCategory(
      change,
      explanations[index],
      fallbackCategory
    );
    return {
      category,
      severity:
        category === "spelling" ||
        category === "capitalization" ||
        category === "punctuation"
          ? "minor"
          : fallbackSeverity,
      explanation: specificExplanation(change, explanations[index], category)
    };
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
    const allocated = explanations.size === 1
      ? languageEditMetadataForSplits(
          indexes.map((index) => edits[index]),
          edits[indexes[0]].explanation,
          edits[indexes[0]].category,
          edits[indexes[0]].severity
        )
      : indexes.map((index) =>
          languageEditMetadataForSplits(
            [edits[index]],
            edits[index].explanation,
            edits[index].category,
            edits[index].severity
          )[0]
        );
    indexes.forEach((editIndex, partIndex) => {
      result[editIndex].explanation = allocated[partIndex].explanation;
      result[editIndex].category = allocated[partIndex].category;
      result[editIndex].severity = allocated[partIndex].severity;
    });
  }
  return result;
}
