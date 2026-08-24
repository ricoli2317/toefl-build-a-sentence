import type { WritingTaskType } from "./writing.ts";
import {
  ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2,
  ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS,
  buildWorkingScoresV2,
  EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2,
  EMAIL_DIMENSION_SCORE_KEYS,
  type InternalLanguageEditV2
} from "./writingReviewSchemaV2.ts";
import {
  parseAIReviewRawResultV22,
  type AIReviewRawResultV22,
  type AIReviewResultV22
} from "./writingReviewSchemaV22.ts";
import {
  actualChangedCore,
  normalizeLanguageEditOverlaps,
  type LanguageEditOverlapNormalizationDiagnostic
} from "./writingReviewLanguageEditNormalization.ts";
import { languageEditMetadataForSplits } from "./writingReviewLanguageEditExplanation.ts";
import type { WritingReviewSemanticC3 } from "./writingReviewSemanticSchema.ts";
import { findReadableExactTextOccurrences } from "./writingReviewTextMatch.ts";
import type { WritingReviewTextUnit } from "./writingReviewTextUnits.ts";

const codeError = (message: string) =>
  Object.assign(new Error(message), { code: "C3_ASSEMBLY_INVALID" });

const uniqueTexts = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

type LocalizedRevision = {
  start: number;
  end: number;
  originalText: string;
  replacementText: string;
};

function revisionCandidates(
  unit: WritingReviewTextUnit,
  revision: WritingReviewSemanticC3["unit_revisions"][number]
): LocalizedRevision[] {
  const unitOccurrences = findReadableExactTextOccurrences(
    unit.text,
    revision.original_text
  );
  const relativeStart = unitOccurrences[0] ?? -1;
  if (unitOccurrences.length !== 1) {
    throw codeError("C3 revision source is not unique inside its unit.");
  }
  const relativeEnd = relativeStart + revision.original_text.length;
  const direct = {
    start: unit.startOffset + relativeStart,
    end: unit.startOffset + relativeEnd,
    originalText: revision.original_text,
    replacementText: revision.replacement_text
  };
  return [direct];
}

function rangesOverlap(left: LocalizedRevision, right: LocalizedRevision) {
  return left.start < right.end && left.end > right.start;
}

function localizeRevisions(
  source: string,
  units: Map<string, WritingReviewTextUnit>,
  revisions: WritingReviewSemanticC3["unit_revisions"]
) {
  const choices = revisions.map((revision) => {
    const unit = units.get(revision.unit_id);
    if (!unit) throw codeError("C3 revision references an unknown unit.");
    return revisionCandidates(unit, revision);
  });
  const selected: LocalizedRevision[] = [];

  function choose(index: number): boolean {
    if (index === choices.length) return true;
    for (const candidate of choices[index]) {
      if (selected.some((range) => rangesOverlap(range, candidate))) continue;
      selected.push(candidate);
      if (choose(index + 1)) return true;
      selected.pop();
    }
    return false;
  }

  if (choose(0)) return selected;

  // Model-selected corrections may overlap even though every individual span
  // is valid. Choose the least-overlapping localization for each correction;
  // the shared deterministic normalizer below will then merge compatible
  // changes or keep one safe correction when they genuinely conflict.
  return choices.reduce<LocalizedRevision[]>((localized, candidates) => {
    const best = [...candidates].sort((left, right) => {
      const leftOverlap = localized.filter((item) => rangesOverlap(item, left));
      const rightOverlap = localized.filter((item) => rangesOverlap(item, right));
      const leftOverlapWidth = leftOverlap.reduce(
        (total, item) =>
          total + Math.max(0, Math.min(item.end, left.end) - Math.max(item.start, left.start)),
        0
      );
      const rightOverlapWidth = rightOverlap.reduce(
        (total, item) =>
          total + Math.max(0, Math.min(item.end, right.end) - Math.max(item.start, right.start)),
        0
      );
      return (
        leftOverlap.length - rightOverlap.length ||
        leftOverlapWidth - rightOverlapWidth ||
        left.end - left.start - (right.end - right.start) ||
        left.start - right.start
      );
    })[0];
    if (!best) throw codeError("C3 revision has no localization candidate.");
    localized.push(best);
    return localized;
  }, []);
}

type TokenRange = { start: number; end: number };

