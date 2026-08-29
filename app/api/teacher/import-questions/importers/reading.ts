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
  { rows, supabase, userId, fileName }: ImporterContext,
  type: ReadingCsvType
): Promise<ImportResult> {
  const materialCatalog = type === "read_in_daily_life"
    ? await loadMaterials(supabase, rows)
    : undefined;
  const adapted = adaptReadingCsv({
    type,
    rows,
    sourceFile: fileName ?? "reading.csv",
    materials: materialCatalog
  });
  const grouped = groupReadingSourceOccurrences(adapted.candidates);
  const preparedPackages = type === "complete_the_words"
    ? await prepareReadingPackagesForImport(supabase, grouped.packages, {
        enableCtwFingerprintFallback: true
      })
    : await prepareStandardReadingPackages(supabase, grouped.packages);
  const historicalWarnings = await historicalPossibleDuplicates(
    supabase,
    type,
    preparedPackages.map(({ packageData }) => packageData)
  );
  const warnings = [
    ...grouped.report.possibleDuplicates.map((duplicate) => ({
      message: "可能重复的 Reading 内容已按独立题组保留，没有自动合并。",
      operation: "check Reading possible duplicates",
      details: `${duplicate.reason}; sources=${duplicate.sourceOccurrences.join(", ")}; action=preserve as new`
    })),
    ...historicalWarnings
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
  let updatedCount = 0;
  let successCount = 0;

  for (const prepared of preparedPackages) {
    const { packageData, existingItem, addedOccurrenceCount } = prepared;
    try {
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
      await importReadingPackageAtomic(supabase, packageData, { createdBy: userId, firstSeen });
      successCount += 1;
      occurrenceInsertedCount += addedOccurrenceCount;
      if (existed) {
        reusedCount += 1;
        updatedCount += addedOccurrenceCount > 0 ? 1 : 0;
      } else {
        createdCount += 1;
      }
    } catch (error) {
      failedRows.push({
        rowNumber: sourceRowNumber(rows, packageData.occurrences[0]?.sourceLabel),
        questionId: packageData.occurrences[0]?.occurrenceId ?? packageData.item.logicalItemId,
        setId: packageData.occurrences[0]?.sourceLabel,
        reason: error instanceof Error ? error.message : String(error),
        operation: "import Reading group atomically"
      });
    }
  }

  return {
    success: true,
    successCount,
    insertedCount: createdCount,
    updatedCount,
    logicalNewItemCount: createdCount,
    logicalAutoMergeCount: reusedCount,
    logicalNeedsReviewCount: 0,
    possibleDuplicateCount: warnings.length,
    occurrenceInsertedCount,
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
    .select("material_id,title,material_type,source,source_date,year_month,binding_status,image_asset_path,hitbox_data_path")
    .in("material_id", ids);
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

async function prepareStandardReadingPackages(
  supabase: ImporterContext["supabase"],
  packages: ReturnType<typeof groupReadingSourceOccurrences>["packages"]
) {
  const logicalIds = packages.map((item) => item.item.logicalItemId);
  const occurrenceIds = packages.flatMap((item) =>
    item.occurrences.map((occurrence) => occurrence.occurrenceId)
  );
  const existingLogicalItems = await loadExistingLogicalItems(supabase, logicalIds);
  const existingOccurrenceIds = await existingIds(
    supabase,
    "reading_source_occurrences",
    "occurrence_id",
    occurrenceIds
  );
  return packages.map((packageData) => ({
    packageData,
    existingItem: existingLogicalItems.get(packageData.item.logicalItemId) ?? null,
    addedOccurrenceCount: packageData.occurrences.filter(
      (occurrence) => !existingOccurrenceIds.has(occurrence.occurrenceId)
    ).length,
    occurrenceConflict: null
  }));
}

async function existingIds(
  supabase: ImporterContext["supabase"],
  table: string,
  column: string,
  ids: string[]
) {
  if (ids.length === 0) return new Set<string>();
  const { data, error } = await supabase.from(table).select(column).in(column, ids);
  if (error) throw new Error(`read existing ${table}: ${error.message}`);
  return new Set((data ?? []).map((row) => String((row as unknown as Record<string, unknown>)[column])));
}

async function loadExistingLogicalItems(
  supabase: ImporterContext["supabase"],
  ids: string[]
) {
  type FirstSeen = { date: string; sourceLabel: string; sourceOrder: number };
  if (ids.length === 0) return new Map<string, FirstSeen>();
  const { data, error } = await supabase
    .from("reading_logical_items")
    .select("logical_item_id,first_seen_date,first_seen_source_label,first_seen_source_order")
    .in("logical_item_id", ids);
  if (error) throw new Error(`read existing reading_logical_items: ${error.message}`);
  return new Map((data ?? []).map((row) => [String(row.logical_item_id), {
    date: String(row.first_seen_date),
    sourceLabel: String(row.first_seen_source_label),
    sourceOrder: Number(row.first_seen_source_order)
  }]));
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

async function historicalPossibleDuplicates(
  supabase: ImporterContext["supabase"],
  type: ReadingCsvType,
  packages: ReturnType<typeof groupReadingSourceOccurrences>["packages"]
) {
  if (packages.length === 0) return [];
  if (type === "complete_the_words") {
    const { data: questions, error: questionError } = await supabase
      .from("reading_questions")
      .select("question_id,logical_item_id")
      .eq("module", "ctw");
    if (questionError) throw new Error(`check Reading possible duplicates: ${questionError.message}`);
    const questionIds = (questions ?? []).map((row) => String(row.question_id));
    if (questionIds.length === 0) return [];
    const { data: paragraphs, error: paragraphError } = await supabase
      .from("reading_ctw_paragraphs")
      .select("question_id,paragraph_order,raw_text")
      .in("question_id", questionIds);
    if (paragraphError) throw new Error(`check Reading possible duplicates: ${paragraphError.message}`);
    const logicalByQuestion = new Map((questions ?? []).map((row) => [String(row.question_id), String(row.logical_item_id)]));
    const historic = new Map<string, Array<{ order: number; text: string }>>();
    for (const row of paragraphs ?? []) {
      const id = logicalByQuestion.get(String(row.question_id));
      if (!id) continue;
      historic.set(id, [
        ...(historic.get(id) ?? []),
        { order: Number(row.paragraph_order), text: String(row.raw_text) }
      ]);
    }
    const incomingIds = new Set(packages.map((item) => item.item.logicalItemId));
    const incomingKeys = new Set(packages.map((item) => ctwPassageKey(item)));
    return Array.from(historic.entries())
      .filter(([id, paragraphs]) => !incomingIds.has(id) && incomingKeys.has(normalizedTexts(
        [...paragraphs].sort((left, right) => left.order - right.order).map((item) => item.text)
      )))
      .map(([id]) => ({
        message: "可能重复的 Complete the Words 内容已按新题保留。",
        operation: "check Reading possible duplicates",
        details: `same CTW source passage, existing=${id}, action=preserve as new`
      }));
  }
  if (type === "read_in_daily_life") {
    const materialIds = Array.from(new Set(packages.flatMap((item) => item.materials.map((material) => material.materialId))));
    const { data, error } = await supabase
      .from("reading_questions")
      .select("logical_item_id,material_id")
      .in("material_id", materialIds);
    if (error) throw new Error(`check Reading possible duplicates: ${error.message}`);
    const incomingIds = new Set(packages.map((item) => item.item.logicalItemId));
    const unique = new Map((data ?? [])
      .filter((row) => !incomingIds.has(String(row.logical_item_id)))
      .map((row) => [`${String(row.logical_item_id)}:${String(row.material_id)}`, row]));
    return Array.from(unique.values()).map((row) => ({
        message: "可能重复的 Read in Daily Life 题组已按新题保留。",
        operation: "check Reading possible duplicates",
        details: `same canonical material ${String(row.material_id)}, existing=${String(row.logical_item_id)}, action=preserve as new`
      }));
  }
  const titles = Array.from(new Set(packages.map((item) => item.item.title).filter(Boolean))) as string[];
  const { data, error } = await supabase
    .from("reading_passages")
    .select("passage_id,logical_item_id,title")
    .in("title", titles);
  if (error) throw new Error(`check Reading possible duplicates: ${error.message}`);
  const incomingIds = new Set(packages.map((item) => item.item.logicalItemId));
  const passages = (data ?? []).filter((row) => !incomingIds.has(String(row.logical_item_id)));
  if (passages.length === 0) return [];
  const passageIds = passages.map((row) => String(row.passage_id));
  const { data: paragraphs, error: paragraphError } = await supabase
    .from("reading_passage_paragraphs")
    .select("passage_id,paragraph_order,paragraph_text")
    .in("passage_id", passageIds);
  if (paragraphError) throw new Error(`check Reading possible duplicates: ${paragraphError.message}`);
  const paragraphByPassage = new Map<string, Array<{ order: number; text: string }>>();
  for (const row of paragraphs ?? []) {
    const id = String(row.passage_id);
    paragraphByPassage.set(id, [
      ...(paragraphByPassage.get(id) ?? []),
      { order: Number(row.paragraph_order), text: String(row.paragraph_text) }
    ]);
  }
  const incomingKeys = new Set(packages.map((item) => rapPassageKey(item)));
  return passages
    .filter((row) => incomingKeys.has(normalizedTexts([
      String(row.title),
      ...(paragraphByPassage.get(String(row.passage_id)) ?? [])
        .sort((left, right) => left.order - right.order)
        .map((item) => item.text)
    ])))
    .map((row) => ({
      message: "可能重复的 Read an Academic Passage 题组已按新题保留。",
      operation: "check Reading possible duplicates",
      details: `same complete passage, existing=${String(row.logical_item_id)}, action=preserve as new`
    }));
}

function ctwPassageKey(packageData: ReturnType<typeof groupReadingSourceOccurrences>["packages"][number]) {
  const question = packageData.questions[0];
  return question?.questionType === "ctw"
    ? normalizedTexts(question.payload.paragraphs.map((paragraph) => paragraph.rawText))
    : "";
}

function normalizedTexts(values: string[]) {
  return values.map((value) => value.normalize("NFKC").replace(/\s+/g, " ").trim()).join("\u001f");
}

function rapPassageKey(packageData: ReturnType<typeof groupReadingSourceOccurrences>["packages"][number]) {
  const passage = packageData.passages[0];
  return passage
    ? normalizedTexts([passage.title, ...passage.paragraphs.map((paragraph) => paragraph.text)])
    : "";
}

function sourceRowNumber(rows: Array<Record<string, string>>, sourceLabel?: string) {
  const index = rows.findIndex((row) => row.source_label?.trim() === sourceLabel);
  return index < 0 ? 2 : index + 2;
}
