import type {
  WorkingContentFeedbackItem,
  WorkingLanguageEdit
} from "./writingReviewWorkspace.ts";

export type ApplicableContentRevision = WorkingContentFeedbackItem & {
  start: number;
  end: number;
  original_sentence: string;
  proposed_revision: string;
};

export type WritingRevisionSegment =
  | { kind: "text"; start: number; end: number; originalText: string; revisedText: string }
  | {
      kind: "language_edit";
      start: number;
      end: number;
      originalText: string;
      revisedText: string;
      edit: WorkingLanguageEdit;
    }
  | {
      kind: "content_revision";
      start: number;
      end: number;
      originalText: string;
      revisedText: string;
      feedback: ApplicableContentRevision;
    };

export type ContentFeedbackAnnotationSegment = {
  kind: "content_feedback";
  start: number;
  end: number;
  feedback: WorkingContentFeedbackItem & {
    start: number;
    end: number;
    original_sentence: string;
  };
};

export type ContentFeedbackInlineSegment = {
  kind: "content_feedback_inline";
  changeKind: "insert" | "delete" | "replace";
  start: number;
  end: number;
  originalText: string;
  revisedText: string;
  feedback: ApplicableContentRevision;
};

export type WritingTrackedChangeSegment =
  | WritingRevisionSegment
  | ContentFeedbackAnnotationSegment
  | ContentFeedbackInlineSegment;

export type ContentFeedbackRevisionDiff =
  | {
      mode: "inline";
      parts: Array<
        | { kind: "equal"; originalText: string; revisedText: string }
        | {
            kind: "insert" | "delete" | "replace";
            originalText: string;
            revisedText: string;
          }
      >;
    }
  | { mode: "rewrite" };

export type ContentFeedbackMarkedDetail = {
  label: "建议改为" | "问题" | "建议";
  value: string;
};

export type WritingRevisionComposition = {
  activeContentRevisions: ApplicableContentRevision[];
  suppressedLanguageEditIds: Set<string>;
  activeLanguageEdits: WorkingLanguageEdit[];
  cleanFinalSegments: WritingRevisionSegment[];
  trackedChangeSegments: WritingTrackedChangeSegment[];
  workspaceSegments: WorkspaceRevisionSegment[];
  cleanText: string;
};

export type WorkspaceRevisionSegment =
  | Extract<WritingRevisionSegment, { kind: "text" | "language_edit" }>
  | {
      kind: "feedback_sentence";
      start: number;
      end: number;
      originalText: string;
      revisedText: string;
      feedback: ApplicableContentRevision;
      children: Array<Extract<WritingRevisionSegment, { kind: "text" | "language_edit" }>>;
    };

export function hasApplicableContentRevision(
  item: WorkingContentFeedbackItem
): item is ApplicableContentRevision {
  return (
    typeof (item as { start?: unknown }).start === "number" &&
    typeof (item as { end?: unknown }).end === "number" &&
    typeof (item as { original_sentence?: unknown }).original_sentence === "string" &&
    typeof (item as { proposed_revision?: unknown }).proposed_revision === "string" &&
    (item as { proposed_revision: string }).proposed_revision.trim().length > 0
  );
}

export function contentFeedbackMarkedDetails(
  item: WorkingContentFeedbackItem
): ContentFeedbackMarkedDetail[] {
  const proposedRevision =
    "proposed_revision" in item && typeof item.proposed_revision === "string"
      ? item.proposed_revision
      : "";
  if (proposedRevision.trim()) {
    return [{ label: "建议改为", value: proposedRevision }];
  }
  return [
    { label: "问题" as const, value: item.issue },
    { label: "建议" as const, value: item.suggestion }
  ].filter((detail) => detail.value.trim().length > 0);
}

/**
 * Pure display-only classification for Content Feedback revisions. Token LCS
 * keeps separated local edits as separate markers. Inline mode is chosen from
 * stable ordered word anchors and readable fragmentation, rather than raw
 * changed-character ratio; structurally unrelated rewrites still fall back to
 * the existing full-sentence annotation.
 */