function wordTokenRanges(value: string): TokenRange[] {
  return Array.from(
    value.matchAll(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g)
  ).map((match) => ({
    start: match.index,
    end: match.index + match[0].length
  }));
}

function tokenGroupsContainingChange(
  tokens: TokenRange[],
  changeStart: number,
  changeEnd: number
) {
  if (changeStart === changeEnd) {
    const containing = tokens
      .map((token, index) => ({ token, index }))
      .filter(({ token }) => token.start < changeStart && token.end > changeStart)
      .map(({ index }) => [index, index] as const);
    if (containing.length > 0) return containing;
    return tokens
      .map((token, index) => ({ token, index }))
      .filter(
        ({ token }) => token.end === changeStart || token.start === changeStart
      )
      .map(({ index }) => [index, index] as const);
  }

  const intersecting = tokens
    .map((token, index) => ({ token, index }))
    .filter(
      ({ token }) => token.start < changeEnd && token.end > changeStart
    )
    .map(({ index }) => index);
  if (intersecting.length === 0) return [];
  return [[intersecting[0], intersecting.at(-1)!] as const];
}

/**
 * Model revisions often carry extra neighboring words so their source text is
 * readable and unique. Those context words can make two independent fixes look
 * overlapping even when the characters they actually change do not conflict.
 * Reduce each C3 revision to the smallest unique whole-token carrier first so
 * every independent correction keeps its own category, severity and reason.
 */
function minimizeLocalizedLanguageEdit(
  edit: InternalLanguageEditV2
): InternalLanguageEditV2 {
  const change = actualChangedCore(edit);
  if (!change) return edit;
  const relativeChangeStart = change.sourceStart - edit.start;
  const relativeChangeEnd = change.sourceEnd - edit.start;
  const tokens = wordTokenRanges(edit.original_text);
  const requiredGroups = tokenGroupsContainingChange(
    tokens,
    relativeChangeStart,
    relativeChangeEnd
  );
  if (requiredGroups.length === 0) return edit;

  const candidates: InternalLanguageEditV2[] = [];
  for (const [firstRequired, lastRequired] of requiredGroups) {
    for (
      let tokenWidth = lastRequired - firstRequired + 1;
      tokenWidth <= tokens.length;
      tokenWidth += 1
    ) {
      const firstLeft = Math.max(0, lastRequired - tokenWidth + 1);
      const lastLeft = Math.min(firstRequired, tokens.length - tokenWidth);
      for (let leftToken = firstLeft; leftToken <= lastLeft; leftToken += 1) {
        const rightToken = leftToken + tokenWidth - 1;
        const left = tokens[leftToken].start;
        const right = tokens[rightToken].end;
        if (left > relativeChangeStart || right < relativeChangeEnd) continue;
        const originalText = edit.original_text.slice(left, right);
        const replacementText =
          edit.original_text.slice(left, relativeChangeStart) +
          change.replacement +
          edit.original_text.slice(relativeChangeEnd, right);
        if (originalText === replacementText) continue;
        candidates.push({
          ...edit,
          start: edit.start + left,
          end: edit.start + right,
          original_text: originalText,
          replacement_text: replacementText
        });
      }
      if (candidates.length > 0) break;
    }
  }

  return (
    candidates.sort(
      (left, right) =>
        left.end - left.start - (right.end - right.start) ||
        left.start - right.start ||
        left.original_text.localeCompare(right.original_text)
    )[0] ?? edit
  );
}

type IndexedToken = {
  value: string;
  start: number;
  end: number;
};

function indexedTokens(value: string): IndexedToken[] {
  return Array.from(value.matchAll(/\S+/g)).map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length
  }));
}

function hasStableTokenOrderInversion(
  original: IndexedToken[],
  replacement: IndexedToken[]
) {
  const originalPositions = new Map<string, number[]>();
  const replacementPositions = new Map<string, number[]>();
  original.forEach((token, index) => {
    const key = token.value.toLowerCase();
    originalPositions.set(key, [...(originalPositions.get(key) ?? []), index]);
  });
  replacement.forEach((token, index) => {
    const key = token.value.toLowerCase();
    replacementPositions.set(key, [...(replacementPositions.get(key) ?? []), index]);
  });
  const stableReplacementOrder = original.flatMap((token) => {
    const key = token.value.toLowerCase();
    const left = originalPositions.get(key) ?? [];
    const right = replacementPositions.get(key) ?? [];
    return left.length === 1 && right.length === 1 ? right : [];
  });
  return stableReplacementOrder.some(
    (position, index) => index > 0 && position < stableReplacementOrder[index - 1]
  );
}

