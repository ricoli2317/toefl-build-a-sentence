import type { InternalLanguageEditV2 } from "./writingReviewSchemaV2.ts";

export type LanguageEditOverlapRelationship =
  | "exact"
  | "containment"
  | "partial_overlap"
  | "connected_mixed";

export type LanguageEditNormalizationAction =
  | "deduplicated"
  | "kept_minimal_equivalent"
  | "merged_context_overlap"
  | "merged_compatible"
  | "suppressed_conflict";

export type LanguageEditNormalizationDiagnosticEdit = {
  index: number;
  edit_id: string;
  original_text: string;
  replacement_text: string;
  category: string;
  severity: string;
  start: number;
  end: number;
  actual_change_start: number | null;
  actual_change_end: number | null;
};

export type LanguageEditNormalizationGroupDiagnostic = {
  group_start: number;
  group_end: number;
  relationship: LanguageEditOverlapRelationship;
  action: LanguageEditNormalizationAction;
  edits: LanguageEditNormalizationDiagnosticEdit[];
  kept_edit: LanguageEditNormalizationDiagnosticEdit | null;
  suppressed_edits: LanguageEditNormalizationDiagnosticEdit[];
};

export type LanguageEditOverlapNormalizationDiagnostic = {
  input_edit_count: number;
  output_edit_count: number;
  normalization_applied: boolean;
  group_count: number;
  groups: LanguageEditNormalizationGroupDiagnostic[];
};

export type LanguageEditNormalizationResult = {
  edits: InternalLanguageEditV2[];
  diagnostic: LanguageEditOverlapNormalizationDiagnostic | null;
};

type IndexedEdit = {
  edit: InternalLanguageEditV2;
  index: number;
  change: ChangedCore | null;
};

type ChangedCore = {
  sourceStart: number;
  sourceEnd: number;
  replacement: string;
};

export function normalizeLanguageEditOverlaps(
  responseText: string,
  edits: InternalLanguageEditV2[]
): LanguageEditNormalizationResult {
  const indexed = edits.map((edit, index) => ({
    edit,
    index,
    change: actualChangedCore(edit)
  }));
  const groups = connectedOverlapGroups(indexed);
  if (groups.length === 0) return { edits, diagnostic: null };

  const groupedIndices = new Set(groups.flatMap((group) => group.map(({ index }) => index)));
  const normalizedGroups = groups.map((group) => normalizeGroup(responseText, group));
  const normalizedEdits = [
    ...indexed
      .filter(({ index }) => !groupedIndices.has(index))
      .map(({ edit }) => edit),
    ...normalizedGroups.map(({ edit }) => edit)
  ].sort((left, right) =>
    left.start - right.start ||
    left.end - right.end ||
    stableEditKey(left).localeCompare(stableEditKey(right))
  );

  return {
    edits: normalizedEdits,
    diagnostic: {
      input_edit_count: edits.length,
      output_edit_count: normalizedEdits.length,
      normalization_applied: true,
      group_count: normalizedGroups.length,
      groups: normalizedGroups.map(({ diagnostic }) => diagnostic)
    }
  };
}