export function contentFeedbackRevisionDiff(
  originalText: string,
  revisedText: string
): ContentFeedbackRevisionDiff {
  if (!originalText || !revisedText || originalText === revisedText) {
    return { mode: "rewrite" };
  }

  const originalTokens = tokenizeRevision(originalText);
  const revisedTokens = tokenizeRevision(revisedText);
  const matrix = buildLcsMatrix(originalTokens, revisedTokens);
  const rawParts: Array<{
    kind: "equal" | "removed" | "added";
    text: string;
  }> = [];
  let originalIndex = 0;
  let revisedIndex = 0;

  while (
    originalIndex < originalTokens.length ||
    revisedIndex < revisedTokens.length
  ) {
    if (
      originalIndex < originalTokens.length &&
      revisedIndex < revisedTokens.length &&
      originalTokens[originalIndex] === revisedTokens[revisedIndex]
    ) {
      pushRawDiffPart(rawParts, "equal", originalTokens[originalIndex]);
      originalIndex += 1;
      revisedIndex += 1;
      continue;
    }
    if (
      revisedIndex < revisedTokens.length &&
      (originalIndex >= originalTokens.length ||
        matrix[originalIndex][revisedIndex + 1] >
          matrix[originalIndex + 1][revisedIndex])
    ) {
      pushRawDiffPart(rawParts, "added", revisedTokens[revisedIndex]);
      revisedIndex += 1;
      continue;
    }
    pushRawDiffPart(rawParts, "removed", originalTokens[originalIndex]);
    originalIndex += 1;
  }

  const groupedParts: Array<{
    kind: "equal" | "change";
    originalText: string;
    revisedText: string;
  }> = [];
  for (const rawPart of rawParts) {
    if (rawPart.kind === "equal") {
      const previous = groupedParts.at(-1);
      if (previous?.kind === "equal") {
        previous.originalText += rawPart.text;
        previous.revisedText += rawPart.text;
      } else {
        groupedParts.push({
          kind: "equal",
          originalText: rawPart.text,
          revisedText: rawPart.text
        });
      }
      continue;
    }
    const previous = groupedParts.at(-1);
    const change = previous?.kind === "change"
      ? previous
      : { kind: "change" as const, originalText: "", revisedText: "" };
    if (previous !== change) groupedParts.push(change);
    if (rawPart.kind === "removed") change.originalText += rawPart.text;
    else change.revisedText += rawPart.text;
  }

  const compactedParts = mergeWhitespaceBridgedChanges(groupedParts);
  const parts: Extract<ContentFeedbackRevisionDiff, { mode: "inline" }>["parts"] =
    compactedParts.map((part) => {
      if (part.kind === "equal") {
        return {
          kind: "equal" as const,
          originalText: part.originalText,
          revisedText: part.revisedText
        };
      }
      return {
        kind: part.originalText
          ? part.revisedText
            ? "replace" as const
            : "delete" as const
          : "insert" as const,
        originalText: part.originalText,
        revisedText: part.revisedText
      };
    });
  const changes = parts.filter((part) => part.kind !== "equal");
  const equalParts = parts.filter((part) => part.kind === "equal");
  const originalWordCount = revisionWords(originalText).length;
  const revisedWordCount = revisionWords(revisedText).length;
  const totalWordCount = Math.max(1, originalWordCount, revisedWordCount);
  const anchoredWordCount = equalParts.reduce(
    (total, part) => total + revisionWords(part.originalText).length,
    0
  );
  const longestAnchorWordCount = equalParts.reduce(
    (longest, part) =>
      Math.max(longest, revisionWords(part.originalText).length),
    0
  );
  const anchorCoverage = anchoredWordCount / totalWordCount;
  const hasStableAnchors =
    anchoredWordCount >= 2 &&
    anchorCoverage >= 0.25 &&
    (longestAnchorWordCount >= 2 ||
      anchoredWordCount >= 4 ||
      anchorCoverage >= 0.55);
  const isSingleTokenReplacement =
    changes.length === 1 &&
    changes[0].kind === "replace" &&
    originalWordCount === 1 &&
    revisedWordCount === 1;
  const maxReadableChanges = Math.min(8, Math.max(4, anchoredWordCount));

  if (
    changes.length === 0 ||
    (!hasStableAnchors && !isSingleTokenReplacement) ||
    changes.length > maxReadableChanges ||
    hasSubstantialMovedBlock(changes)
  ) {
    return { mode: "rewrite" };
  }
  return { mode: "inline", parts };
}

