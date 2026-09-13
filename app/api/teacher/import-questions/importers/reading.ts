import { adaptReadingCsv } from "@/lib/reading/csvAdapter";
import type { ReadingCsvType } from "@/lib/reading/csvSchemas";
import { groupReadingSourceOccurrences } from "@/lib/reading/grouping";
import {
  assertPreparedReadingPackageCanImport,
  importReadingPackageAtomic,
  prepareReadingPackagesForImport,
  type PreparedReadingImportPackage
} from "@/lib/reading/importer";
import {
  buildReadingDuplicateReviewPlans,
  indexReadingDuplicateResolutions,
  resolveReadingDuplicateImports
} from "@/lib/reading/duplicateResolution";
import {
  assertReadingPendingResolutionInvariant,
  type ReadingDuplicateSourceOccurrencePreview
} from "@/lib/reading/duplicateResolutionModel";
import {
  buildReadingDuplicateResolutionItem,
  readingQuestionRange
} from "@/lib/reading/duplicateResolutionView";
import type { ReadingMaterial } from "@/lib/reading/types";
import { isRdlMaterialType } from "@/lib/reading/materialTypes";
import {
  summarizeReadingImportExecutions,
  type ReadingImportExecution,
  type ReadingLogicalReuseKind
} from "@/lib/reading/importExecution";
import {
  assertReadingUnableToImportDetailInvariant,
  summarizeReadingImportIssues,
  type ReadingImportFailureCategory
} from "@/lib/reading/importSummary";
import type {
  FailedRow,
  ImporterContext,
  ImportResult
} from "./types";
import {
  indexReadingContentConflictResolutions,
  type ReadingContentConflictResolution
} from "@/lib/reading/contentReconciliation";
import { buildReadingCanonicalContentUpdate } from "@/lib/reading/contentCorrection";
import { buildRdlImportGroupDecision } from "@/lib/reading/rdlImportDecision";

export function readingCsvImporter(type: ReadingCsvType) {
  return (context: ImporterContext) => importReadingCsv(context, type);
}

