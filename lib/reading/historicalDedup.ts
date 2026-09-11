import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ReadingImportPackage,
  ReadingMaterial,
  ReadingModule,
  ReadingPassage,
  ReadingQuestion
} from "./types.ts";

type Row = Record<string, unknown>;

/**
 * Loads Reading canonical content once per import batch. This is deliberately a
 * batched historical fallback: it never scans the library once per CSV row and
 * it does not rewrite the existing strict dedup_fingerprint column.
 */
export async function loadHistoricalReadingPackages(
  supabase: SupabaseClient,
  modules: ReadingModule[]
): Promise<ReadingImportPackage[]> {
  if (modules.length === 0) return [];
  const logicalRows = await selectIn(
    supabase,
    "reading_logical_items",
    "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,dedup_fingerprint,question_count,scored_item_count,is_active",
    "module",
    modules
  );
  const logicalIds = logicalRows.map((row) => text(row.logical_item_id));
  if (logicalIds.length === 0) return [];

  const [questionRows, passageRows] = await Promise.all([
    selectIn(
      supabase,
      "reading_questions",
      "question_id,logical_item_id,question_order,module,question_type,stem,raw_display_text,passage_highlight_ranges,passage_id,material_id,correct_option_id,insert_sentence,correct_anchor_id,target_paragraph_id,correct_sentence_id",
      "logical_item_id",
      logicalIds
    ),
    selectIn(supabase, "reading_passages", "passage_id,logical_item_id,title", "logical_item_id", logicalIds)
  ]);
  const questionIds = questionRows.map((row) => text(row.question_id));
  const passageIds = passageRows.map((row) => text(row.passage_id));
  const materialIds = Array.from(new Set(questionRows.map((row) => nullableText(row.material_id)).filter(Boolean))) as string[];

  const [optionRows, ctwParagraphRows, ctwSlotRows, ctwSegmentRows, anchorRows, paragraphRows, sentenceRows, materialRows] = await Promise.all([
    selectIn(supabase, "reading_question_options", "question_id,option_id,option_order,option_text", "question_id", questionIds),
    selectIn(supabase, "reading_ctw_paragraphs", "question_id,paragraph_id,paragraph_order,raw_text", "question_id", questionIds),
    selectIn(supabase, "reading_ctw_slots", "question_id,slot_id,slot_order,paragraph_id,answer,prefix,display_text,missing_text,missing_length", "question_id", questionIds),
    selectIn(supabase, "reading_ctw_segments", "question_id,paragraph_id,segment_order,segment_type,text_content,slot_id", "question_id", questionIds),
    selectIn(supabase, "reading_rap_insertion_anchors", "question_id,passage_id,anchor_id,anchor_order,paragraph_id,boundary_index,after_sentence_id", "question_id", questionIds),
    selectIn(supabase, "reading_passage_paragraphs", "passage_id,paragraph_id,paragraph_order,paragraph_text,raw_text", "passage_id", passageIds),
    selectIn(supabase, "reading_passage_sentences", "passage_id,paragraph_id,sentence_id,sentence_order,sentence_text", "passage_id", passageIds),
    selectIn(supabase, "reading_materials", "material_id,title,material_type,source,source_date,year_month,binding_status,image_asset_path,hitbox_data_path", "material_id", materialIds)
  ]);

  const optionsByQuestion = grouped(optionRows, "question_id");
  const ctwParagraphsByQuestion = grouped(ctwParagraphRows, "question_id");
  const ctwSlotsByQuestion = grouped(ctwSlotRows, "question_id");
  const ctwSegmentsByQuestion = grouped(ctwSegmentRows, "question_id");
  const anchorsByQuestion = grouped(anchorRows, "question_id");
  const paragraphsByPassage = grouped(paragraphRows, "passage_id");
  const sentencesByPassage = grouped(sentenceRows, "passage_id");
  const questionsByLogical = grouped(questionRows, "logical_item_id");
  const passagesByLogical = grouped(passageRows, "logical_item_id");
  const materialsById = new Map(materialRows.map((row) => [text(row.material_id), material(row)]));

  return logicalRows.map((logicalRow) => {
    const logicalItemId = text(logicalRow.logical_item_id);
    const passages = (passagesByLogical.get(logicalItemId) ?? [])
      .map((row) => passage(row, paragraphsByPassage, sentencesByPassage))
      .sort((left, right) => left.passageId.localeCompare(right.passageId));
    const passageById = new Map(passages.map((item) => [item.passageId, item]));
    const questions = (questionsByLogical.get(logicalItemId) ?? [])
      .map((row) => question(
        row,
        passageById,
        optionsByQuestion,
        ctwParagraphsByQuestion,
        ctwSlotsByQuestion,
        ctwSegmentsByQuestion,
        anchorsByQuestion
      ))
      .sort((left, right) => left.questionOrder - right.questionOrder);
    const usedMaterialIds = Array.from(new Set(questions.flatMap((item) =>
      item.questionType === "rdl" ? [item.payload.materialId] : []
    )));
    return {
      schemaVersion: 2,
      item: {
        logicalItemId,
        module: text(logicalRow.module) as ReadingModule,
        title: nullableText(logicalRow.title),
        firstSeenDate: text(logicalRow.first_seen_date),
        firstSeenSourceLabel: text(logicalRow.first_seen_source_label),
        firstSeenSourceOrder: number(logicalRow.first_seen_source_order),
        dedupFingerprint: text(logicalRow.dedup_fingerprint),
        questionCount: number(logicalRow.question_count),
        scoredItemCount: number(logicalRow.scored_item_count),
        isActive: Boolean(logicalRow.is_active)
      },
      occurrences: [],
      materials: usedMaterialIds.map((id) => requiredMap(materialsById, id, "material")),
      passages,
      questions
    } satisfies ReadingImportPackage;
  });
}

