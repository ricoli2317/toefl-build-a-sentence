import { adaptReadingCsv } from "@/lib/reading/csvAdapter";
import type { ReadingCsvType } from "@/lib/reading/csvSchemas";
import { groupReadingSourceOccurrences } from "@/lib/reading/grouping";
import {
  assertPreparedReadingPackageCanImport,
  importReadingPackageAtomic,
  prepareReadingPackagesForImport
} from "@/lib/reading/importer";
import type { ReadingMaterial } from "@/lib/reading/types";
import { isRdlMaterialType } from "@/lib/reading/materialTypes";
import type { ImporterContext, ImportResult } from "./types";

export function readingCsvImporter(type: ReadingCsvType) {
  return (context: ImporterContext) => importReadingCsv(context, type);
}

async function importReadingCsv(
  { rows, supabase, userId, fileName, dryRun }: ImporterContext,
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
  const preparedSourceSets = preparedPackages.map((prepared) =>
    new Set(prepared.packageData.occurrences.map((occurrence) => occurrence.sourceLabel))
  );
  const logicalWarnings = preparedPackages.flatMap((prepared) => {
    const warnings = prepared.possibleDuplicateLogicalItemIds.length > 0
      ? [{
          message: "可能重复的 Reading 内容存在实质差异，需确认后才能导入。",
          operation: "check Reading possible duplicates",
          details: `module=${prepared.packageData.item.module}; existing=${prepared.possibleDuplicateLogicalItemIds.join(",")}; action=block pending review`
        }]
      : [];
    return warnings;
  });
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
  const groupedPossibleDuplicateWarnings = grouped.report.possibleDuplicates.filter((duplicate) =>
      !preparedSourceSets.some((sources) => duplicate.sourceOccurrences.every((source) => sources.has(source)))
    ).map((duplicate) => ({
      message: "可能重复的 Reading 内容需确认后才能导入。",
      operation: "check Reading possible duplicates",
      details: `${duplicate.reason}; sources=${duplicate.sourceOccurrences.join(", ")}; action=block pending review`
    }));
  const possibleDuplicateWarnings = [
    ...groupedPossibleDuplicateWarnings,
    ...logicalWarnings
  ];
  const warnings = [
    ...possibleDuplicateWarnings,
    ...materialWarnings,
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
  let occurrenceConflictCount = 0;
  let updatedCount = 0;
  let successCount = 0;

  for (const prepared of preparedPackages) {
    const { packageData, existingItem, addedOccurrenceCount } = prepared;
    try {
      if (possibleDuplicateWarnings.length > 0) {
        throw new Error("发现需确认的相似题；明确处理前不能导入为新题。");
      }
      assertPreparedReadingPackageCanImport(prepared);
      const existed = Boolean(existingItem);
      const incomingFirst = {
        date: packageData.item.firstSeenDate,
        sourceLabel: packageData.item.firstSeenSourceLabel,
        sourceOrder: packageData.item.firstSeenSourceOrder
      };
      const firstSeen = existingItem && compareFirstSeen(existingItem, incomingFirst) < 0
        ? existingItem
        : incomingFirst;
      if (!dryRun) {
        await importReadingPackageAtomic(supabase, packageData, { createdBy: userId, firstSeen });
      }
      successCount += 1;
      occurrenceInsertedCount += addedOccurrenceCount;
      existingOccurrenceCount += packageData.occurrences.length - addedOccurrenceCount;
      semanticReuseCount += prepared.batchSemanticReuseCount;
      if (existed) {
        reusedCount += 1;
        if (prepared.reuseKind === "semantic") semanticReuseCount += 1;
        else exactFingerprintReuseCount += 1;
        updatedCount += addedOccurrenceCount > 0 ? 1 : 0;
      } else {
        createdCount += 1;
      }
    } catch (error) {
      if (prepared.occurrenceConflict) occurrenceConflictCount += 1;
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
    logicalAutoMergeCount: reusedCount + preparedPackages.reduce(
      (count, item) => count + item.batchSemanticReuseCount,
      0
    ),
    logicalNeedsReviewCount: possibleDuplicateWarnings.length,
    possibleDuplicateCount: possibleDuplicateWarnings.length,
    occurrenceInsertedCount,
    exactFingerprintReuseCount,
    semanticReuseCount,
    existingOccurrenceCount,
    occurrenceConflictCount,
    rdlMaterialReuseCount: preparedPackages.filter((item) =>
      item.materialMatchKind === "exact_material" || item.materialMatchKind === "semantic_material"
    ).length,
    rdlNewMaterialCount: 0,
    rdlMaterialWarningCount: preparedPackages.filter(
      (item) => item.materialMatchKind === "possible_material_duplicate"
    ).length,
    failedCount: failedRows.length,
    failedRows,
    warnings
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
