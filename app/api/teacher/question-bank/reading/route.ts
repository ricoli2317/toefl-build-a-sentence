import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { resolveReadingAssetUrl } from "@/lib/reading/assets";
import {
  compareReadingCatalogIdentityOrder,
  readingCatalogDisplayNumbers,
  type ReadingCatalogIdentityRow
} from "@/lib/reading/catalog";
import { isRdlMaterialType } from "@/lib/reading/materialTypes";
import type { ReadingModule } from "@/lib/reading/types";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  isReadingModuleTaskType,
  readingBankItemTitle,
  TEACHER_READING_BANK_PAGE_SIZE,
  type TeacherReadingBankCatalog,
  type TeacherReadingBankCatalogItem,
  type TeacherReadingBankItemDetail,
  type TeacherReadingBankQuestion
} from "@/lib/teacherReadingQuestionBank";

export const dynamic = "force-dynamic";

const READING_ID_PATTERN = /^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/;

type ReadingIdentityRow = ReadingCatalogIdentityRow & {
  module: ReadingModule;
  title: string | null;
  question_count: number;
  scored_item_count: number;
  reading_source_occurrences?: Array<{ occurrence_date: string }>;
};

type ReadingQuestionRow = {
  question_id: string;
  question_order: number;
  question_type:
    | "ctw"
    | "rdl"
    | "rap_multiple_choice"
    | "rap_sentence_insertion"
    | "rap_sentence_selection";
  stem: string;
  passage_id: string | null;
  material_id: string | null;
  correct_option_id: string | null;
  insert_sentence: string | null;
  correct_anchor_id: string | null;
  target_paragraph_id: string | null;
  correct_sentence_id: string | null;
};

type PageError = { message: string };

export async function GET(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error) {
      return jsonError(auth.error, auth.error === "Unauthorized" ? 401 : 403);
    }

    const params = new URL(request.url).searchParams;
    const itemId = params.get("itemId")?.trim();
    const db = createServiceSupabase();

    if (itemId) {
      if (!READING_ID_PATTERN.test(itemId)) return jsonError("Reading item not found.", 404);
      const detail = await loadReadingItemDetail(db, itemId);
      return detail ? json(detail) : jsonError("Reading item not found.", 404);
    }

    const requestedModule = params.get("module");
    if (!isReadingModuleTaskType(requestedModule)) {
      return jsonError("Invalid Reading module.", 400);
    }
    const page = parseReadingBankPage(params.get("page"));
    if (page === null) return jsonError("page must be a positive integer.", 400);

    return json(await loadReadingBankCatalog(db, requestedModule, page));
  } catch (error) {
    console.error("[teacher-reading-question-bank] load_failed", error);
    return jsonError("Could not load the teacher Reading question bank.");
  }
}

async function loadReadingIdentityRows(
  db: ReturnType<typeof createServiceSupabase>,
  module: ReadingModule
) {
  const result = await readAllSupabaseRows<ReadingIdentityRow>((from, to) =>
    db
      .from("reading_logical_items")
      .select(
        "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count,reading_source_occurrences(occurrence_date)"
      )
      .eq("module", module)
      .order("first_seen_date", { ascending: true })
      .order("first_seen_source_label", { ascending: true })
      .order("first_seen_source_order", { ascending: true })
      .order("logical_item_id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: ReadingIdentityRow[] | null;
      error: PageError | null;
    }>
  );
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).sort(compareReadingCatalogIdentityOrder);
}

function toCatalogItem(
  row: ReadingIdentityRow,
  displayNumber: string
): TeacherReadingBankCatalogItem {
  const occurrenceDates = Array.from(
    new Set(
      (row.reading_source_occurrences ?? []).map((occurrence) =>
        String(occurrence.occurrence_date)
      )
    )
  ).sort((left, right) => right.localeCompare(left));
  return {
    itemId: row.logical_item_id,
    module: row.module,
    displayNumber,
    title: readingBankItemTitle({
      module: row.module,
      title: row.title,
      displayNumber
    }),
    firstSeenDate: row.first_seen_date,
    occurrenceDates: occurrenceDates.length > 0 ? occurrenceDates : [row.first_seen_date],
    questionCount: Number(row.question_count),
    scoringPointCount: Number(row.scored_item_count)
  };
}

