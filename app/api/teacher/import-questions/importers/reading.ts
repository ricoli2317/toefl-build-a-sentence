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
  resolveReadingDuplicateImports,
  type ReadingDuplicateReviewPlan
} from "@/lib/reading/duplicateResolution";
import type { ReadingImportPackage, ReadingMaterial, ReadingQuestion } from "@/lib/reading/types";
import { isRdlMaterialType } from "@/lib/reading/materialTypes";
import type {
  ImporterContext,
  ImportResult,
  ReadingDuplicateCandidate,
  ReadingDuplicateReview
} from "./types";

export function readingCsvImporter(type: ReadingCsvType) {
  return (context: ImporterContext) => importReadingCsv(context, type);
}

async function importReadingCsv(
  { rows, supabase, userId, fileName, dryRun, readingDuplicateResolutions }: ImporterContext,
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
  const reviewPlans = buildReadingDuplicateReviewPlans(preparedPackages, grouped.report.possibleDuplicates);
  const historicalCandidateIds = Array.from(new Set(reviewPlans.flatMap((review) =>
    review.candidates
      .filter((candidate) => !preparedPackages.some((item) => item.packageData.item.logicalItemId === candidate.item.logicalItemId))
      .map((candidate) => candidate.item.logicalItemId)
  )));
  const candidateOccurrences = await loadCandidateOccurrences(supabase, historicalCandidateIds);
  const pendingDuplicates = reviewPlans.map((review) => duplicateReview(review, candidateOccurrences));
  const resolutionByPendingId = new Map(
    (readingDuplicateResolutions ?? []).map((resolution) => [resolution.pendingId, resolution])
  );
  const logicalWarnings = reviewPlans.map((review) => ({
    message: "可能重复的 Reading 内容存在实质差异，需确认后才能导入。",
    operation: "check Reading possible duplicates",
    details: `module=${review.incoming.packageData.item.module}; existing=${review.candidates.map((candidate) => candidate.item.logicalItemId).join(",")}; action=block pending review`
  }));
  const materialWarnings = preparedPackages.flatMap((prepared) =>
    prepared.materialMatchKind === "possible_material_duplicate"
      ? [{
          message: "RDL material 文字元数据相似，但 visual equivalence 证据不足；未覆盖或改绑现有资产。",
          operation: "check RDL canonical material",
          details: `material=${prepared.packageData.materials[0]?.materialId ?? "unknown"}; action=review existing canonical assets`
        }]
      : []
  );
  const dataQualityWarnings = preparedPackages.flatMap((prepared) => {
    const warnings = [];
    if (prepared.dataQualityWarning) {
      warnings.push({
        message: prepared.dataQualityWarning,
        operation: "check Reading source content",
        details: `module=${prepared.packageData.item.module}; action=keep canonical questions and answers`
      });
    }
    if (prepared.historicalDuplicateLogicalItemIds.length > 0) {
      warnings.push({
        message: "同一素材或文章存在历史重复，已稳定复用最早题目，等待后续清理。",
        operation: "check Reading historical duplicates",
        details: `existing=${prepared.historicalDuplicateLogicalItemIds.join(",")}; action=reuse stable survivor`
      });
    }
    return warnings;
  });
  const possibleDuplicateWarnings = logicalWarnings;
  const warnings = [
    ...(dryRun ? possibleDuplicateWarnings : []),
    ...(dryRun ? materialWarnings : []),
    ...dataQualityWarnings
  ];
  const failedRows = adapted.failures.map((failure) => ({
    rowNumber: failure.rowNumber,
    questionId: failure.sourceGroupId,
    setId: failure.sourceLabel,
    reason: failure.reason,
    operation: "validate Reading group"
  }));
  let createdCount = 0;
  let reusedCount = 0;
  let occurrenceInsertedCount = 0;
  let existingOccurrenceCount = 0;
  let exactFingerprintReuseCount = 0;
  let semanticReuseCount = 0;
  let manualReuseCount = 0;
  let occurrenceConflictCount = 0;
  let updatedCount = 0;
  let successCount = 0;

  const unresolvedReviews = reviewPlans.filter((review) => !resolutionByPendingId.has(review.pendingId));
  if (!dryRun && unresolvedReviews.length > 0) {
    throw Object.assign(
      new Error(`仍有 ${unresolvedReviews.length} 项相似题未处理，不能正式导入。`),
      { operation: "resolve Reading possible duplicates" }
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
    : resolveReadingDuplicateImports(preparedPackages, reviewPlans, resolutionByPendingId);

  if (!dryRun) {
    // Validate every resolved group before the first database write. This keeps
    // a stale or forged resolution from producing a partially imported batch.
    for (const resolved of resolvedImports) assertResolvedImportCanProceed(resolved);
  }

  for (const resolved of resolvedImports) {
    const { packageData, existingItem, members } = resolved;
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
      if (!dryRun) {
        await importReadingPackageAtomic(supabase, packageData, { createdBy: userId, firstSeen });
      }
      successCount += members.length;
      occurrenceInsertedCount += addedOccurrenceCount;
      existingOccurrenceCount += members.reduce(
        (count, member) => count + member.packageData.occurrences.length - member.addedOccurrenceCount,
        0
      );
      semanticReuseCount += members.reduce((count, member) => count + member.batchSemanticReuseCount, 0);
      const manualActions = members.flatMap((member) => {
        const review = reviewPlans.find((candidate) => candidate.incoming === member);
        const resolution = review ? resolutionByPendingId.get(review.pendingId) : undefined;
        return resolution ? [resolution.action] : [];
      });
      manualReuseCount += manualActions.filter((action) => action === "reuse_existing").length;
      createdCount += manualActions.filter((action) => action === "create_new").length;
      if (existed) {
        reusedCount += members.filter((member) => !reviewPlans.some((review) => review.incoming === member)).length;
        for (const member of members) {
          if (reviewPlans.some((review) => review.incoming === member)) continue;
          if (member.reuseKind === "semantic") semanticReuseCount += 1;
          else exactFingerprintReuseCount += 1;
        }
        updatedCount += addedOccurrenceCount > 0 ? 1 : 0;
      } else if (manualActions.length === 0) {
        createdCount += 1;
      }
    } catch (error) {
      if (members.some((member) => member.occurrenceConflict)) occurrenceConflictCount += 1;
      failedRows.push({
        rowNumber: sourceRowNumber(rows, packageData.occurrences[0]?.sourceLabel),
        questionId: packageData.occurrences[0]?.occurrenceId ?? packageData.item.logicalItemId,
        setId: packageData.occurrences[0]?.sourceLabel,
        reason: error instanceof Error ? error.message : String(error),
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

  return {
    success: true,
    preview: dryRun === true,
    csvRowCount: rows.length,
    acceptedRowCount: rows.length - rejectedRowCount,
    rejectedRowCount,
    occurrenceCount: adapted.candidates.length,
    blockerCount: failedRows.length,
    successCount,
    insertedCount: createdCount,
    updatedCount,
    logicalNewItemCount: createdCount,
    logicalAutoMergeCount: reusedCount + manualReuseCount + preparedPackages.reduce(
      (count, item) => count + item.batchSemanticReuseCount,
      0
    ),
    logicalNeedsReviewCount: dryRun ? pendingDuplicates.length : 0,
    possibleDuplicateCount: dryRun ? pendingDuplicates.length : 0,
    pendingDuplicates: dryRun ? pendingDuplicates : [],
    occurrenceInsertedCount,
    exactFingerprintReuseCount,
    semanticReuseCount,
    manualReuseCount,
    existingOccurrenceCount,
    occurrenceConflictCount,
    rdlMaterialReuseCount: preparedPackages.filter((item) =>
      item.materialMatchKind === "exact_material" || item.materialMatchKind === "semantic_material"
    ).length,
    rdlNewMaterialCount: 0,
    rdlMaterialWarningCount: dryRun ? preparedPackages.filter(
      (item) => item.materialMatchKind === "possible_material_duplicate"
    ).length : 0,
    failedCount: failedRows.length,
    failedRows,
    warnings
  };
}

type CandidateOccurrence = ReadingDuplicateCandidate["sourceOccurrences"][number];

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

function duplicateReview(
  review: ReadingDuplicateReviewPlan,
  historicalOccurrences: Map<string, CandidateOccurrence[]>
): ReadingDuplicateReview {
  return {
    pendingId: review.pendingId,
    reason: review.reason,
    addedOccurrenceCount: review.incoming.addedOccurrenceCount,
    existingOccurrenceCount:
      review.incoming.packageData.occurrences.length - review.incoming.addedOccurrenceCount,
    resolvesMaterialWarning: review.incoming.materialMatchKind === "possible_material_duplicate",
    incoming: readingPreview(review.incoming.packageData),
    candidates: review.candidates.map((candidate) => ({
      ...readingPreview(candidate),
      firstSeenDate: candidate.item.firstSeenDate,
      firstSeenSourceLabel: candidate.item.firstSeenSourceLabel,
      sourceOccurrences: candidate.occurrences.length > 0
        ? candidate.occurrences.map(sourceOccurrencePreview)
        : historicalOccurrences.get(candidate.item.logicalItemId) ?? []
    }))
  };
}

function readingPreview(packageData: ReadingImportPackage) {
  const occurrence = packageData.occurrences[0];
  return {
    logicalItemId: packageData.item.logicalItemId,
    module: packageData.item.module,
    title: packageData.item.title,
    sourceLabel: occurrence?.sourceLabel ?? packageData.item.firstSeenSourceLabel,
    occurrenceDate: occurrence?.occurrenceDate ?? packageData.item.firstSeenDate,
    sourceModule: occurrence?.sourceModule ?? "",
    sourceOrder: occurrence?.sourceOrder ?? packageData.item.firstSeenSourceOrder,
    sourceQuestionRange: occurrence
      ? questionRange(occurrence.sourceQuestionStart, occurrence.sourceQuestionEnd)
      : "",
    fields: readingPreviewFields(packageData)
  };
}

function readingPreviewFields(packageData: ReadingImportPackage) {
  const fields: Array<{ label: string; value: string }> = [];
  const material = packageData.materials[0];
  const passage = packageData.passages[0];
  if (material) {
    fields.push({ label: "Material", value: [material.title, material.source].filter(Boolean).join(" · ") });
  }
  if (passage) {
    fields.push({
      label: "Passage",
      value: `${passage.title}\n${passage.paragraphs.map((paragraph) => paragraph.text).join("\n\n")}`
    });
  }
  if (packageData.item.module === "ctw") {
    const question = packageData.questions[0];
    if (question?.questionType === "ctw") {
      fields.push({
        label: "Content",
        value: question.payload.paragraphs.map((paragraph) => paragraph.rawText).join("\n\n")
      });
      fields.push({
        label: "Blanks",
        value: question.payload.slots.map((slot) => `${slot.slotOrder}. ${slot.displayText} → ${slot.answer}`).join("\n")
      });
    }
  } else {
    fields.push({
      label: "Questions",
      value: packageData.questions.map(questionPreviewText).join("\n\n")
    });
  }
  return fields;
}

function questionPreviewText(question: ReadingQuestion) {
  const heading = `${question.questionOrder}. ${question.stem}`;
  if (question.questionType === "rdl" || question.questionType === "rap_multiple_choice") {
    return [
      heading,
      ...question.payload.options.map((option) =>
        `${option.optionOrder}. ${option.text}${option.optionId === question.payload.correctOptionId ? " ✓" : ""}`
      )
    ].join("\n");
  }
  if (question.questionType === "rap_sentence_insertion") {
    return `${heading}\nInsert: ${question.payload.insertSentence}`;
  }
  if (question.questionType === "rap_sentence_selection") {
    return `${heading}\nCorrect sentence: ${question.payload.correctSentenceId}`;
  }
  return heading;
}

async function loadCandidateOccurrences(
  supabase: ImporterContext["supabase"],
  logicalItemIds: string[]
) {
  const result = new Map<string, CandidateOccurrence[]>();
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
      sourceQuestionRange: questionRange(Number(row.source_question_start), Number(row.source_question_end))
    };
    result.set(logicalItemId, [...(result.get(logicalItemId) ?? []), occurrence]);
  }
  return result;
}

function sourceOccurrencePreview(occurrence: ReadingImportPackage["occurrences"][number]) {
  return {
    sourceLabel: occurrence.sourceLabel,
    occurrenceDate: occurrence.occurrenceDate,
    sourceModule: occurrence.sourceModule,
    sourceOrder: occurrence.sourceOrder,
    sourceQuestionRange: questionRange(occurrence.sourceQuestionStart, occurrence.sourceQuestionEnd)
  };
}

function questionRange(start: number, end: number) {
  return start === end ? String(start) : `${start}–${end}`;
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
