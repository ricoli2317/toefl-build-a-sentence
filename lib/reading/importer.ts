import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReadingImportPackage, ReadingModule, ReadingQuestion } from "./types.ts";
import { validateReadingImportPackage } from "./validation.ts";
import { assertCanonicalRdlTitle } from "./rdlTitles.ts";

export type ReadingImportResult = {
  logicalItemId: string;
  occurrenceCount: number;
  questionCount: number;
  insertedQuestionCount: number;
  updatedQuestionCount: number;
  pendingMaterialIds: string[];
};

export class ReadingImportError extends Error {
  readonly operation: string;
  readonly logicalItemId: string;
  readonly questionId: string | null;
  readonly cause: unknown;

  constructor(input: {
    message: string;
    operation: string;
    logicalItemId: string;
    questionId?: string;
    cause?: unknown;
  }) {
    super(
      `item=${input.logicalItemId}${input.questionId ? ` question=${input.questionId}` : ""} ` +
        `${input.operation}: ${input.message}`
    );
    this.name = "ReadingImportError";
    this.operation = input.operation;
    this.logicalItemId = input.logicalItemId;
    this.questionId = input.questionId ?? null;
    this.cause = input.cause;
  }
}

export function buildReadingImportRows(input: unknown) {
  const packageData = validateReadingImportPackage(input);
  validateCanonicalRdlTitles(packageData);
  return buildReadingImportRowsUnchecked(packageData);
}

export async function importReadingPackage(
  supabase: SupabaseClient,
  input: unknown,
  options: { createdBy?: string } = {}
): Promise<ReadingImportResult> {
  const packageData = validateReadingImportPackage(input);
  validateCanonicalRdlTitles(packageData);
  const rows = buildReadingImportRowsUnchecked(packageData, options.createdBy);
  const logicalItemId = packageData.item.logicalItemId;
  const questionIds = packageData.questions.map((question) => question.questionId);
  const existingQuestionIds = new Set<string>();

  if (questionIds.length > 0) {
    const { data, error } = await supabase
      .from("reading_questions")
      .select("question_id")
      .in("question_id", questionIds);
    if (error) throw databaseError(error, "read existing question IDs", logicalItemId);
    for (const row of data ?? []) existingQuestionIds.add(String(row.question_id));
  }

  // Asset references are owned by the independent R2 publishing release. Once a
  // canonical material exists, re-importing historical question packages must not
  // replace production object keys with the package's retained local QA paths.
  await upsertRows(
    supabase,
    "reading_materials",
    rows.reading_materials,
    "material_id",
    logicalItemId,
    undefined,
    true
  );
  await upsertRows(supabase, "reading_logical_items", rows.reading_logical_items, "logical_item_id", logicalItemId);
  await upsertRows(supabase, "reading_source_occurrences", rows.reading_source_occurrences, "occurrence_id", logicalItemId);
  await upsertRows(supabase, "reading_passages", rows.reading_passages, "passage_id", logicalItemId);
  await upsertRows(
    supabase,
    "reading_passage_paragraphs",
    rows.reading_passage_paragraphs,
    "passage_id,paragraph_id",
    logicalItemId
  );
  await upsertRows(
    supabase,
    "reading_passage_sentences",
    rows.reading_passage_sentences,
    "passage_id,sentence_id",
    logicalItemId
  );

  for (const question of packageData.questions) {
    const questionId = question.questionId;
    await upsertRows(
      supabase,
      "reading_questions",
      rows.reading_questions.filter((row) => row.question_id === questionId),
      "question_id",
      logicalItemId,
      questionId
    );
    await upsertRows(
      supabase,
      "reading_question_options",
      rows.reading_question_options.filter((row) => row.question_id === questionId),
      "question_id,option_id",
      logicalItemId,
      questionId
    );
    await upsertRows(
      supabase,
      "reading_ctw_paragraphs",
      rows.reading_ctw_paragraphs.filter((row) => row.question_id === questionId),
      "question_id,paragraph_id",
      logicalItemId,
      questionId
    );
    await upsertRows(
      supabase,
      "reading_ctw_slots",
      rows.reading_ctw_slots.filter((row) => row.question_id === questionId),
      "question_id,slot_id",
      logicalItemId,
      questionId
    );
    await upsertRows(
      supabase,
      "reading_ctw_segments",
      rows.reading_ctw_segments.filter((row) => row.question_id === questionId),
      "question_id,paragraph_id,segment_order",
      logicalItemId,
      questionId
    );
    await upsertRows(
      supabase,
      "reading_rap_insertion_anchors",
      rows.reading_rap_insertion_anchors.filter((row) => row.question_id === questionId),
      "question_id,anchor_id",
      logicalItemId,
      questionId
    );
  }
  await upsertRows(
    supabase,
    "reading_question_occurrences",
    rows.reading_question_occurrences,
    "occurrence_id,question_id",
    logicalItemId
  );

  const updatedQuestionCount = questionIds.filter((id) => existingQuestionIds.has(id)).length;
  return {
    logicalItemId,
    occurrenceCount: packageData.occurrences.length,
    questionCount: questionIds.length,
    insertedQuestionCount: questionIds.length - updatedQuestionCount,
    updatedQuestionCount,
    pendingMaterialIds: packageData.materials
      .filter((material) => material.bindingStatus === "pending")
      .map((material) => material.materialId)
  };
}