export function attachIncomingOccurrencesToHistoricalPackage(
  historical: ReadingImportPackage,
  incoming: ReadingImportPackage
): ReadingImportPackage {
  const incomingQuestions = new Map(incoming.questions.map((item) => [item.questionId, item]));
  const historicalByOrder = new Map(historical.questions.map((item) => [item.questionOrder, item]));
  return {
    ...historical,
    item: {
      ...historical.item,
      firstSeenDate: incoming.item.firstSeenDate,
      firstSeenSourceLabel: incoming.item.firstSeenSourceLabel,
      firstSeenSourceOrder: incoming.item.firstSeenSourceOrder
    },
    occurrences: incoming.occurrences.map((occurrence) => ({
      ...occurrence,
      logicalItemId: historical.item.logicalItemId,
      questionSources: occurrence.questionSources.map((mapping) => {
        const incomingQuestion = requiredMap(incomingQuestions, mapping.questionId, "incoming question");
        const historicalQuestion = requiredMap(historicalByOrder, incomingQuestion.questionOrder, "historical question order");
        if (historicalQuestion.questionType !== incomingQuestion.questionType) {
          throw new Error(`Historical Reading question type differs at order ${incomingQuestion.questionOrder}`);
        }
        return { ...mapping, questionId: historicalQuestion.questionId };
      })
    }))
  };
}