async function loadReadingBankCatalog(
  db: ReturnType<typeof createServiceSupabase>,
  module: ReadingModule,
  page: number
): Promise<TeacherReadingBankCatalog> {
  const ranked = await loadReadingIdentityRows(db, module);
  const displayNumbers = readingCatalogDisplayNumbers(ranked);
  // The display rank is historical, while the bank list itself is latest-first.
  const items = [...ranked].reverse().map((row) =>
    toCatalogItem(row, displayNumbers.get(row.logical_item_id) ?? "")
  );
  const totalPages = Math.ceil(items.length / TEACHER_READING_BANK_PAGE_SIZE);
  const from = (page - 1) * TEACHER_READING_BANK_PAGE_SIZE;

  return {
    module,
    page,
    pageSize: TEACHER_READING_BANK_PAGE_SIZE,
    totalItems: items.length,
    totalPages,
    items: items.slice(from, from + TEACHER_READING_BANK_PAGE_SIZE)
  };
}

async function loadReadingItemDetail(
  db: ReturnType<typeof createServiceSupabase>,
  itemId: string
): Promise<TeacherReadingBankItemDetail | null> {
  const itemResult = await db
    .from("reading_logical_items")
    .select(
      "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count"
    )
    .eq("logical_item_id", itemId)
    .maybeSingle();
  if (itemResult.error) throw new Error(itemResult.error.message);
  const itemRow = itemResult.data as ReadingIdentityRow | null;
  if (!itemRow) return null;

  const [identityRows, questionResult] = await Promise.all([
    loadReadingIdentityRows(db, itemRow.module),
    db
      .from("reading_questions")
      .select(
        "question_id,question_order,question_type,stem,passage_id,material_id,correct_option_id,insert_sentence,correct_anchor_id,target_paragraph_id,correct_sentence_id"
      )
      .eq("logical_item_id", itemId)
      .order("question_order", { ascending: true })
  ]);
  if (questionResult.error) throw new Error(questionResult.error.message);
  const questionRows = (questionResult.data ?? []) as ReadingQuestionRow[];
  const questionIds = questionRows.map((question) => question.question_id);
  const displayNumber = readingCatalogDisplayNumbers(identityRows).get(itemId) ?? "";

  let material: TeacherReadingBankItemDetail["material"] = null;
  let passage: TeacherReadingBankItemDetail["passage"] = null;
  let questions: TeacherReadingBankQuestion[] = [];

  if (itemRow.module === "ctw") {
    questions = await loadCtwQuestions(db, questionRows, questionIds);
  } else if (itemRow.module === "rdl") {
    const optionByQuestion = await loadOptionsByQuestion(db, questionIds);
    const materialId = questionRows[0]?.material_id ?? "";
    if (materialId) {
      const materialResult = await db
        .from("reading_materials")
        .select("material_id,title,material_type,binding_status,image_asset_path")
        .eq("material_id", materialId)
        .maybeSingle();
      if (materialResult.error) throw new Error(materialResult.error.message);
      const materialRow = materialResult.data as {
        material_id: string;
        title: string | null;
        material_type: string;
        binding_status: string;
        image_asset_path: string | null;
      } | null;
      if (materialRow) {
        material = {
          materialId: materialRow.material_id,
          title: materialRow.title?.trim() || "",
          materialType: isRdlMaterialType(materialRow.material_type)
            ? materialRow.material_type
            : null,
          imageUrl: resolveBankAssetUrl(
            materialRow.binding_status === "bound" ? materialRow.image_asset_path : null
          )
        };
      }
    }
    questions = questionRows.map((question) =>
      buildQuestion(question, optionByQuestion.get(question.question_id) ?? [])
    );
  } else {
    const [optionByQuestion, anchorResult] = await Promise.all([
      loadOptionsByQuestion(db, questionIds),
      db
        .from("reading_rap_insertion_anchors")
        .select(
          "question_id,anchor_id,anchor_order,paragraph_id,boundary_index,after_sentence_id"
        )
        .in("question_id", questionIds)
        .order("anchor_order", { ascending: true })
    ]);
    if (anchorResult.error) throw new Error(anchorResult.error.message);
    passage = await loadRapPassage(db, questionRows, questionIds);
    const sentences = new Map(
      (passage?.paragraphs ?? []).flatMap((paragraph) =>
        paragraph.sentences.map((sentence) => [sentence.sentenceId, sentence.text])
      )
    );
    questions = questionRows.map((question) => ({
      ...buildQuestion(question, optionByQuestion.get(question.question_id) ?? [], passage),
      anchors: (anchorResult.data ?? [])
        .filter((anchor) => anchor.question_id === question.question_id)
        .map((anchor) => ({
          anchorId: String(anchor.anchor_id),
          anchorOrder: Number(anchor.anchor_order),
          paragraphId: String(anchor.paragraph_id),
          boundaryIndex: Number(anchor.boundary_index),
          afterSentenceText: anchor.after_sentence_id
            ? sentences.get(String(anchor.after_sentence_id)) ?? null
            : null
        }))
    }));
  }

  return {
    item: toCatalogItem(itemRow, displayNumber),
    material,
    passage,
    questions
  };
}

