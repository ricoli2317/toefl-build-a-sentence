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

function plausibleSpellingChange(change: ExplanationChange) {
  const original = change.original_text.trim();
  const replacement = change.replacement_text.trim();
  if (!/^[A-Za-z]+$/.test(original) || !/^[A-Za-z]+$/.test(replacement)) {
    return false;
  }
  const left = original.toLowerCase();
  const right = replacement.toLowerCase();
  const rows = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
    let diagonal = rows[0];
    rows[0] = rightIndex;
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const previous = rows[leftIndex];
      rows[leftIndex] = Math.min(
        rows[leftIndex] + 1,
        rows[leftIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      diagonal = previous;
    }
  }
  return rows[left.length] <= Math.max(2, Math.floor(Math.max(left.length, right.length) / 3));
}

function explicitNonSpellingCategory(reason: string) {
  const value = reason.toLowerCase();
  if (/所有格|复数|单数|词形|word form/.test(value)) return "word_form";
  if (/标点|缩写|punctuation/.test(value)) return "punctuation";
  if (/介词|搭配|用法|固定表达|usage|collocation|preposition/.test(value)) {
    return "usage";
  }
  if (/用词|措辞|而非|word choice/.test(value)) return "word_choice";
  if (/句法|语序|从句|syntax/.test(value)) return "syntax";
  if (/时态|过去时|现在时|主谓|动名词|不定式|冠词|可数名词|语法|grammar|tense/.test(value)) {
    return "grammar";
  }
  return "other";
}

function coherentCategory(
  change: ExplanationChange,
  explanation: string,
  category: string
) {
  if (category !== "spelling" || plausibleSpellingChange(change)) {
    return category;
  }
  // A spelling label is impossible when the replacement changes the word or
  // construction rather than correcting the same intended word. Prefer an
  // explicitly named non-spelling diagnosis; otherwise use the honest
  // catch-all instead of fabricating a precise category.
  return explicitNonSpellingCategory(explanation);
}

/**
 * Match every explanation clause to exactly one changed range. A split is
 * safe only when all clauses and all ranges participate. This prevents a
 * deterministic text diff from inventing semantic ownership that the model
 * did not make explicit.
 */
function uniquelyAllocatedExplanations(
  changes: ExplanationChange[],
  reason: string
) {
  if (changes.length < 2) return changes.map(() => reason);
  const clauses = reasonClauses(reason);
  if (clauses.length < 2) return null;

  const allocated = changes.map(() => [] as string[]);
  for (const clause of clauses) {
    const scored = changes
      .map((change, index) => ({ index, score: clauseScore(clause, change) }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const best = scored[0];
    if (!best || best.score <= 0 || best.score === scored[1]?.score) return null;
    allocated[best.index].push(clause);
  }
  if (allocated.some((clausesForChange) => clausesForChange.length === 0)) {
    return null;
  }
  return allocated.map((clausesForChange) =>
    clausesForChange.map(finishClause).join("")
  );
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
  return uniquelyAllocatedExplanations(changes, reason) ?? changes.map(() => reason);
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
): SplitLanguageEditMetadata[] | null {
  if (changes.length === 1) {
    const category = coherentCategory(
      changes[0],
      reason,
      fallbackCategory
    );
    return [{
      explanation: specificExplanation(changes[0], reason, category),
      category,
      severity:
        category === "spelling" ||
        category === "capitalization" ||
        category === "punctuation"
          ? "minor"
          : fallbackSeverity
    }];
  }
  const explanations = uniquelyAllocatedExplanations(changes, reason);
  if (!explanations) return null;
  const metadata = changes.map((change, index) => {
    const inferredCategory = inferSplitCategory(
      change,
      explanations[index],
      fallbackCategory
    );
    const category = coherentCategory(
      change,
      explanations[index],
      inferredCategory
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
  if (
    metadata.some(
      (item, index) =>
        item.category === "other" &&
        inferSplitCategory(changes[index], explanations[index], fallbackCategory) ===
          "spelling"
    )
  ) {
    return null;
  }
  return metadata;
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
    let allocated = explanations.size === 1
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
          )?.[0] ?? null
        );
    if (!allocated && explanations.size === 1) {
      const atomicFallback = indexes.map((index) => {
        const edit = edits[index];
        if (
          asciiTerms(edit.original_text).length > 1 ||
          asciiTerms(edit.replacement_text).length > 1
        ) {
          return null;
        }
        const metadata = languageEditMetadataForSplits(
          [edit],
          edit.explanation,
          edit.category,
          edit.severity
        )?.[0] ?? null;
        if (
          metadata &&
          edit.category === "spelling" &&
          metadata.category === "usage" &&
          /介词|preposition/i.test(edit.explanation)
        ) {
          metadata.explanation = `${edit.original_text} 此处介词用法不正确，应改为 ${edit.replacement_text}。`;
        }
        return metadata;
      });
      if (!atomicFallback.some((item) => item === null)) allocated = atomicFallback;
    }
    if (!allocated || allocated.some((item) => item === null)) continue;
    indexes.forEach((editIndex, partIndex) => {
      const metadata = allocated[partIndex]!;
      result[editIndex].explanation = metadata.explanation;
      result[editIndex].category = metadata.category;
      result[editIndex].severity = metadata.severity;
    });
  }
  return result;
}