function lcsTokenMatches(original: IndexedToken[], replacement: IndexedToken[]) {
  const rows = original.length + 1;
  const columns = replacement.length + 1;
  const lengths = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => 0)
  );
  for (let left = original.length - 1; left >= 0; left -= 1) {
    for (let right = replacement.length - 1; right >= 0; right -= 1) {
      lengths[left][right] =
        original[left].value === replacement[right].value
          ? 1 + lengths[left + 1][right + 1]
          : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }
  const matches: Array<{ original: number; replacement: number }> = [];
  let left = 0;
  let right = 0;
  while (left < original.length && right < replacement.length) {
    if (original[left].value === replacement[right].value) {
      matches.push({ original: left, replacement: right });
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return matches;
}

function splitIndependentTokenChanges(
  edit: InternalLanguageEditV2
): InternalLanguageEditV2[] {
  const originalTokens = indexedTokens(edit.original_text);
  const replacementTokens = indexedTokens(edit.replacement_text);
  if (
    originalTokens.length < 2 ||
    replacementTokens.length === 0 ||
    hasStableTokenOrderInversion(originalTokens, replacementTokens)
  ) {
    return [edit];
  }

  const matches = [
    { original: -1, replacement: -1 },
    ...lcsTokenMatches(originalTokens, replacementTokens),
    { original: originalTokens.length, replacement: replacementTokens.length }
  ];
  const changes: Array<{
    start: number;
    end: number;
    original_text: string;
    replacement_text: string;
  }> = [];
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1];
    const next = matches[index];
    const originalGap = originalTokens.slice(previous.original + 1, next.original);
    const replacementGap = replacementTokens.slice(
      previous.replacement + 1,
      next.replacement
    );
    if (originalGap.length === 0 && replacementGap.length === 0) continue;
    // A pure insertion has no non-empty source span of its own. Keep the
    // model's readable revision intact so the existing insertion fallback can
    // localize it safely.
    if (originalGap.length === 0) return [edit];

    if (originalGap.length === replacementGap.length && originalGap.length > 1) {
      originalGap.forEach((original, pairIndex) => {
        const replacement = replacementGap[pairIndex];
        if (original.value === replacement.value) return;
        changes.push({
          start: original.start,
          end: original.end,
          original_text: original.value,
          replacement_text: replacement.value
        });
      });
      continue;
    }

    const originalStart = originalGap[0].start;
    const originalEnd = originalGap[originalGap.length - 1].end;
    changes.push({
      start: originalStart,
      end: originalEnd,
      original_text: edit.original_text.slice(originalStart, originalEnd),
      replacement_text:
        replacementGap.length === 0
          ? ""
          : edit.replacement_text.slice(
              replacementGap[0].start,
              replacementGap[replacementGap.length - 1].end
            )
    });
  }
  if (changes.length < 2) return [edit];

  const reconstructed = [...changes]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (value, change) =>
        value.slice(0, change.start) +
        change.replacement_text +
        value.slice(change.end),
      edit.original_text
    );
  if (reconstructed !== edit.replacement_text) return [edit];

  const metadata = languageEditMetadataForSplits(
    changes,
    edit.explanation,
    edit.category,
    edit.severity
  );

  return changes.map((change, index) => ({
    ...edit,
    edit_id: `${edit.edit_id}-part-${String(index + 1).padStart(2, "0")}`,
    start: edit.start + change.start,
    end: edit.start + change.end,
    original_text: change.original_text,
    replacement_text: change.replacement_text,
    category: metadata[index].category as InternalLanguageEditV2["category"],
    severity: metadata[index].severity as InternalLanguageEditV2["severity"],
    explanation: metadata[index].explanation
  }));
}