async function importReadingCsv(
  {
    rows,
    supabase,
    userId,
    fileName,
    dryRun,
    readingDuplicateResolutions,
    readingContentConflictResolutions
  }: ImporterContext,
  type: ReadingCsvType
): Promise<ImportResult> {
  const materialCatalog = type === "read_in_daily_life"
    ? await loadMaterials(supabase, rows)
    : undefined;
  const adapted = adaptReadingCsv({
    type,
    rows,
    sourceFile: fileName ?? "reading.csv",
    materials: materialCatalog,
    allowRegisteredMaterialStorageKeys: type === "read_in_daily_life"
  });
  const grouped = groupReadingSourceOccurrences(adapted.candidates);
  const preparedPackages = await prepareReadingPackagesForImport(supabase, grouped.packages, {
    enableCtwFingerprintFallback: true,
    enableHistoricalSemanticFallback: true,
    rdlMaterialCatalog: materialCatalog ? Array.from(materialCatalog.values()) : undefined
  });
  const reviewPlans = buildReadingDuplicateReviewPlans(preparedPackages);
  const historicalCandidateIds = Array.from(new Set(reviewPlans.flatMap((review) =>
    review.candidates
      .filter((candidate) => !preparedPackages.some((item) => item.packageData.item.logicalItemId === candidate.item.logicalItemId))
      .map((candidate) => candidate.item.logicalItemId)
  )));
  const candidateOccurrences = await loadCandidateOccurrences(supabase, historicalCandidateIds);
  const pendingResolutionItems = reviewPlans.map((review) =>
    buildReadingDuplicateResolutionItem(review, candidateOccurrences)
  );
  const hasPendingDuplicates = reviewPlans.length > 0
    || preparedPackages.some((prepared) => prepared.materialMatchKind === "possible_material_duplicate");
  assertReadingPendingResolutionInvariant({ hasPendingDuplicates, pendingResolutionItems });
  const resolutionById = indexReadingDuplicateResolutions(
    reviewPlans,
    readingDuplicateResolutions ?? []
  );
  const contentConflictItems = preparedPackages.flatMap((prepared) =>
    prepared.contentReconciliations.map((reconciliation) => reconciliation.item)
  );
  const contentResolutionById = indexReadingContentConflictResolutions(
    contentConflictItems,
    readingContentConflictResolutions ?? []
  );
  const duplicateWarnings = reviewPlans.map((review) => ({
    message: review.questionType === "rdl"
      ? "RDL 素材可能相同，但 canonical identity 证据不足，需确认后才能导入。"
      : review.questionType === "rap"
        ? "RAP 文章可能相同，但 passage identity 证据不足，需确认后才能导入。"
        : "CTW 内容相似但存在实质差异，需确认后才能导入。",
    operation: "check Reading possible duplicates",
    details: `resolution=${review.resolutionId}; module=${review.questionType}; scope=${review.identityScope}; existing=${review.candidates.map((candidate) => candidate.item.logicalItemId).join(",")}; action=block pending review`
  }));
  const historicalDuplicateWarnings = preparedPackages.flatMap((prepared) => {
    const warnings = [];
    if (prepared.historicalDuplicateLogicalItemIds.length > 0) {
      warnings.push({
        message: "同一素材或文章存在历史重复，已稳定复用最早题目，等待后续清理。",
        operation: "check Reading historical duplicates",
        details: `existing=${prepared.historicalDuplicateLogicalItemIds.join(",")}; action=reuse stable survivor`
      });
    }
    return warnings;
  });
  const warnings = [
    ...(dryRun ? duplicateWarnings : []),
    ...historicalDuplicateWarnings
  ];
  const failedRows: FailedRow[] = adapted.failures.map((failure) => ({
    rowNumber: failure.rowNumber,
    questionId: failure.sourceGroupId,
    setId: failure.sourceLabel,
    reason: failure.reason,
    code: "READING_VALIDATION_ERROR",
    category: "validation_error" as const,
    operation: "validate Reading group"
  }));
  const executions: ReadingImportExecution[] = [];
  let occurrenceConflictCount = 0;
  let updatedCount = 0;
  let successCount = 0;

  const unresolvedReviews = reviewPlans.filter((review) => !resolutionById.has(review.resolutionId));
  const unresolvedContentConflicts = contentConflictItems.filter((item) =>
    !contentResolutionById.has(item.resolutionId)
  );
  if (!dryRun && unresolvedReviews.length > 0) {
    throw Object.assign(
      new Error(`仍有 ${unresolvedReviews.length} 项相似题未处理，不能正式导入。`),
      {
        code: "READING_DUPLICATE_RESOLUTION_REQUIRED",
        operation: "resolve Reading possible duplicates"
      }
    );
  }
  if (!dryRun && unresolvedContentConflicts.length > 0) {
    throw Object.assign(
      new Error(`仍有 ${unresolvedContentConflicts.length} 项题目内容冲突未处理，不能正式导入。`),
      {
        code: "READING_CONTENT_CONFLICT_REQUIRED",
        operation: "resolve Reading content conflicts"
      }
    );
  }

  const resolvedImports = dryRun
    ? preparedPackages
        .filter((prepared) => !reviewPlans.some((review) => review.incoming === prepared))
        .map((prepared) => ({
          packageData: prepared.packageData,
          existingItem: prepared.existingItem,
          members: [prepared],
          manuallyResolved: false
        }))
    : resolveReadingDuplicateImports(preparedPackages, reviewPlans, resolutionById);

  if (!dryRun) {
    // Validate every resolved group before the first database write. This keeps
    // a stale or forged resolution from producing a partially imported batch.
    for (const resolved of resolvedImports) assertResolvedImportCanProceed(resolved);
  }

  for (const resolved of resolvedImports) {
    let { packageData } = resolved;
    const { existingItem, members } = resolved;
    const contentResolution = resolveContentForImport(
      packageData,
      members,
      contentResolutionById
    );
    packageData = contentResolution.packageData;
    const addedOccurrenceCount = members.reduce((count, member) => count + member.addedOccurrenceCount, 0);
    try {
      if (dryRun) assertResolvedImportCanProceed(resolved);
      const existed = Boolean(existingItem);
      const firstSeen = [
        ...(existingItem ? [existingItem] : []),
        ...members.map((member) => ({
          date: member.packageData.item.firstSeenDate,
          sourceLabel: member.packageData.item.firstSeenSourceLabel,
          sourceOrder: member.packageData.item.firstSeenSourceOrder
        }))
      ].sort(compareFirstSeen)[0];
      const manualActions = members.flatMap((member) => {
        const review = reviewPlans.find((candidate) => candidate.incoming === member);
        const resolution = review ? resolutionById.get(review.resolutionId) : undefined;
        return resolution ? [resolution.action] : [];
      });
      let execution: ReadingImportExecution;
      if (!dryRun) {
        const imported = await importReadingPackageAtomic(supabase, packageData, {
          createdBy: userId,
          firstSeen,
          replaceCanonicalContent: contentResolution.replaceCanonicalContent
        });
        execution = {
          logicalItemAction: imported.logicalItemAction,
          logicalReuseKind: imported.logicalItemAction === "reuse_existing"
            ? logicalReuseKind(members, manualActions)
            : null,
          insertedOccurrenceCount: imported.insertedOccurrenceCount,
          existingOccurrenceCount: imported.existingOccurrenceCount
        };
      } else {
        execution = {
          logicalItemAction: existed ? "reuse_existing" : "create_new",
          logicalReuseKind: existed ? logicalReuseKind(members, manualActions) : null,
          insertedOccurrenceCount: addedOccurrenceCount,
          existingOccurrenceCount: packageData.occurrences.length - addedOccurrenceCount
        };
      }
      executions.push(execution);
      successCount += members.length;
      if (execution.logicalItemAction === "reuse_existing" && execution.insertedOccurrenceCount > 0) {
        updatedCount += 1;
      }
    } catch (error) {
      const hasSourceConflict = members.some((member) => member.occurrenceConflict);
      if (hasSourceConflict) occurrenceConflictCount += 1;
      const failure = readingFailure(error, dryRun === true, hasSourceConflict);
      failedRows.push({
        rowNumber: sourceRowNumber(rows, packageData.occurrences[0]?.sourceLabel),
        questionId: packageData.occurrences[0]?.occurrenceId ?? packageData.item.logicalItemId,
        setId: packageData.occurrences[0]?.sourceLabel,
        reason: failure.reason,
        code: failure.code,
        category: failure.category,
        operation: dryRun ? "preflight Reading group" : "import Reading group atomically"
      });
    }
  }

  const rejectedGroupKeys = new Set(adapted.failures.map((failure) =>
    [failure.sourceLabel, failure.sourceGroupId].join("\u001f")
  ));
  const rejectedRowCount = rows.filter((row) => rejectedGroupKeys.has([
    row.source_label?.trim() ?? "",
    row.source_group_id?.trim() ?? ""
  ].join("\u001f"))).length;
  const executionSummary = summarizeReadingImportExecutions(executions);
  const issueSummary = summarizeReadingImportIssues(pendingResolutionItems.length, failedRows);
  assertReadingUnableToImportDetailInvariant({
    unableToImportCount: issueSummary.unableToImportCount,
    failedRows
  });
  const rdlGroupDecisions = type === "read_in_daily_life"
    ? preparedPackages.map(buildRdlImportGroupDecision)
    : [];

  return {
    success: true,
    preview: dryRun === true,
    csvRowCount: rows.length,
    acceptedRowCount: rows.length - rejectedRowCount,
    rejectedRowCount,
    occurrenceCount: adapted.candidates.length,
    blockerCount: issueSummary.unableToImportCount,
    unableToImportCount: issueSummary.unableToImportCount,
    validationErrorCount: issueSummary.validationErrorCount,
    sourceConflictCount: issueSummary.sourceConflictCount,
    actualImportErrorCount: issueSummary.actualImportErrorCount,
    successCount,
    insertedCount: executionSummary.logicalNewItemCount,
    updatedCount,
    logicalNewItemCount: executionSummary.logicalNewItemCount,
    logicalReusedItemCount: executionSummary.logicalReusedItemCount,
    logicalAutoMergeCount: executionSummary.logicalReusedItemCount,
    logicalNeedsReviewCount: dryRun ? pendingResolutionItems.length : 0,
    possibleDuplicateCount: dryRun ? pendingResolutionItems.length : 0,
    hasPendingDuplicates: dryRun ? hasPendingDuplicates : false,
    pendingResolutionItems: dryRun ? pendingResolutionItems : [],
    contentConflictCount: dryRun ? contentConflictItems.length : 0,
    contentConflictItems: dryRun ? contentConflictItems : [],
    rdlGroupDecisions: dryRun ? rdlGroupDecisions : [],
    occurrenceInsertedCount: executionSummary.occurrenceInsertedCount,
    exactFingerprintReuseCount: executionSummary.exactFingerprintReuseCount,
    semanticReuseCount: executionSummary.semanticReuseCount,
    manualReuseCount: executionSummary.manualReuseCount,
    existingOccurrenceCount: executionSummary.existingOccurrenceCount,
    occurrenceConflictCount,
    rdlMaterialReuseCount: preparedPackages.filter((item) =>
      item.materialMatchKind === "exact_material" || item.materialMatchKind === "semantic_material"
    ).length,
    rdlNewMaterialCount: 0,
    rdlMaterialWarningCount: dryRun ? pendingResolutionItems.filter(
      (item) => item.identityScope === "material"
    ).length : 0,
    failedCount: issueSummary.unableToImportCount,
    failedRows,
    warnings
  };
}