export function actualChangedCore(
  edit: Pick<InternalLanguageEditV2, "start" | "end" | "original_text" | "replacement_text">
): ChangedCore | null {
  const original = edit.original_text;
  const replacement = edit.replacement_text;
  let prefixLength = 0;
  const sharedLength = Math.min(original.length, replacement.length);
  while (
    prefixLength < sharedLength &&
    original[prefixLength] === replacement[prefixLength]
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < original.length - prefixLength &&
    suffixLength < replacement.length - prefixLength &&
    original[original.length - suffixLength - 1] ===
      replacement[replacement.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }
  if (prefixLength === original.length && prefixLength === replacement.length) {
    return null;
  }
  return {
    sourceStart: edit.start + prefixLength,
    sourceEnd: edit.end - suffixLength,
    replacement: replacement.slice(prefixLength, replacement.length - suffixLength)
  };
}

function connectedOverlapGroups(edits: IndexedEdit[]) {
  const ordered = [...edits].sort((left, right) =>
    left.edit.start - right.edit.start ||
    left.edit.end - right.edit.end ||
    stableEditKey(left.edit).localeCompare(stableEditKey(right.edit))
  );
  const groups: IndexedEdit[][] = [];
  let current: IndexedEdit[] = [];
  let groupEnd = -1;
  ordered.forEach((item) => {
    if (current.length === 0 || item.edit.start < groupEnd) {
      current.push(item);
      groupEnd = Math.max(groupEnd, item.edit.end);
      return;
    }
    if (current.length > 1) groups.push(current);
    current = [item];
    groupEnd = item.edit.end;
  });
  if (current.length > 1) groups.push(current);
  return groups;
}

function normalizeGroup(responseText: string, group: IndexedEdit[]) {
  const relationship = groupRelationship(group);
  const exactDeduplicated = deduplicateExact(group);
  if (exactDeduplicated.length === 1) {
    const kept = exactDeduplicated[0];
    return normalizedGroupResult(
      kept.edit,
      group,
      kept,
      "deduplicated",
      relationship
    );
  }

  const equivalentDeduplicated = deduplicateEquivalentChanges(exactDeduplicated);
  if (equivalentDeduplicated.length === 1) {
    const kept = equivalentDeduplicated[0];
    return normalizedGroupResult(
      kept.edit,
      group,
      kept,
      "kept_minimal_equivalent",
      relationship
    );
  }

  const changed = equivalentDeduplicated.filter(
    (item): item is IndexedEdit & { change: ChangedCore } => item.change !== null
  );
  if (changed.length > 0 && changed.every((item, index) =>
    changed.slice(index + 1).every((other) => !changedCoresConflict(item.change, other.change))
  )) {
    const merged = mergeChangedCores(responseText, equivalentDeduplicated, changed);
    return normalizedGroupResult(
      merged,
      group,
      bestEdit(equivalentDeduplicated),
      "merged_context_overlap",
      relationship
    );
  }

  const compatible = compatibleCarrier(equivalentDeduplicated);
  if (compatible) {
    return normalizedGroupResult(
      withCombinedExplanations(compatible.edit, equivalentDeduplicated),
      group,
      compatible,
      "merged_compatible",
      relationship
    );
  }

  const kept = bestEdit(equivalentDeduplicated);
  return normalizedGroupResult(
    kept.edit,
    group,
    kept,
    "suppressed_conflict",
    relationship
  );
}

function deduplicateExact(group: IndexedEdit[]) {
  const byCorrection = new Map<string, IndexedEdit[]>();
  group.forEach((item) => {
    const key = [
      item.edit.start,
      item.edit.end,
      item.edit.original_text,
      item.edit.replacement_text
    ].join("\u0000");
    const bucket = byCorrection.get(key);
    if (bucket) bucket.push(item);
    else byCorrection.set(key, [item]);
  });
  return Array.from(byCorrection.values()).map(bestEdit);
}

function deduplicateEquivalentChanges(group: IndexedEdit[]) {
  const byChange = new Map<string, IndexedEdit[]>();
  group.forEach((item) => {
    const key = item.change
      ? [item.change.sourceStart, item.change.sourceEnd, item.change.replacement].join(
          "\u0000"
        )
      : `noop\u0000${stableEditKey(item.edit)}`;
    const bucket = byChange.get(key);
    if (bucket) bucket.push(item);
    else byChange.set(key, [item]);
  });
  return Array.from(byChange.values()).map((items) =>
    [...items].sort((left, right) =>
      localizedLength(left) - localizedLength(right) || compareEditQuality(left, right)
    )[0]
  );
}

function mergeChangedCores(
  responseText: string,
  group: IndexedEdit[],
  changed: Array<IndexedEdit & { change: ChangedCore }>
) {
  const unionStart = Math.min(...group.map(({ edit }) => edit.start));
  const unionEnd = Math.max(...group.map(({ edit }) => edit.end));
  let replacement = responseText.slice(unionStart, unionEnd);
  [...changed]
    .sort((left, right) =>
      right.change.sourceStart - left.change.sourceStart ||
      right.change.sourceEnd - left.change.sourceEnd ||
      stableEditKey(left.edit).localeCompare(stableEditKey(right.edit))
    )
    .forEach(({ change }) => {
      const relativeStart = change.sourceStart - unionStart;
      const relativeEnd = change.sourceEnd - unionStart;
      replacement =
        replacement.slice(0, relativeStart) +
        change.replacement +
        replacement.slice(relativeEnd);
    });
  const metadata = bestEdit(group).edit;
  return {
    ...metadata,
    start: unionStart,
    end: unionEnd,
    original_text: responseText.slice(unionStart, unionEnd),
    replacement_text: replacement,
    explanation: combinedExplanations(group)
  };
}

function combinedExplanations(group: IndexedEdit[]) {
  return Array.from(
    new Set(
      group
        .map(({ edit }) => edit.explanation.trim())
        .filter(Boolean)
    )
  ).join("\n");
}

function withCombinedExplanations(
  edit: InternalLanguageEditV2,
  group: IndexedEdit[]
) {
  const explanation = combinedExplanations(group);
  return explanation ? { ...edit, explanation } : edit;
}

function compatibleCarrier(group: IndexedEdit[]) {
  return [...group]
    .sort((left, right) =>
      right.edit.end - right.edit.start - (left.edit.end - left.edit.start) ||
      compareEditQuality(left, right)
    )
    .find((candidate) =>
      group.every((other) =>
        candidate === other || correctionSubsumes(candidate, other)
      )
    );
}

function correctionSubsumes(carrier: IndexedEdit, other: IndexedEdit) {
  if (
    carrier.edit.start > other.edit.start ||
    carrier.edit.end < other.edit.end
  ) {
    return false;
  }
  if (!other.change) return true;
  const replacementSignal =
    other.change.replacement || other.edit.replacement_text;
  return Boolean(replacementSignal) && carrier.edit.replacement_text.includes(replacementSignal);
}

function normalizedGroupResult(
  edit: InternalLanguageEditV2,
  originalGroup: IndexedEdit[],
  kept: IndexedEdit,
  action: LanguageEditNormalizationAction,
  relationship: LanguageEditOverlapRelationship
) {
  const allDiagnostics = originalGroup.map(diagnosticEdit);
  const keptDiagnostic = diagnosticEdit(kept);
  return {
    edit,
    diagnostic: {
      group_start: Math.min(...originalGroup.map(({ edit: item }) => item.start)),
      group_end: Math.max(...originalGroup.map(({ edit: item }) => item.end)),
      relationship,
      action,
      edits: allDiagnostics,
      kept_edit: keptDiagnostic,
      suppressed_edits:
        action === "merged_context_overlap" || action === "merged_compatible"
          ? []
          : allDiagnostics.filter((item) => item.index !== kept.index)
    } satisfies LanguageEditNormalizationGroupDiagnostic
  };
}

function diagnosticEdit(item: IndexedEdit): LanguageEditNormalizationDiagnosticEdit {
  return {
    index: item.index,
    edit_id: item.edit.edit_id,
    original_text: item.edit.original_text,
    replacement_text: item.edit.replacement_text,
    category: item.edit.category,
    severity: item.edit.severity,
    start: item.edit.start,
    end: item.edit.end,
    actual_change_start: item.change?.sourceStart ?? null,
    actual_change_end: item.change?.sourceEnd ?? null
  };
}

function groupRelationship(group: IndexedEdit[]): LanguageEditOverlapRelationship {
  const relationships = new Set<Exclude<LanguageEditOverlapRelationship, "connected_mixed">>();
  for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
      const left = group[leftIndex].edit;
      const right = group[rightIndex].edit;
      if (Math.max(left.start, right.start) >= Math.min(left.end, right.end)) continue;
      if (left.start === right.start && left.end === right.end) {
        relationships.add("exact");
      } else if (
        (left.start <= right.start && left.end >= right.end) ||
        (right.start <= left.start && right.end >= left.end)
      ) {
        relationships.add("containment");
      } else {
        relationships.add("partial_overlap");
      }
    }
  }
  return relationships.size === 1
    ? Array.from(relationships)[0]
    : "connected_mixed";
}