function trimSharedBoundaryPunctuation(
  edit: InternalLanguageEditV2
): InternalLanguageEditV2 {
  let leading = 0;
  while (
    leading < edit.original_text.length - 1 &&
    leading < edit.replacement_text.length - 1 &&
    edit.original_text[leading] === edit.replacement_text[leading] &&
    /[^A-Za-z0-9]/.test(edit.original_text[leading])
  ) {
    leading += 1;
  }
  let trailing = 0;
  while (
    trailing < edit.original_text.length - leading - 1 &&
    trailing < edit.replacement_text.length - leading - 1 &&
    edit.original_text[edit.original_text.length - trailing - 1] ===
      edit.replacement_text[edit.replacement_text.length - trailing - 1] &&
    /[^A-Za-z0-9]/.test(
      edit.original_text[edit.original_text.length - trailing - 1]
    )
  ) {
    trailing += 1;
  }
  if (leading === 0 && trailing === 0) return edit;
  const originalEnd = edit.original_text.length - trailing;
  const replacementEnd = edit.replacement_text.length - trailing;
  return {
    ...edit,
    start: edit.start + leading,
    end: edit.end - trailing,
    original_text: edit.original_text.slice(leading, originalEnd),
    replacement_text: edit.replacement_text.slice(leading, replacementEnd)
  };
}

function finalizeSplitLanguageEdit(edit: InternalLanguageEditV2) {
  const localized = trimSharedBoundaryPunctuation(
    minimizeLocalizedLanguageEdit(edit)
  );
  const metadata = languageEditMetadataForSplits(
    [localized],
    localized.explanation,
    localized.category,
    localized.severity
  )[0];
  return {
    ...localized,
    category: metadata.category as InternalLanguageEditV2["category"],
    severity: metadata.severity as InternalLanguageEditV2["severity"],
    explanation: metadata.explanation
  };
}

/**
 * Deterministically repair a C3 semantic revision into independent UI edits.
 * Stable token order is required; sentence rewrites with reordered anchors are
 * deliberately kept whole so their meaning is not guessed apart locally.
 */
export function normalizeC3LanguageEditParts(edit: InternalLanguageEditV2) {
  return splitIndependentTokenChanges(edit).map(finalizeSplitLanguageEdit);
}

function deduplicateC3ExactCorrections(edits: InternalLanguageEditV2[]) {
  const byCorrection = new Map<string, InternalLanguageEditV2>();
  for (const edit of edits) {
    const key = [
      edit.start,
      edit.end,
      edit.original_text,
      edit.replacement_text
    ].join("\u0000");
    const existing = byCorrection.get(key);
    if (!existing || (existing.edit_id.includes("-part-") && !edit.edit_id.includes("-part-"))) {
      byCorrection.set(key, edit);
    }
  }
  return Array.from(byCorrection.values());
}

export function normalizeC3ContentFeedback(input: WritingReviewSemanticC3) {
  const overall = [input.overall_feedback];
  const localized: WritingReviewSemanticC3["content_feedback"] = [];
  const groups = new Map<
    string,
    WritingReviewSemanticC3["content_feedback"]
  >();

  for (const feedback of input.content_feedback) {
    if (feedback.unit_id === null) {
      overall.push(...uniqueTexts([feedback.issue, feedback.suggestion]));
      continue;
    }
    const group = groups.get(feedback.unit_id) ?? [];
    group.push(feedback);
    groups.set(feedback.unit_id, group);
  }

  for (const group of Array.from(groups.values())) {
    const primary = group[0];
    const issue = uniqueTexts(group.map((item) => item.issue)).join(" ");
    const suggestion = uniqueTexts(group.map((item) => item.suggestion)).join(
      " "
    );
    const proposedRevision = group
      .map((item) => item.proposed_revision?.trim())
      .find(Boolean);
    if (!proposedRevision) {
      throw codeError("C3 feedback group has no safe proposed revision.");
    }
    localized.push({
      ...primary,
      issue,
      suggestion,
      proposed_revision: proposedRevision
    });
  }

  return {
    content_feedback: localized,
    overall_feedback: uniqueTexts(overall).join("\n")
  };
}