function resolveContentForImport(
  packageData: PreparedReadingImportPackage["packageData"],
  members: PreparedReadingImportPackage[],
  resolutions: Map<string, ReadingContentConflictResolution>
) {
  const reconciliations = members.flatMap((member) => member.contentReconciliations);
  const updates = reconciliations.filter((reconciliation) =>
    resolutions.get(reconciliation.item.resolutionId)?.action === "update_from_source"
  );
  if (updates.length > 1) {
    throw Object.assign(
      new Error("同一 logical item 选择了多个不同来源版本，无法确定 canonical correction。"),
      {
        code: "READING_CONTENT_CONFLICT_REQUIRED",
        operation: "resolve Reading content conflicts"
      }
    );
  }
  const update = updates[0];
  if (!update) return { packageData, replaceCanonicalContent: false };
  const corrected = buildReadingCanonicalContentUpdate(
    update.existingPackage,
    update.incomingPackage
  );
  return {
    packageData: {
      ...corrected,
      item: {
        ...corrected.item,
        firstSeenDate: packageData.item.firstSeenDate,
        firstSeenSourceLabel: packageData.item.firstSeenSourceLabel,
        firstSeenSourceOrder: packageData.item.firstSeenSourceOrder
      },
      occurrences: packageData.occurrences
    },
    replaceCanonicalContent: true
  };
}