async function selectIn(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  values: unknown[]
): Promise<Row[]> {
  if (values.length === 0) return [];
  const pageSize = 1000;
  const candidateBatchSize = 200;
  const rows: Row[] = [];
  for (let candidateStart = 0; candidateStart < values.length; candidateStart += candidateBatchSize) {
    const candidates = values.slice(candidateStart, candidateStart + candidateBatchSize);
    for (let from = 0; ; from += pageSize) {
      const query = supabase.from(table).select(columns).in(column, candidates);
      const rangeQuery = query as unknown as {
        range?: (start: number, end: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
      const supportsRange = typeof rangeQuery.range === "function";
      const { data, error } = supportsRange
        ? await rangeQuery.range!(from, from + pageSize - 1)
        : await query;
      if (error) throw new Error(`read historical ${table}: ${error.message}`);
      const page = (data ?? []) as unknown as Row[];
      rows.push(...page);
      if (!supportsRange || page.length < pageSize) break;
    }
  }
  return rows;
}

function passage(
  row: Row,
  paragraphsByPassage: Map<string, Row[]>,
  sentencesByPassage: Map<string, Row[]>
): ReadingPassage {
  const passageId = text(row.passage_id);
  const sentenceRows = sentencesByPassage.get(passageId) ?? [];
  return {
    passageId,
    logicalItemId: text(row.logical_item_id),
    title: text(row.title),
    paragraphs: (paragraphsByPassage.get(passageId) ?? []).map((paragraphRow) => ({
      paragraphId: text(paragraphRow.paragraph_id),
      paragraphOrder: number(paragraphRow.paragraph_order),
      text: text(paragraphRow.paragraph_text),
      rawText: text(paragraphRow.raw_text),
      sentences: sentenceRows
        .filter((sentenceRow) => text(sentenceRow.paragraph_id) === text(paragraphRow.paragraph_id))
        .map((sentenceRow) => ({
          sentenceId: text(sentenceRow.sentence_id),
          sentenceOrder: number(sentenceRow.sentence_order),
          text: text(sentenceRow.sentence_text)
        }))
        .sort((left, right) => left.sentenceOrder - right.sentenceOrder)
    })).sort((left, right) => left.paragraphOrder - right.paragraphOrder)
  };
}

function question(
  row: Row,
  passageById: Map<string, ReadingPassage>,
  optionsByQuestion: Map<string, Row[]>,
  ctwParagraphsByQuestion: Map<string, Row[]>,
  ctwSlotsByQuestion: Map<string, Row[]>,
  ctwSegmentsByQuestion: Map<string, Row[]>,
  anchorsByQuestion: Map<string, Row[]>
): ReadingQuestion {
  const questionId = text(row.question_id);
  const base = {
    questionId,
    logicalItemId: text(row.logical_item_id),
    questionOrder: number(row.question_order),
    stem: text(row.stem),
    rawDisplayText: nullableText(row.raw_display_text)
  };
  const type = text(row.question_type);
  if (type === "ctw") {
    const segmentRows = ctwSegmentsByQuestion.get(questionId) ?? [];
    return {
      ...base,
      questionType: "ctw",
      payload: {
        paragraphs: (ctwParagraphsByQuestion.get(questionId) ?? []).map((paragraphRow) => ({
          paragraphId: text(paragraphRow.paragraph_id),
          paragraphOrder: number(paragraphRow.paragraph_order),
          rawText: text(paragraphRow.raw_text),
          segments: segmentRows
            .filter((segmentRow) => text(segmentRow.paragraph_id) === text(paragraphRow.paragraph_id))
            .sort((left, right) => number(left.segment_order) - number(right.segment_order))
            .map((segmentRow) => text(segmentRow.segment_type) === "text"
              ? { kind: "text" as const, text: text(segmentRow.text_content) }
              : { kind: "blank" as const, slotId: text(segmentRow.slot_id) })
        })).sort((left, right) => left.paragraphOrder - right.paragraphOrder),
        slots: (ctwSlotsByQuestion.get(questionId) ?? []).map((slotRow) => ({
          slotId: text(slotRow.slot_id),
          slotOrder: number(slotRow.slot_order),
          paragraphId: text(slotRow.paragraph_id),
          answer: text(slotRow.answer),
          prefix: text(slotRow.prefix),
          displayText: text(slotRow.display_text),
          missingText: text(slotRow.missing_text),
          missingLength: number(slotRow.missing_length)
        })).sort((left, right) => left.slotOrder - right.slotOrder)
      }
    };
  }
  if (type === "rdl" || type === "rap_multiple_choice") {
    const options = (optionsByQuestion.get(questionId) ?? []).map((optionRow) => ({
      optionId: text(optionRow.option_id),
      optionOrder: number(optionRow.option_order),
      text: text(optionRow.option_text)
    })).sort((left, right) => left.optionOrder - right.optionOrder);
    if (type === "rdl") {
      return {
        ...base,
        questionType: "rdl",
        payload: { materialId: text(row.material_id), options, correctOptionId: text(row.correct_option_id) }
      };
    }
    return {
      ...base,
      questionType: "rap_multiple_choice",
      payload: {
        passageId: text(row.passage_id),
        highlightRanges: highlightRanges(row.passage_highlight_ranges),
        options,
        correctOptionId: text(row.correct_option_id)
      }
    };
  }
  if (type === "rap_sentence_insertion") {
    return {
      ...base,
      questionType: "rap_sentence_insertion",
      payload: {
        passageId: text(row.passage_id),
        highlightRanges: highlightRanges(row.passage_highlight_ranges),
        insertSentence: text(row.insert_sentence),
        anchors: (anchorsByQuestion.get(questionId) ?? []).map((anchorRow) => ({
          anchorId: text(anchorRow.anchor_id),
          anchorOrder: number(anchorRow.anchor_order),
          paragraphId: text(anchorRow.paragraph_id),
          boundaryIndex: number(anchorRow.boundary_index),
          afterSentenceId: nullableText(anchorRow.after_sentence_id)
        })).sort((left, right) => left.anchorOrder - right.anchorOrder),
        correctAnchorId: text(row.correct_anchor_id)
      }
    };
  }
  if (type !== "rap_sentence_selection") throw new Error(`Unsupported historical Reading question type ${type}`);
  const passage = requiredMap(passageById, text(row.passage_id), "passage");
  return {
    ...base,
    questionType: "rap_sentence_selection",
    payload: {
      passageId: passage.passageId,
      highlightRanges: highlightRanges(row.passage_highlight_ranges),
      targetParagraphId: text(row.target_paragraph_id),
      correctSentenceId: text(row.correct_sentence_id)
    }
  };
}

function material(row: Row): ReadingMaterial {
  return {
    materialId: text(row.material_id),
    title: nullableText(row.title),
    materialType: nullableText(row.material_type) as ReadingMaterial["materialType"],
    source: text(row.source),
    sourceDate: nullableText(row.source_date),
    yearMonth: text(row.year_month),
    bindingStatus: text(row.binding_status) as ReadingMaterial["bindingStatus"],
    imageAssetPath: nullableText(row.image_asset_path),
    hitboxDataPath: nullableText(row.hitbox_data_path)
  };
}

function highlightRanges(value: unknown) {
  if (value === null || value === undefined) return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error("Historical RAP highlight ranges are not an array");
  return parsed.map((range) => ({
    paragraphId: text((range as Row).paragraphId ?? (range as Row).paragraph_id),
    startOffset: number((range as Row).startOffset ?? (range as Row).start_offset),
    endOffset: number((range as Row).endOffset ?? (range as Row).end_offset)
  }));
}

function grouped(rows: Row[], field: string) {
  const result = new Map<string, Row[]>();
  for (const row of rows) {
    const key = text(row[field]);
    result.set(key, [...(result.get(key) ?? []), row]);
  }
  return result;
}

function requiredMap<K, V>(map: Map<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Historical Reading ${label} is missing: ${String(key)}`);
  return value;
}

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function number(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Historical Reading numeric value is invalid: ${String(value)}`);
  return parsed;
}