/**
 * CSV imports use one PostgreSQL RPC so a complete Reading logical group is one
 * transaction. The historical migration importer above remains unchanged.
 */
export async function importReadingPackageAtomic(
  supabase: SupabaseClient,
  input: unknown,
  options: {
    createdBy?: string;
    firstSeen?: {
      date: string;
      sourceLabel: string;
      sourceOrder: number;
    };
  } = {}
): Promise<ReadingImportResult> {
  const packageData = validateReadingImportPackage(input);
  validateCanonicalRdlTitles(packageData);
  const rows = buildReadingImportRowsUnchecked(packageData, options.createdBy);
  if (options.firstSeen) {
    rows.reading_logical_items[0].first_seen_date = options.firstSeen.date;
    rows.reading_logical_items[0].first_seen_source_label = options.firstSeen.sourceLabel;
    rows.reading_logical_items[0].first_seen_source_order = options.firstSeen.sourceOrder;
  }
  const logicalItemId = packageData.item.logicalItemId;
  const { data, error } = await supabase.rpc("import_reading_package_atomic", {
    p_rows: rows,
    p_created_by: options.createdBy ?? null
  });
  if (error) throw databaseError(error, "import Reading group atomically", logicalItemId);
  const result = (data ?? {}) as Record<string, unknown>;
  return {
    logicalItemId,
    occurrenceCount: packageData.occurrences.length,
    questionCount: packageData.questions.length,
    insertedQuestionCount: Number(result.inserted_question_count ?? 0),
    updatedQuestionCount: Number(result.updated_question_count ?? 0),
    pendingMaterialIds: []
  };
}

function validateCanonicalRdlTitles(packageData: ReadingImportPackage) {
  if (packageData.item.module !== "rdl") return;
  const itemTitle = assertCanonicalRdlTitle(packageData.item.title ?? "", "RDL logical item title");
  const materialTitle = assertCanonicalRdlTitle(
    packageData.materials[0]?.title ?? "",
    `RDL material title for ${packageData.materials[0]?.materialId ?? "unknown material"}`
  );
  if (itemTitle !== materialTitle) {
    throw new Error("RDL logical item title must match its canonical material title");
  }
}