async function loadCtwQuestions(
  db: ReturnType<typeof createServiceSupabase>,
  questionRows: ReadingQuestionRow[],
  questionIds: string[]
): Promise<TeacherReadingBankQuestion[]> {
  const [paragraphResult, segmentResult, slotResult] = await Promise.all([
    db
      .from("reading_ctw_paragraphs")
      .select("question_id,paragraph_id,paragraph_order")
      .in("question_id", questionIds)
      .order("paragraph_order", { ascending: true }),
    db
      .from("reading_ctw_segments")
      .select("question_id,paragraph_id,segment_order,segment_type,text_content,slot_id")
      .in("question_id", questionIds)
      .order("segment_order", { ascending: true }),
    db
      .from("reading_ctw_slots")
      .select("slot_id,display_text,missing_text")
      .in("question_id", questionIds)
  ]);
  if (paragraphResult.error) throw new Error(paragraphResult.error.message);
  if (segmentResult.error) throw new Error(segmentResult.error.message);
  if (slotResult.error) throw new Error(slotResult.error.message);

  const slotById = new Map(
    (slotResult.data ?? []).map((slot) => [
      String(slot.slot_id),
      {
        displayText: String(slot.display_text ?? ""),
        answer: String(slot.missing_text ?? "")
      }
    ])
  );
  const paragraphs = (paragraphResult.data ?? []) as Array<{
    question_id: string;
    paragraph_id: string;
    paragraph_order: number;
  }>;
  const segments = (segmentResult.data ?? []) as Array<{
    question_id: string;
    paragraph_id: string;
    segment_order: number;
    segment_type: string;
    text_content: string | null;
    slot_id: string | null;
  }>;

  return questionRows.map((question) => ({
    ...buildQuestion(question, []),
    ctwParagraphs: paragraphs
      .filter((paragraph) => paragraph.question_id === question.question_id)
      .map((paragraph) => ({
        paragraphId: String(paragraph.paragraph_id),
        paragraphOrder: Number(paragraph.paragraph_order),
        segments: segments
          .filter(
            (segment) =>
              segment.question_id === question.question_id
              && segment.paragraph_id === paragraph.paragraph_id
          )
          .map((segment) => {
            if (segment.segment_type !== "blank" || !segment.slot_id) {
              return { kind: "text" as const, text: String(segment.text_content ?? "") };
            }
            const slot = slotById.get(String(segment.slot_id));
            return {
              kind: "blank" as const,
              slotId: String(segment.slot_id),
              displayText: slot?.displayText ?? "",
              answer: slot?.answer ?? ""
            };
          })
      }))
  }));
}

