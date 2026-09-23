import { createHash } from "node:crypto";
import { asReadingAssetObjectKey, readingRdlObjectKeys } from "./assets.ts";
import { groupReadingSourceOccurrences } from "./grouping.ts";
import type {
  CtwParagraph,
  CtwSlot,
  ReadingInsertionAnchor,
  ReadingMaterial,
  ReadingOption,
  ReadingPassageHighlightRange,
  ReadingPassageParagraph,
  ReadingSourceOccurrenceCandidate,
  ReadingSourceQuestion
} from "./types.ts";
import { validateReadingImportPackage } from "./validation.ts";
import type { ReadingCsvType } from "./csvSchemas.ts";
import { isRdlMaterialType } from "./materialTypes.ts";
import { reconcileIncomingRdlTitle } from "./rdlTitles.ts";
import { stripRapSentenceSelectionInstruction } from "./reviewDiff.ts";

export type ReadingCsvFailure = {
  rowNumber: number;
  sourceLabel: string;
  sourceGroupId: string;
  reason: string;
};

export type ReadingCsvAdapterResult = {
  candidates: ReadingSourceOccurrenceCandidate[];
  failures: ReadingCsvFailure[];
};

export function readingCsvOccurrenceId(input: {
  type: ReadingCsvType;
  sourceLabel: string;
  sourceModule: string;
  sourceOrder: number;
  sourceGroupId: string;
}) {
  return `reading-csv-occ-${hash([
    input.type,
    input.sourceLabel,
    input.sourceModule,
    input.sourceOrder,
    input.sourceGroupId
  ].join("\u001f")).slice(0, 32)}`;
}