function buildReadingImportRowsUnchecked(
  packageData: ReadingImportPackage,
  createdBy?: string
) {
  const itemRow = {
    logical_item_id: packageData.item.logicalItemId,
    module: packageData.item.module,
    title: packageData.item.title,
    first_seen_date: packageData.item.firstSeenDate,
    first_seen_source_label: packageData.item.firstSeenSourceLabel,
    first_seen_source_order: packageData.item.firstSeenSourceOrder,
    dedup_fingerprint: packageData.item.dedupFingerprint,
    question_count: packageData.item.questionCount,
    scored_item_count: packageData.item.scoredItemCount,
    is_active: packageData.item.isActive,
    ...(createdBy ? { created_by: createdBy } : {})
  };
  const passageParagraphs = packageData.passages.flatMap((passage) =>
    passage.paragraphs.map((paragraph) => ({
      passage_id: passage.passageId,
      paragraph_id: paragraph.paragraphId,
      paragraph_order: paragraph.paragraphOrder,
      paragraph_text: paragraph.text,
      raw_text: paragraph.rawText
    }))
  );
  const passageSentences = packageData.passages.flatMap((passage) =>
    passage.paragraphs.flatMap((paragraph) =>
      paragraph.sentences.map((sentence) => ({
        passage_id: passage.passageId,
        paragraph_id: paragraph.paragraphId,
        sentence_id: sentence.sentenceId,
        sentence_order: sentence.sentenceOrder,
        sentence_text: sentence.text
      }))
    )
  );

  return {
    reading_logical_items: [itemRow],
    reading_source_occurrences: packageData.occurrences.map((occurrence) => ({
      occurrence_id: occurrence.occurrenceId,
      logical_item_id: occurrence.logicalItemId,
      source_kind: occurrence.sourceKind,
      source_label: occurrence.sourceLabel,
      occurrence_date: occurrence.occurrenceDate,
      year_month: occurrence.yearMonth,
      source_question_file: occurrence.sourceQuestionFile,
      source_answer_file: occurrence.sourceAnswerFile,
      source_module: occurrence.sourceModule,
      source_order: occurrence.sourceOrder,
      source_question_start: occurrence.sourceQuestionStart,
      source_question_end: occurrence.sourceQuestionEnd
    })),
    reading_question_occurrences: packageData.occurrences.flatMap((occurrence) =>
      occurrence.questionSources.map((mapping) => ({
        occurrence_id: occurrence.occurrenceId,
        logical_item_id: occurrence.logicalItemId,
        question_id: mapping.questionId,
        source_question_start: mapping.sourceQuestionStart,
        source_question_end: mapping.sourceQuestionEnd
      }))
    ),
    reading_materials: packageData.materials.map((material) => ({
      material_id: material.materialId,
      title: material.title,
      material_type: material.materialType,
      source: material.source,
      source_date: material.sourceDate,
      year_month: material.yearMonth,
      binding_status: material.bindingStatus,
      image_asset_path: material.imageAssetPath,
      hitbox_data_path: material.hitboxDataPath
    })),
    reading_passages: packageData.passages.map((passage) => ({
      passage_id: passage.passageId,
      logical_item_id: passage.logicalItemId,
      title: passage.title,
    })),
    reading_passage_paragraphs: passageParagraphs,
    reading_passage_sentences: passageSentences,
    reading_questions: packageData.questions.map(questionRow),
    reading_question_options: packageData.questions.flatMap((question) =>
      question.questionType === "rdl" || question.questionType === "rap_multiple_choice"
        ? question.payload.options.map((option) => ({
            question_id: question.questionId,
            option_id: option.optionId,
            option_order: option.optionOrder,
            option_text: option.text
          }))
        : []
    ),
    reading_ctw_paragraphs: packageData.questions.flatMap((question) =>
      question.questionType === "ctw"
        ? question.payload.paragraphs.map((paragraph) => ({
            question_id: question.questionId,
            paragraph_id: paragraph.paragraphId,
            paragraph_order: paragraph.paragraphOrder,
            raw_text: paragraph.rawText
          }))
        : []
    ),
    reading_ctw_slots: packageData.questions.flatMap((question) =>
      question.questionType === "ctw"
        ? question.payload.slots.map((slot) => ({
            question_id: question.questionId,
            slot_id: slot.slotId,
            slot_order: slot.slotOrder,
            paragraph_id: slot.paragraphId,
            answer: slot.answer,
            prefix: slot.prefix,
            display_text: slot.displayText,
            missing_text: slot.missingText,
            missing_length: slot.missingLength
          }))
        : []
    ),
    reading_ctw_segments: packageData.questions.flatMap((question) =>
      question.questionType === "ctw"
        ? question.payload.paragraphs.flatMap((paragraph) =>
            paragraph.segments.map((segment, index) => ({
              question_id: question.questionId,
              paragraph_id: paragraph.paragraphId,
              segment_order: index + 1,
              segment_type: segment.kind,
              text_content: segment.kind === "text" ? segment.text : null,
              slot_id: segment.kind === "blank" ? segment.slotId : null
            }))
          )
        : []
    ),
    reading_rap_insertion_anchors: packageData.questions.flatMap((question) =>
      question.questionType === "rap_sentence_insertion"
        ? question.payload.anchors.map((anchor) => ({
            question_id: question.questionId,
            passage_id: question.payload.passageId,
            anchor_id: anchor.anchorId,
            anchor_order: anchor.anchorOrder,
            paragraph_id: anchor.paragraphId,
            boundary_index: anchor.boundaryIndex,
            after_sentence_id: anchor.afterSentenceId
          }))
        : []
    )
  };
}

