import type { WritingTaskType } from "./writing.ts";
import {
  ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2,
  ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS,
  EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2,
  EMAIL_DIMENSION_SCORE_KEYS
} from "./writingReviewSchemaV2.ts";
import {
  parseAIReviewRawResultV22ForResponse,
  type AIReviewRawResultV22,
  type AIReviewResultV22
} from "./writingReviewSchemaV22.ts";
import {
  normalizeLanguageEditOverlaps,
  type LanguageEditOverlapNormalizationDiagnostic
} from "./writingReviewLanguageEditNormalization.ts";
import type { WritingReviewSemanticC3 } from "./writingReviewSemanticSchema.ts";
import { findReadableExactTextOccurrences } from "./writingReviewTextMatch.ts";
import type { WritingReviewTextUnit } from "./writingReviewTextUnits.ts";

const codeError = (message: string) =>
  Object.assign(new Error(message), { code: "C3_ASSEMBLY_INVALID" });

const uniqueTexts = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

function occurrenceCount(source: string, value: string) {
  let count = 0;
  for (
    let at = source.indexOf(value);
    at >= 0;
    at = source.indexOf(value, at + 1)
  ) {
    count += 1;
  }
  return count;
}

type LocalizedRevision = {
  start: number;
  end: number;
  originalText: string;
  replacementText: string;
};

function revisionCandidates(
  source: string,
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
  if (
    findReadableExactTextOccurrences(source, revision.original_text).length === 1
  ) {
    return [direct];
  }

  const tokens = Array.from(unit.text.matchAll(/\S+/g)).map((match) => ({
    start: match.index,
    end: match.index + match[0].length
  }));
  const firstToken = tokens.findIndex(
    (token) => token.start <= relativeStart && token.end > relativeStart
  );
  const lastToken = tokens.findLastIndex(
    (token) => token.start < relativeEnd && token.end >= relativeEnd
  );
  if (firstToken < 0 || lastToken < firstToken) {
    throw codeError("C3 revision has no readable localization range.");
  }

  const candidates: LocalizedRevision[] = [];
  for (
    let tokenWidth = lastToken - firstToken + 1;
    tokenWidth <= tokens.length;
    tokenWidth += 1
  ) {
    const firstLeft = Math.max(0, lastToken - tokenWidth + 1);
    const lastLeft = Math.min(firstToken, tokens.length - tokenWidth);
    for (let leftToken = firstLeft; leftToken <= lastLeft; leftToken += 1) {
      const rightToken = leftToken + tokenWidth - 1;
      const left = tokens[leftToken].start;
      const right = tokens[rightToken].end;
      const originalText = unit.text.slice(left, right);
      if (occurrenceCount(source, originalText) !== 1) continue;
      candidates.push({
        start: unit.startOffset + left,
        end: unit.startOffset + right,
        originalText,
        replacementText:
          unit.text.slice(left, relativeStart) +
          revision.replacement_text +
          unit.text.slice(relativeEnd, right)
      });
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) {
    throw codeError("C3 revision cannot be uniquely localized within its unit.");
  }
  return candidates;
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
    return revisionCandidates(source, unit, revision);
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
  const localizedLanguageEdits = input.semantic.unit_revisions.map(
    (revision, index) => ({
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
    localizedLanguageEdits
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
    content_feedback: normalized.content_feedback.map((feedback, index) => {
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
        proposed_revision: feedback.proposed_revision!
      };
    }),
    overall_feedback: normalized.overall_feedback
  };

  try {
    return parseAIReviewRawResultV22ForResponse(raw, input.responseText);
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