function logicalReuseKind(
  members: PreparedReadingImportPackage[],
  manualActions: Array<"reuse_existing" | "create_new">
): ReadingLogicalReuseKind {
  if (manualActions.includes("reuse_existing")) return "manual";
  if (members.some((member) => member.existingItem && member.reuseKind === "semantic")) return "semantic";
  if (members.some((member) => member.existingItem)) return "exact_fingerprint";
  return null;
}

function assertResolvedImportCanProceed(resolved: {
  members: PreparedReadingImportPackage[];
  manuallyResolved: boolean;
}) {
  assertPreparedReadingPackageCanImport({
    occurrenceConflict: resolved.members.find((member) => member.occurrenceConflict)?.occurrenceConflict ?? null,
    possibleDuplicateLogicalItemIds: resolved.manuallyResolved
      ? []
      : resolved.members.flatMap((member) => member.possibleDuplicateLogicalItemIds),
    materialMatchKind: resolved.manuallyResolved
      ? "not_applicable"
      : resolved.members.find((member) => member.materialMatchKind === "possible_material_duplicate")?.materialMatchKind
  });
}

async function loadCandidateOccurrences(
  supabase: ImporterContext["supabase"],
  logicalItemIds: string[]
) {
  const result = new Map<string, ReadingDuplicateSourceOccurrencePreview[]>();
  if (logicalItemIds.length === 0) return result;
  const { data, error } = await supabase
    .from("reading_source_occurrences")
    .select("logical_item_id,source_label,occurrence_date,source_module,source_order,source_question_start,source_question_end")
    .in("logical_item_id", logicalItemIds);
  if (error) throw new Error(`read Reading candidate occurrences: ${error.message}`);
  for (const row of data ?? []) {
    const logicalItemId = String(row.logical_item_id);
    const occurrence = {
      sourceLabel: String(row.source_label),
      occurrenceDate: String(row.occurrence_date),
      sourceModule: String(row.source_module),
      sourceOrder: Number(row.source_order),
      sourceQuestionRange: readingQuestionRange(Number(row.source_question_start), Number(row.source_question_end))
    };
    result.set(logicalItemId, [...(result.get(logicalItemId) ?? []), occurrence]);
  }
  return result;
}