export function assembleWritingReviewV22FromC3(input: {
  taskType: WritingTaskType;
  responseText: string;
  units: WritingReviewTextUnit[];
  semantic: WritingReviewSemanticC3;
  onLanguageEditOverlapNormalization?: (
    diagnostic: LanguageEditOverlapNormalizationDiagnostic
  ) => void;
}): AIReviewResultV22 {
  const dimensions =
    input.taskType === "email"
      ? EMAIL_DIMENSION_SCORE_KEYS
      : ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS;
  const categories =
    input.taskType === "email"
      ? EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2
      : ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2;
  const units = new Map(input.units.map((unit) => [unit.unitId, unit]));
  const localizedRevisions = localizeRevisions(
    input.responseText,
    units,
    input.semantic.unit_revisions
  );
  const localizedLanguageEdits = input.semantic.unit_revisions.flatMap(
    (revision, index) => normalizeC3LanguageEditParts({
      edit_id: `c3-edit-${String(index + 1).padStart(2, "0")}`,
      start: localizedRevisions[index].start,
      end: localizedRevisions[index].end,
      original_text: localizedRevisions[index].originalText,
      replacement_text: localizedRevisions[index].replacementText,
      category: revision.issue_type,
      severity: revision.severity,
      explanation: revision.reason,
      restored: false
    })
  );
  const normalizedLanguageEdits = normalizeLanguageEditOverlaps(
    input.responseText,
    deduplicateC3ExactCorrections(localizedLanguageEdits)
  );
  if (normalizedLanguageEdits.diagnostic) {
    input.onLanguageEditOverlapNormalization?.(
      normalizedLanguageEdits.diagnostic
    );
  }
  const languageEdits = normalizedLanguageEdits.edits.map(
    ({ start: _start, end: _end, restored: _restored, ...edit }) => edit
  );
  const normalized = normalizeC3ContentFeedback(input.semantic);
  const locatedContentFeedback = normalized.content_feedback.map(
    (feedback, index) => {
      if (!categories.includes(feedback.category as never)) {
        throw codeError("C3 feedback category is invalid.");
      }
      const unit = units.get(feedback.unit_id!);
      if (!unit) throw codeError("C3 feedback has no safe unit.");
      return {
        feedback_id: `c3-feedback-${String(index + 1).padStart(2, "0")}`,
        category: feedback.category,
        original_sentence: unit.text,
        issue: feedback.issue,
        suggestion: feedback.suggestion,
        proposed_revision: feedback.proposed_revision!,
        start: unit.startOffset,
        end: unit.endOffset,
        included: true
      };
    }
  );
  const raw = {
    schema_version: "2.2" as const,
    task_type: input.taskType,
    language_edits: languageEdits,
    scores: {
      official_score: {
        ai_score: input.semantic.official_score,
        rationale: input.semantic.score_reason
      },
      dimension_scores: Object.fromEntries(
        dimensions.map((key) => {
          const value = input.semantic.dimension_scores[key];
          if (!value) throw codeError(`C3 missing dimension ${key}.`);
          return [key, { ai_score: value.score, ai_basis: value.basis }];
        })
      )
    },
    content_feedback: locatedContentFeedback.map(
      ({ start: _start, end: _end, included: _included, ...feedback }) =>
        feedback
    ),
    overall_feedback: normalized.overall_feedback
  };

  try {
    const validatedRaw = parseAIReviewRawResultV22(raw);
    return {
      ...validatedRaw,
      language_edits: normalizedLanguageEdits.edits,
      scores: buildWorkingScoresV2(validatedRaw.scores),
      content_feedback: locatedContentFeedback
    } as AIReviewResultV22;
  } catch (cause) {
    throw Object.assign(
      codeError("C3 assembly failed final v2.2/localization validation."),
      { cause }
    );
  }
}

export function writingReviewRawV22FromAssembled(
  review: AIReviewResultV22
): AIReviewRawResultV22 {
  return {
    schema_version: review.schema_version,
    task_type: review.task_type,
    language_edits: review.language_edits.map(
      ({
        edit_id,
        original_text,
        replacement_text,
        category,
        severity,
        explanation
      }) => ({
        edit_id,
        original_text,
        replacement_text,
        category,
        severity,
        explanation
      })
    ),
    scores: {
      official_score: {
        ai_score: review.scores.official_score.ai_score,
        rationale: review.scores.official_score.rationale
      },
      dimension_scores: Object.fromEntries(
        Object.entries(review.scores.dimension_scores).map(([key, value]) => [
          key,
          { ai_score: value.ai_score, ai_basis: value.ai_basis }
        ])
      ) as AIReviewRawResultV22["scores"]["dimension_scores"]
    },
    content_feedback: review.content_feedback.map(
      ({
        feedback_id,
        category,
        original_sentence,
        issue,
        suggestion,
        proposed_revision
      }) => ({
        feedback_id,
        category,
        original_sentence,
        issue,
        suggestion,
        proposed_revision
      })
    ),
    overall_feedback: review.overall_feedback
  };
}