function questionRow(question: ReadingQuestion) {
  const base = {
    question_id: question.questionId,
    logical_item_id: question.logicalItemId,
    question_order: question.questionOrder,
    module: moduleFor(question),
    question_type: question.questionType,
    stem: question.stem,
    raw_display_text: question.rawDisplayText,
    passage_id: null as string | null,
    material_id: null as string | null,
    correct_option_id: null as string | null,
    insert_sentence: null as string | null,
    correct_anchor_id: null as string | null,
    target_paragraph_id: null as string | null,
    correct_sentence_id: null as string | null
  };
  switch (question.questionType) {
    case "ctw":
      return base;
    case "rdl":
      return {
        ...base,
        material_id: question.payload.materialId,
        correct_option_id: question.payload.correctOptionId
      };
    case "rap_multiple_choice":
      return {
        ...base,
        passage_id: question.payload.passageId,
        correct_option_id: question.payload.correctOptionId
      };
    case "rap_sentence_insertion":
      return {
        ...base,
        passage_id: question.payload.passageId,
        insert_sentence: question.payload.insertSentence,
        correct_anchor_id: question.payload.correctAnchorId
      };
    case "rap_sentence_selection":
      return {
        ...base,
        passage_id: question.payload.passageId,
        target_paragraph_id: question.payload.targetParagraphId,
        correct_sentence_id: question.payload.correctSentenceId
      };
  }
}

function moduleFor(question: ReadingQuestion): ReadingModule {
  if (question.questionType === "ctw") return "ctw";
  if (question.questionType === "rdl") return "rdl";
  return "rap";
}

async function upsertRows(
  supabase: SupabaseClient,
  table: string,
  rows: Array<Record<string, unknown>>,
  onConflict: string,
  logicalItemId: string,
  questionId?: string,
  ignoreDuplicates = false
) {
  if (rows.length === 0) return;
  const { error } = await supabase.from(table).upsert(rows, { onConflict, ignoreDuplicates });
  if (error) throw databaseError(error, `upsert ${table}`, logicalItemId, questionId);
}

function databaseError(
  cause: { message?: string },
  operation: string,
  logicalItemId: string,
  questionId?: string
) {
  return new ReadingImportError({
    message: cause.message ?? "Unknown database error",
    operation,
    logicalItemId,
    questionId,
    cause
  });
}