async function loadOptionsByQuestion(
  db: ReturnType<typeof createServiceSupabase>,
  questionIds: string[]
) {
  const optionsByQuestion = new Map<
    string,
    Array<{ optionId: string; optionOrder: number; text: string }>
  >();
  if (questionIds.length === 0) return optionsByQuestion;
  const result = await db
    .from("reading_question_options")
    .select("question_id,option_id,option_order,option_text")
    .in("question_id", questionIds)
    .order("option_order", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  for (const option of result.data ?? []) {
    const questionId = String(option.question_id);
    optionsByQuestion.set(questionId, [
      ...(optionsByQuestion.get(questionId) ?? []),
      {
        optionId: String(option.option_id),
        optionOrder: Number(option.option_order),
        text: String(option.option_text)
      }
    ]);
  }
  return optionsByQuestion;
}

async function loadRapPassage(
  db: ReturnType<typeof createServiceSupabase>,
  questionRows: ReadingQuestionRow[],
  questionIds: string[]
): Promise<TeacherReadingBankItemDetail["passage"]> {
  const passageId = questionRows[0]?.passage_id ?? "";
  if (!passageId) return null;
  const [passageResult, paragraphResult, sentenceResult] = await Promise.all([
    db
      .from("reading_passages")
      .select("passage_id,title")
      .eq("passage_id", passageId)
      .maybeSingle(),
    db
      .from("reading_passage_paragraphs")
      .select("paragraph_id,paragraph_order,paragraph_text")
      .eq("passage_id", passageId)
      .order("paragraph_order", { ascending: true }),
    db
      .from("reading_passage_sentences")
      .select("paragraph_id,sentence_id,sentence_order,sentence_text")
      .eq("passage_id", passageId)
      .order("sentence_order", { ascending: true })
  ]);
  if (passageResult.error) throw new Error(passageResult.error.message);
  if (paragraphResult.error) throw new Error(paragraphResult.error.message);
  if (sentenceResult.error) throw new Error(sentenceResult.error.message);
  if (!passageResult.data) return null;

  return {
    passageId,
    title: String(passageResult.data.title ?? ""),
    paragraphs: (paragraphResult.data ?? []).map((paragraph) => ({
      paragraphId: String(paragraph.paragraph_id),
      paragraphOrder: Number(paragraph.paragraph_order),
      text: String(paragraph.paragraph_text ?? ""),
      sentences: (sentenceResult.data ?? [])
        .filter((sentence) => sentence.paragraph_id === paragraph.paragraph_id)
        .map((sentence) => ({
          sentenceId: String(sentence.sentence_id),
          sentenceOrder: Number(sentence.sentence_order),
          text: String(sentence.sentence_text)
        }))
    }))
  };
}

function buildQuestion(
  row: ReadingQuestionRow,
  options: Array<{ optionId: string; optionOrder: number; text: string }>,
  passage?: TeacherReadingBankItemDetail["passage"]
): TeacherReadingBankQuestion {
  const sentences = new Map(
    (passage?.paragraphs ?? []).flatMap((paragraph) =>
      paragraph.sentences.map((sentence) => [sentence.sentenceId, sentence.text])
    )
  );
  return {
    questionId: row.question_id,
    questionOrder: Number(row.question_order),
    questionType: row.question_type,
    stem: row.stem,
    options: options.map((option) => ({
      ...option,
      isCorrect: option.optionId === row.correct_option_id
    })),
    ctwParagraphs: [],
    insertSentence: row.insert_sentence,
    correctAnchorId: row.correct_anchor_id,
    anchors: [],
    targetParagraphId: row.target_paragraph_id,
    correctSentenceId: row.correct_sentence_id,
    correctSentenceText: row.correct_sentence_id
      ? sentences.get(row.correct_sentence_id) ?? null
      : null
  };
}

function resolveBankAssetUrl(objectKey: string | null) {
  if (!objectKey) return null;
  try {
    return resolveReadingAssetUrl(objectKey);
  } catch (error) {
    console.error("[teacher-reading-question-bank] reading asset url unavailable", {
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function parseReadingBankPage(value: string | null) {
  if (value === null || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : null;
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function jsonError(error: string, status = 500) {
  return json({ error }, { status });
}