function readingFailure(
  error: unknown,
  dryRun: boolean,
  sourceConflict: boolean
): { reason: string; code: string; category: ReadingImportFailureCategory } {
  const candidate = error as { message?: unknown; code?: unknown };
  const reason = typeof candidate?.message === "string" ? candidate.message : String(error);
  if (sourceConflict) {
    return { reason, code: "READING_SOURCE_CONFLICT", category: "source_conflict" };
  }
  if (dryRun) {
    return {
      reason,
      code: typeof candidate?.code === "string" ? candidate.code : "READING_VALIDATION_ERROR",
      category: "validation_error"
    };
  }
  return {
    reason,
    code: typeof candidate?.code === "string" ? candidate.code : "READING_IMPORT_ERROR",
    category: "actual_import_error"
  };
}

async function loadMaterials(
  supabase: ImporterContext["supabase"],
  rows: Array<Record<string, string>>
) {
  const ids = Array.from(new Set(rows.map((row) => row.material_id?.trim()).filter(Boolean))) as string[];
  if (ids.length === 0) return new Map<string, ReadingMaterial>();
  const { data, error } = await supabase
    .from("reading_materials")
    .select("material_id,title,material_type,source,source_date,year_month,binding_status,image_asset_path,hitbox_data_path");
  if (error) throw new Error(`read Reading materials: ${error.message}`);
  return new Map((data ?? []).map((row) => {
    const materialType = row.material_type === null ? null : String(row.material_type);
    if (materialType !== null && !isRdlMaterialType(materialType)) {
      throw new Error(`read Reading materials: unsupported material_type for ${String(row.material_id)}`);
    }
    return [String(row.material_id), {
    materialId: String(row.material_id),
    title: row.title === null ? null : String(row.title),
    materialType,
    source: String(row.source),
    sourceDate: row.source_date === null ? null : String(row.source_date),
    yearMonth: String(row.year_month),
    bindingStatus: row.binding_status as "bound" | "pending",
    imageAssetPath: row.image_asset_path === null ? null : String(row.image_asset_path),
    hitboxDataPath: row.hitbox_data_path === null ? null : String(row.hitbox_data_path)
    } satisfies ReadingMaterial] as const;
  }));
}

const sourceLabelCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareFirstSeen(
  left: { date: string; sourceLabel: string; sourceOrder: number },
  right: { date: string; sourceLabel: string; sourceOrder: number }
) {
  return left.date.localeCompare(right.date)
    || sourceLabelCollator.compare(left.sourceLabel, right.sourceLabel)
    || left.sourceOrder - right.sourceOrder;
}

function sourceRowNumber(rows: Array<Record<string, string>>, sourceLabel?: string) {
  const index = rows.findIndex((row) => row.source_label?.trim() === sourceLabel);
  return index < 0 ? 2 : index + 2;
}