/**
 * Builds every revised-essay mode from response_text's immutable coordinate
 * system. Included sentence revisions win over overlapping language edits, but
 * suppressed edits remain in the working draft and resume automatically when
 * that revision is excluded.
 */
export function buildWritingRevisionComposition(
  responseText: string,
  languageEdits: WorkingLanguageEdit[],
  contentFeedback: WorkingContentFeedbackItem[]
): WritingRevisionComposition {
  const revisions = contentFeedback
    .filter(hasApplicableContentRevision)
    .filter((item) => item.included)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  validateRevisions(responseText, revisions);
  const feedbackAnnotations = contentFeedback
    .filter((item) => item.included)
    .filter((item) => !hasApplicableContentRevision(item))
    .flatMap((item) => {
      if (
        contentFeedbackMarkedDetails(item).length === 0 ||
        !isLocatedFeedback(item)
      ) {
        return [];
      }
      validateFeedbackLocation(responseText, item);
      return [{
        kind: "content_feedback" as const,
        start: item.start,
        end: item.end,
        feedback: item
      }];
    })
    .sort((left, right) => left.end - right.end || left.start - right.start);

  const suppressedLanguageEditIds = new Set<string>();
  const activeLanguageEdits = languageEdits
    .filter((edit) => !edit.restored)
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .filter((edit) => {
      validateLanguageEdit(responseText, edit);
      const suppressed = revisions.some(
        (revision) => edit.start < revision.end && edit.end > revision.start
      );
      if (suppressed) suppressedLanguageEditIds.add(edit.edit_id);
      return !suppressed;
    });

  const operations = [
    ...revisions.map((revision) => ({
      start: revision.start,
      end: revision.end,
      kind: "content_revision" as const,
      revision
    })),
    ...activeLanguageEdits.map((edit) => ({
      start: edit.start,
      end: edit.end,
      kind: "language_edit" as const,
      edit
    }))
  ].sort((left, right) => left.start - right.start || left.end - right.end);

  const feedbackBoundaries = contentFeedback
    .filter(isLocatedFeedback)
    .flatMap((item) => [item.start, item.end]);

  const segments: WritingRevisionSegment[] = [];
  let cursor = 0;
  for (const operation of operations) {
    if (operation.start < cursor) {
      throw new Error("批改稿修改范围发生重叠。");
    }
    if (operation.start > cursor) {
      appendTextSegments(
        segments,
        responseText,
        cursor,
        operation.start,
        feedbackBoundaries
      );
    }
    if (operation.kind === "content_revision") {
      segments.push({
        kind: operation.kind,
        start: operation.start,
        end: operation.end,
        originalText: operation.revision.original_sentence,
        revisedText: operation.revision.proposed_revision,
        feedback: operation.revision
      });
    } else {
      segments.push({
        kind: operation.kind,
        start: operation.start,
        end: operation.end,
        originalText: operation.edit.original_text,
        revisedText: operation.edit.replacement_text,
        edit: operation.edit
      });
    }
    cursor = operation.end;
  }
  if (cursor < responseText.length) {
    appendTextSegments(
      segments,
      responseText,
      cursor,
      responseText.length,
      feedbackBoundaries
    );
  }

  return {
    activeContentRevisions: revisions,
    suppressedLanguageEditIds,
    activeLanguageEdits,
    cleanFinalSegments: segments,
    trackedChangeSegments: expandContentRevisionSegments(
      insertFeedbackAnnotations(segments, feedbackAnnotations)
    ),
    workspaceSegments: buildWorkspaceSegments(
      responseText,
      languageEdits,
      contentFeedback
    ),
    cleanText: segments.map((segment) => segment.revisedText).join("")
  };
}