export function adaptReadingCsv(input: {
  type: ReadingCsvType;
  rows: Array<Record<string, string>>;
  sourceFile: string;
  materials?: Map<string, ReadingMaterial>;
  allowRegisteredMaterialStorageKeys?: boolean;
}): ReadingCsvAdapterResult {
  const grouped = groupRows(input.rows);
  const candidates: ReadingSourceOccurrenceCandidate[] = [];
  const failures: ReadingCsvFailure[] = [];
  const sourceIdentities = new Map<string, string>();

  for (const group of grouped) {
    try {
      const candidate = buildCandidate(
        input.type,
        group.rows,
        input.sourceFile,
        input.materials,
        input.allowRegisteredMaterialStorageKeys
      );
      const identity = [
        candidate.source.sourceKind,
        candidate.source.sourceLabel,
        candidate.source.sourceModule,
        candidate.source.sourceOrder
      ].join("\u001f");
      const prior = sourceIdentities.get(identity);
      if (prior && prior !== group.groupId) {
        throw new Error(`source identity is already used by group ${prior}`);
      }
      sourceIdentities.set(identity, group.groupId);
      const packageData = groupReadingSourceOccurrences([candidate]).packages[0];
      validateReadingImportPackage(packageData);
      candidates.push(candidate);
    } catch (error) {
      failures.push({
        rowNumber: group.firstRowNumber,
        sourceLabel: group.rows[0]?.source_label?.trim() ?? "",
        sourceGroupId: group.groupId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { candidates, failures };
}

type RowGroup = {
  groupId: string;
  firstRowNumber: number;
  rows: Array<Record<string, string> & { __rowNumber: string }>;
};

function groupRows(rows: Array<Record<string, string>>): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  rows.forEach((sourceRow, index) => {
    const row: Record<string, string> & { __rowNumber: string } = {
      ...sourceRow,
      __rowNumber: String(index + 2)
    };
    const sourceLabel = row.source_label?.trim() ?? "";
    const sourceModule = row.source_module?.trim() ?? "";
    const sourceOrder = row.source_order?.trim() ?? "";
    const groupId = row.source_group_id?.trim() ?? "";
    const key = [sourceLabel, sourceModule, sourceOrder, groupId].join("\u001f");
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { groupId, firstRowNumber: index + 2, rows: [row] });
  });
  return Array.from(groups.values());
}

function buildCandidate(
  type: ReadingCsvType,
  rows: RowGroup["rows"],
  sourceFile: string,
  materials?: Map<string, ReadingMaterial>,
  allowRegisteredMaterialStorageKeys = false
): ReadingSourceOccurrenceCandidate {
  if (rows.length === 0) throw new Error("group contains no rows");
  const first = rows[0];
  const sourceLabel = required(first, "source_label");
  const occurrenceDate = validDate(required(first, "occurrence_date"));
  const yearMonth = required(first, "year_month");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth) || !occurrenceDate.startsWith(yearMonth)) {
    throw new Error("year_month must be YYYY-MM and match occurrence_date");
  }
  const sourceModule = required(first, "source_module");
  if (sourceModule !== "m1" && sourceModule !== "m2") {
    throw new Error('source_module must be "m1" or "m2"');
  }
  const validatedSourceModule: "m1" | "m2" = sourceModule;
  const sourceOrder = positiveInteger(required(first, "source_order"), "source_order");
  const sourceGroupId = required(first, "source_group_id");
  for (const row of rows.slice(1)) {
    for (const field of ["source_label", "occurrence_date", "year_month", "source_module", "source_order", "source_group_id"]) {
      if (required(row, field) !== required(first, field)) {
        throw new Error(`${field} conflicts within source group ${sourceGroupId}`);
      }
    }
  }
  const occurrenceId = readingCsvOccurrenceId({ type, sourceLabel, sourceModule, sourceOrder, sourceGroupId });
  const sourceQuestionFile = `csv:${sourceFile.trim() || "reading.csv"}`;

  if (type === "complete_the_words") {
    if (rows.length !== 1) throw new Error("Complete the Words requires exactly one row per full item");
    const title = optional(first, "title") || null;
    const start = positiveInteger(required(first, "source_question_start"), "source_question_start");
    const end = positiveInteger(required(first, "source_question_end"), "source_question_end");
    const question: ReadingSourceQuestion = {
      questionId: temporaryId(occurrenceId, "q", 1),
      questionOrder: 1,
      questionType: "ctw",
      stem: required(first, "question_stem"),
      rawDisplayText: optional(first, "raw_display_text"),
      sourceQuestionStart: start,
      sourceQuestionEnd: end,
      payload: {
        paragraphs: parseJson<CtwParagraph[]>(required(first, "passage_json"), "passage_json"),
        slots: parseJson<CtwSlot[]>(required(first, "slots_json"), "slots_json")
      }
    };
    return baseCandidate("ctw", title, [], [], [question], start, end);
  }

  const orderedRows = [...rows].sort((left, right) =>
    positiveInteger(required(left, "question_order"), "question_order") -
    positiveInteger(required(right, "question_order"), "question_order")
  );
  const questionNumbers = orderedRows.map((row) =>
    positiveInteger(required(row, "source_question_number"), "source_question_number")
  );
  const sourceStart = Math.min(...questionNumbers);
  const sourceEnd = Math.max(...questionNumbers);

  if (type === "read_in_daily_life") {
    const materialId = required(first, "material_id");
    if (!/^RDL-\d{3}$/.test(materialId)) {
      throw new Error(`material_id must be a canonical ID such as RDL-084; received ${materialId}`);
    }
    const material = materials?.get(materialId);
    if (!material) throw new Error(`material_id ${materialId} does not exist in reading_materials`);
    validateProductionMaterial(material, allowRegisteredMaterialStorageKeys);
    const materialType = required(first, "material_type");
    if (!isRdlMaterialType(materialType)) {
      throw new Error(`unsupported material_type ${materialType}`);
    }
    const title = reconcileIncomingRdlTitle(
      optional(first, "title"),
      material.title,
      `RDL title for ${materialId}`
    );
    const questions: ReadingSourceQuestion[] = orderedRows.map((row, index) => {
      if (required(row, "material_id") !== materialId
        || required(row, "material_type") !== materialType
        || reconcileIncomingRdlTitle(optional(row, "title"), material.title, `RDL title for ${materialId}`) !== title) {
        throw new Error(`material_id/material_type/title conflicts within source group ${sourceGroupId}`);
      }
      const sourceNumber = positiveInteger(required(row, "source_question_number"), "source_question_number");
      return {
        questionId: temporaryId(occurrenceId, "q", index + 1),
        questionOrder: positiveInteger(required(row, "question_order"), "question_order"),
        questionType: "rdl",
        stem: required(row, "question_stem"),
        rawDisplayText: optional(row, "raw_display_text"),
        sourceQuestionStart: sourceNumber,
        sourceQuestionEnd: sourceNumber,
        payload: {
          materialId,
          options: parseJson<ReadingOption[]>(required(row, "options_json"), "options_json"),
          correctOptionId: required(row, "correct_option_id")
        }
      };
    });
    // Preserve the source-declared type in the incoming package. A mismatch
    // with the registered canonical material is resolved by the explicit
    // Reading content-review flow, not rejected during CSV adaptation.
    return baseCandidate(
      "rdl",
      title,
      [{ ...material, title, materialType }],
      [],
      questions,
      sourceStart,
      sourceEnd
    );
  }

  const passageId = required(first, "passage_id");
  const passageTitle = required(first, "passage_title");
  const passageJson = parseJson<ReadingPassageParagraph[]>(required(first, "passage_json"), "passage_json");
  const passageSignature = JSON.stringify(passageJson);
  const questions: ReadingSourceQuestion[] = orderedRows.map((row, index) => {
    if (required(row, "passage_id") !== passageId || required(row, "passage_title") !== passageTitle) {
      throw new Error(`passage_id/title conflicts within source group ${sourceGroupId}`);
    }
    const rowPassage = parseJson<ReadingPassageParagraph[]>(required(row, "passage_json"), "passage_json");
    if (JSON.stringify(rowPassage) !== passageSignature) {
      throw new Error(`passage_json conflicts within source group ${sourceGroupId}`);
    }
    const sourceNumber = positiveInteger(required(row, "source_question_number"), "source_question_number");
    const common = {
      questionId: temporaryId(occurrenceId, "q", index + 1),
      questionOrder: positiveInteger(required(row, "question_order"), "question_order"),
      stem: required(row, "question_stem"),
      rawDisplayText: optional(row, "raw_display_text"),
      sourceQuestionStart: sourceNumber,
      sourceQuestionEnd: sourceNumber
    };
    const questionType = required(row, "question_type");
    const highlights = rapHighlights(row);
    if (questionType === "rap_multiple_choice") {
      return {
        ...common,
        questionType,
        payload: {
          passageId,
          highlightRanges: highlights.ranges,
          highlightRangesAuthoritative: highlights.authoritative,
          options: parseJson<ReadingOption[]>(required(row, "options_json"), "options_json"),
          correctOptionId: required(row, "correct_option_id")
        }
      };
    }
    if (questionType === "rap_sentence_insertion") {
      return {
        ...common,
        questionType,
        payload: {
          passageId,
          highlightRanges: highlights.ranges,
          highlightRangesAuthoritative: highlights.authoritative,
          insertSentence: required(row, "insert_sentence"),
          anchors: parseJson<ReadingInsertionAnchor[]>(
            required(row, "insertion_anchors_json"),
            "insertion_anchors_json"
          ),
          correctAnchorId: required(row, "correct_anchor_id")
        }
      };
    }
    if (questionType === "rap_sentence_selection") {
      const semanticStem = stripRapSentenceSelectionInstruction(common.stem);
      return {
        ...common,
        stem: semanticStem,
        rawDisplayText: common.rawDisplayText ?? (semanticStem === common.stem ? null : common.stem),
        questionType,
        payload: {
          passageId,
          highlightRanges: highlights.ranges,
          highlightRangesAuthoritative: highlights.authoritative,
          targetParagraphId: required(row, "target_paragraph_id"),
          correctSentenceId: required(row, "correct_sentence_id")
        }
      };
    }
    throw new Error(`unsupported RAP question_type ${questionType}`);
  });
  return baseCandidate(
    "rap",
    passageTitle,
    [],
    [{ passageId, title: passageTitle, paragraphs: passageJson }],
    questions,
    sourceStart,
    sourceEnd
  );

  function baseCandidate(
    module: "ctw" | "rdl" | "rap",
    title: string | null,
    declaredMaterials: ReadingMaterial[],
    passages: ReadingSourceOccurrenceCandidate["passages"],
    questions: ReadingSourceQuestion[],
    sourceQuestionStart: number,
    sourceQuestionEnd: number
  ): ReadingSourceOccurrenceCandidate {
    return {
      sourceOccurrenceId: occurrenceId,
      module,
      title,
      source: {
        sourceKind: "reading_csv",
        sourceLabel,
        occurrenceDate,
        yearMonth,
        sourceQuestionFile,
        sourceAnswerFile: sourceQuestionFile,
        sourceModule: validatedSourceModule,
        sourceOrder,
        sourceQuestionStart,
        sourceQuestionEnd
      },
      materials: declaredMaterials,
      passages,
      questions
    };
  }
}