function changedCoresConflict(left: ChangedCore, right: ChangedCore) {
  const leftInsertion = left.sourceStart === left.sourceEnd;
  const rightInsertion = right.sourceStart === right.sourceEnd;
  if (leftInsertion && rightInsertion) return left.sourceStart === right.sourceStart;
  if (leftInsertion) {
    return left.sourceStart >= right.sourceStart && left.sourceStart <= right.sourceEnd;
  }
  if (rightInsertion) {
    return right.sourceStart >= left.sourceStart && right.sourceStart <= left.sourceEnd;
  }
  return left.sourceStart < right.sourceEnd && right.sourceStart < left.sourceEnd;
}

function bestEdit(group: IndexedEdit[]) {
  return [...group].sort(compareEditQuality)[0];
}

function compareEditQuality(left: IndexedEdit, right: IndexedEdit) {
  const leftNoop = left.change === null ? 1 : 0;
  const rightNoop = right.change === null ? 1 : 0;
  return (
    leftNoop - rightNoop ||
    changedLength(left) - changedLength(right) ||
    localizedLength(left) - localizedLength(right) ||
    metadataScore(right.edit) - metadataScore(left.edit) ||
    stableEditKey(left.edit).localeCompare(stableEditKey(right.edit))
  );
}

function changedLength(item: IndexedEdit) {
  return item.change
    ? item.change.sourceEnd - item.change.sourceStart + item.change.replacement.length
    : Number.MAX_SAFE_INTEGER;
}

function localizedLength(item: IndexedEdit) {
  return item.edit.end - item.edit.start;
}

function metadataScore(edit: InternalLanguageEditV2) {
  return [edit.category, edit.severity, edit.explanation]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .reduce((total, value) => total + value.trim().length, 0);
}

function stableEditKey(edit: InternalLanguageEditV2) {
  return [
    edit.start,
    edit.end,
    edit.original_text,
    edit.replacement_text,
    edit.category,
    edit.severity,
    edit.explanation,
    edit.edit_id
  ].join("\u0000");
}