function expandContentRevisionSegments(
  segments: WritingTrackedChangeSegment[]
): WritingTrackedChangeSegment[] {
  const result: WritingTrackedChangeSegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== "content_revision") {
      result.push(segment);
      continue;
    }
    const diff = contentFeedbackRevisionDiff(
      segment.originalText,
      segment.revisedText
    );
    if (diff.mode === "rewrite") {
      result.push(segment);
      continue;
    }

    let sourceCursor = segment.start;
    for (const part of diff.parts) {
      const start = sourceCursor;
      sourceCursor += part.originalText.length;
      if (part.kind === "equal") {
        result.push({
          kind: "text" as const,
          start,
          end: sourceCursor,
          originalText: part.originalText,
          revisedText: part.revisedText
        });
        continue;
      }
      result.push({
        kind: "content_feedback_inline" as const,
        changeKind: part.kind,
        start,
        end: sourceCursor,
        originalText: part.originalText,
        revisedText: part.revisedText,
        feedback: segment.feedback
      });
    }
  }
  return result;
}

function tokenizeRevision(value: string) {
  return value.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*|\s+|[^\sA-Za-z0-9]/g) ?? [];
}

function buildLcsMatrix(left: string[], right: string[]) {
  const matrix = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0)
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      matrix[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? matrix[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(
              matrix[leftIndex + 1][rightIndex],
              matrix[leftIndex][rightIndex + 1]
            );
    }
  }
  return matrix;
}

function pushRawDiffPart(
  parts: Array<{ kind: "equal" | "removed" | "added"; text: string }>,
  kind: "equal" | "removed" | "added",
  value: string
) {
  const previous = parts.at(-1);
  if (previous?.kind === kind) previous.text += value;
  else parts.push({ kind, text: value });
}

function mergeWhitespaceBridgedChanges(
  parts: Array<{
    kind: "equal" | "change";
    originalText: string;
    revisedText: string;
  }>
) {
  const compacted: typeof parts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const previous = compacted.at(-1);
    const next = parts[index + 1];
    if (
      part.kind === "equal" &&
      part.originalText.trim().length === 0 &&
      previous?.kind === "change" &&
      next?.kind === "change"
    ) {
      previous.originalText += part.originalText + next.originalText;
      previous.revisedText += part.revisedText + next.revisedText;
      index += 1;
      continue;
    }
    compacted.push({ ...part });
  }
  return compacted;
}