function validateProductionMaterial(
  material: ReadingMaterial,
  allowRegisteredMaterialStorageKeys: boolean
) {
  if (material.bindingStatus !== "bound") {
    throw new Error(`material_id ${material.materialId} is not production-ready (binding_status=${material.bindingStatus})`);
  }
  if (!material.imageAssetPath || !material.hitboxDataPath) {
    throw new Error(`material_id ${material.materialId} is missing production object references`);
  }
  if (!material.materialType) {
    throw new Error(`material_id ${material.materialId} is missing canonical material_type`);
  }
  asReadingAssetObjectKey(material.imageAssetPath);
  asReadingAssetObjectKey(material.hitboxDataPath);
  const expected = readingRdlObjectKeys(material.materialId);
  if (material.imageAssetPath !== expected.imageObjectKey || material.hitboxDataPath !== expected.selectionMapObjectKey) {
    if (allowRegisteredMaterialStorageKeys && isVersionedCanonicalMaterialPair(material)) return;
    throw new Error(`material_id ${material.materialId} does not use the frozen production object-key convention`);
  }
}

function rapHighlights(row: Record<string, string>): {
  ranges: ReadingPassageHighlightRange[];
  authoritative: boolean;
} {
  if (!Object.prototype.hasOwnProperty.call(row, "passage_highlights_json")) {
    return { ranges: [], authoritative: false };
  }
  const parsed = parseJson<unknown>(required(row, "passage_highlights_json"), "passage_highlights_json");
  if (!Array.isArray(parsed)) throw new Error("passage_highlights_json must contain a JSON array");
  return {
    authoritative: true,
    // The source may include a redundant `text` audit value. TPS persists only
    // the established offset-based range contract.
    ranges: parsed.map((value) => {
      const range = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      return {
        paragraphId: range.paragraphId as string,
        startOffset: range.startOffset as number,
        endOffset: range.endOffset as number
      };
    })
  };
}

function isVersionedCanonicalMaterialPair(material: ReadingMaterial) {
  const prefix = `reading/rdl/${material.materialId}/`;
  const imagePath = material.imageAssetPath ?? "";
  const hitboxPath = material.hitboxDataPath ?? "";
  const imageDirectory = imagePath.slice(0, imagePath.lastIndexOf("/"));
  const hitboxDirectory = hitboxPath.slice(0, hitboxPath.lastIndexOf("/"));
  return imagePath.startsWith(prefix)
    && hitboxPath.startsWith(prefix)
    && imageDirectory === hitboxDirectory
    && imagePath.endsWith("/material_final.png")
    && hitboxPath.endsWith("/selection_map.json");
}

function required(row: Record<string, string>, field: string) {
  const value = row[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`);
  return value.trim();
}

function optional(row: Record<string, string>, field: string) {
  const value = row[field]?.trim();
  return value ? value : null;
}

function positiveInteger(value: string, field: string) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("occurrence_date must use YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("occurrence_date is not a valid calendar date");
  }
  return value;
}

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${field} must contain valid JSON`);
  }
}

function temporaryId(occurrenceId: string, kind: string, order: number) {
  return `${occurrenceId}-${kind}-${String(order).padStart(2, "0")}`;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