function revisionWords(value: string) {
  return value.match(/[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g) ?? [];
}

function hasSubstantialMovedBlock(
  changes: Array<
    Extract<
      Extract<ContentFeedbackRevisionDiff, { mode: "inline" }>["parts"][number],
      { kind: "insert" | "delete" | "replace" }
    >
  >
) {
  const deleted = changes
    .filter((part) => part.kind === "delete")
    .map((part) => normalizedRevisionWords(part.originalText))
    .filter((words) => words.length >= 3);
  const inserted = changes
    .filter((part) => part.kind === "insert")
    .map((part) => normalizedRevisionWords(part.revisedText))
    .filter((words) => words.length >= 3);
  return deleted.some((left) =>
    inserted.some(
      (right) => left.length === right.length && left.every((word, index) => word === right[index])
    )
  );
}

function normalizedRevisionWords(value: string) {
  return revisionWords(value).map((word) => word.toLocaleLowerCase("en-US"));
}

function insertFeedbackAnnotations(
  segments: WritingRevisionSegment[],
  annotations: ContentFeedbackAnnotationSegment[]
): WritingTrackedChangeSegment[] {
  if (annotations.length === 0) return segments;
  const result: WritingTrackedChangeSegment[] = [];
  let annotationIndex = 0;
  for (const segment of segments) {
    result.push(segment);
    while (
      annotationIndex < annotations.length &&
      annotations[annotationIndex].end <= segment.end
    ) {
      result.push(annotations[annotationIndex]);
      annotationIndex += 1;
    }
  }
  result.push(...annotations.slice(annotationIndex));
  return result;
}

function isLocatedFeedback(
  item: WorkingContentFeedbackItem
): item is WorkingContentFeedbackItem & {
  start: number;
  end: number;
  original_sentence: string;
} {
  return (
    typeof (item as { start?: unknown }).start === "number" &&
    typeof (item as { end?: unknown }).end === "number" &&
    typeof (item as { original_sentence?: unknown }).original_sentence === "string"
  );
}

function validateFeedbackLocation(
  responseText: string,
  feedback: WorkingContentFeedbackItem & {
    start: number;
    end: number;
    original_sentence: string;
  }
) {
  if (
    !Number.isInteger(feedback.start) ||
    !Number.isInteger(feedback.end) ||
    feedback.start < 0 ||
    feedback.end <= feedback.start ||
    feedback.end > responseText.length ||
    responseText.slice(feedback.start, feedback.end) !== feedback.original_sentence
  ) {
    throw new Error("内容反馈 offset 无效。");
  }
}

function buildWorkspaceSegments(
  responseText: string,
  languageEdits: WorkingLanguageEdit[],
  feedbackItems: WorkingContentFeedbackItem[]
): WorkspaceRevisionSegment[] {
  const revisions = feedbackItems
    .filter(hasApplicableContentRevision)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  validateRevisions(responseText, revisions);
  const edits = languageEdits
    .sort((left, right) => left.start - right.start || left.end - right.end);
  edits.forEach((edit) => validateLanguageEdit(responseText, edit));
  const segments: WorkspaceRevisionSegment[] = [];
  let cursor = 0;

  for (const revision of revisions) {
    segments.push(...buildRangeSegments(responseText, cursor, revision.start, edits));
    const children = buildRangeSegments(
      responseText,
      revision.start,
      revision.end,
      edits
    );
    segments.push({
      kind: "feedback_sentence",
      start: revision.start,
      end: revision.end,
      originalText: revision.original_sentence,
      revisedText: children.map((segment) => segment.revisedText).join(""),
      feedback: revision,
      children
    });
    cursor = revision.end;
  }
  segments.push(...buildRangeSegments(responseText, cursor, responseText.length, edits));
  return segments;
}

function buildRangeSegments(
  responseText: string,
  start: number,
  end: number,
  edits: WorkingLanguageEdit[]
) {
  const segments: Array<Extract<WritingRevisionSegment, { kind: "text" | "language_edit" }>> = [];
  const contained = edits.filter((edit) => edit.start >= start && edit.end <= end);
  let cursor = start;
  for (const edit of contained) {
    if (edit.start < cursor) throw new Error("语言修改范围发生重叠。");
    if (edit.start > cursor) {
      const text = responseText.slice(cursor, edit.start);
      segments.push({ kind: "text", start: cursor, end: edit.start, originalText: text, revisedText: text });
    }
    segments.push({
      kind: "language_edit",
      start: edit.start,
      end: edit.end,
      originalText: edit.original_text,
      revisedText: edit.replacement_text,
      edit
    });
    cursor = edit.end;
  }
  if (cursor < end) {
    const text = responseText.slice(cursor, end);
    segments.push({ kind: "text", start: cursor, end, originalText: text, revisedText: text });
  }
  return segments;
}

function appendTextSegments(
  segments: WritingRevisionSegment[],
  responseText: string,
  start: number,
  end: number,
  boundaries: number[]
) {
  const positions = Array.from(
    new Set([start, end, ...boundaries.filter((value) => value > start && value < end)])
  ).sort((left, right) => left - right);
  for (let index = 0; index < positions.length - 1; index += 1) {
    const segmentStart = positions[index];
    const segmentEnd = positions[index + 1];
    const text = responseText.slice(segmentStart, segmentEnd);
    segments.push({
      kind: "text",
      start: segmentStart,
      end: segmentEnd,
      originalText: text,
      revisedText: text
    });
  }
}

function validateRevisions(
  responseText: string,
  revisions: ApplicableContentRevision[]
) {
  let previousEnd = 0;
  revisions.forEach((revision) => {
    if (
      !Number.isInteger(revision.start) ||
      !Number.isInteger(revision.end) ||
      revision.start < previousEnd ||
      revision.end <= revision.start ||
      revision.end > responseText.length ||
      responseText.slice(revision.start, revision.end) !== revision.original_sentence
    ) {
      throw new Error("内容改写 offset 无效或发生重叠。");
    }
    previousEnd = revision.end;
  });
}

function validateLanguageEdit(responseText: string, edit: WorkingLanguageEdit) {
  if (
    !Number.isInteger(edit.start) ||
    !Number.isInteger(edit.end) ||
    edit.start < 0 ||
    edit.end <= edit.start ||
    edit.end > responseText.length ||
    responseText.slice(edit.start, edit.end) !== edit.original_text
  ) {
    throw new Error("语言修改 offset 无效。");
  }
}
