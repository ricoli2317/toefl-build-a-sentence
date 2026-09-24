import { resolveReadingAssetUrl } from "../reading/assets.ts";
import { parseRdlSelectionMap } from "../reading/rdlSelection.ts";
import type { CanonicalLexicalEnumerationInput } from "./enumerateCanonicalBlocks.server.ts";
import type { AcademicDiscussionLexicalInput } from "./enumerators/academicDiscussion.server.ts";
import type { BasLexicalInput } from "./enumerators/bas.server.ts";
import type { CtwLexicalInput } from "./enumerators/ctw.server.ts";
import type { RapLexicalInput } from "./enumerators/rap.server.ts";
import type { RdlLexicalInput } from "./enumerators/rdl.server.ts";
import type { WriteEmailLexicalInput } from "./enumerators/writeEmail.server.ts";

type ReadOnlySupabase = { from: (table: string) => any };
type Row = Record<string, unknown>;

const PAGE_SIZE = 1_000;

export function normalizeRdlSelectionMapForLexical(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const lines = source.lines;
  if (!Array.isArray(lines) || !lines.some((value) =>
    value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).break_after == null
  )) return input;
  return {
    ...source,
    lines: lines.map((lineValue, lineIndex) => {
      if (!lineValue || typeof lineValue !== "object" || Array.isArray(lineValue)) return lineValue;
      const line = lineValue as Record<string, unknown>;
      if (line.break_after != null) return line;
      const words = Array.isArray(line.words) ? line.words.map((wordValue) => {
        if (!wordValue || typeof wordValue !== "object" || Array.isArray(wordValue)) return wordValue;
        const word = wordValue as Record<string, unknown>;
        return {
          ...word,
          needs_review: true,
          chars: Array.isArray(word.chars) ? word.chars.map((characterValue) =>
            characterValue && typeof characterValue === "object" && !Array.isArray(characterValue)
              ? { ...(characterValue as Record<string, unknown>), needs_review: true }
              : characterValue
          ) : word.chars
        };
      }) : line.words;
      return {
        ...line,
        break_after: lineIndex === lines.length - 1 ? "end" : "space",
        words
      };
    })
  };
}

async function selectAllRows(
  db: ReadOnlySupabase,
  table: string,
  columns: string,
  orderColumns: string[]
) {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = db.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    for (const column of orderColumns) query = query.order(column, { ascending: true });
    const { data, error } = await query;
    if (error) throw new Error(`Failed to read ${table}: ${error.message}`);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function groupBy(rows: Row[], key: string) {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const value = String(row[key]);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function one<T>(values: T[], message: string) {
  if (values.length !== 1) throw new Error(`${message}; found ${values.length}.`);
  return values[0];
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export async function loadCanonicalLexicalInputs(
  db: ReadOnlySupabase,
  options: {
    assetBaseUrl?: string;
    fetchImpl?: typeof fetch;
    onProgress?: (message: string) => void;
  } = {}
): Promise<CanonicalLexicalEnumerationInput> {
  const onProgress = options.onProgress ?? (() => {});
  onProgress("Reading canonical source tables");
  const [
    readingItems,
    readingQuestions,
    readingOptions,
    ctwParagraphs,
    ctwSegments,
    ctwSlots,
    readingMaterials,
    readingPassages,
    rapParagraphs,
    rapSentences,
    rapInsertionAnchors,
    practiceItems,
    practiceSources,
    practiceQuestionMaps,
    basQuestions,
    emailQuestions,
    academicQuestions
  ] = await Promise.all([
    selectAllRows(db, "reading_logical_items", "logical_item_id,module,is_active", ["logical_item_id"]),
    selectAllRows(db, "reading_questions", "question_id,logical_item_id,question_order,module,question_type,stem,passage_id,material_id,insert_sentence", ["logical_item_id", "question_order"]),
    selectAllRows(db, "reading_question_options", "question_id,option_id,option_order,option_text", ["question_id", "option_order"]),
    selectAllRows(db, "reading_ctw_paragraphs", "question_id,paragraph_id,paragraph_order,raw_text", ["question_id", "paragraph_order"]),
    selectAllRows(db, "reading_ctw_segments", "question_id,paragraph_id,segment_order,segment_type,text_content,slot_id", ["question_id", "paragraph_id", "segment_order"]),
    selectAllRows(db, "reading_ctw_slots", "question_id,slot_id,slot_order,paragraph_id,answer", ["question_id", "slot_order"]),
    selectAllRows(db, "reading_materials", "material_id,binding_status,hitbox_data_path", ["material_id"]),
    selectAllRows(db, "reading_passages", "passage_id,logical_item_id", ["logical_item_id"]),
    selectAllRows(db, "reading_passage_paragraphs", "passage_id,paragraph_id,paragraph_order,paragraph_text", ["passage_id", "paragraph_order"]),
    selectAllRows(db, "reading_passage_sentences", "passage_id,paragraph_id,sentence_id,sentence_order,sentence_text", ["passage_id", "paragraph_id", "sentence_order"]),
    selectAllRows(db, "reading_rap_insertion_anchors", "question_id,passage_id,anchor_id,anchor_order,paragraph_id,boundary_index,after_sentence_id", ["question_id", "anchor_order"]),
    selectAllRows(db, "practice_items", "item_id,task_type,is_active", ["item_id"]),
    selectAllRows(db, "practice_item_sources", "source_id,item_id,task_type,source_set_id,source_question_id,is_canonical", ["item_id", "source_id"]),
    selectAllRows(db, "practice_item_question_map", "source_id,source_question_id,source_question_order,logical_question_order", ["source_id", "logical_question_order"]),
    selectAllRows(db, "questions", "question_id,set_id,question_order,prompt,sentence_template,correct_order_text,final_sentence", ["set_id", "question_order"]),
    selectAllRows(db, "email_questions", "question_id,scenario,task_instruction,requirement_1,requirement_2,requirement_3,recipient,subject", ["question_id"]),
    selectAllRows(db, "academic_discussion_questions", "question_id,professor_prompt,student_1_response,student_2_response", ["question_id"])
  ]);

  const questionsByItem = groupBy(readingQuestions, "logical_item_id");
  const optionsByQuestion = groupBy(readingOptions, "question_id");
  const ctwParagraphsByQuestion = groupBy(ctwParagraphs, "question_id");
  const ctwSegmentsByQuestion = groupBy(ctwSegments, "question_id");
  const ctwSlotsByQuestion = groupBy(ctwSlots, "question_id");
  const materialsById = groupBy(readingMaterials, "material_id");
  const passagesByItem = groupBy(readingPassages, "logical_item_id");
  const paragraphsByPassage = groupBy(rapParagraphs, "passage_id");
  const sentencesByPassage = groupBy(rapSentences, "passage_id");
  const anchorsByQuestion = groupBy(rapInsertionAnchors, "question_id");

  const rdlItems = readingItems.filter((item) => item.module === "rdl");
  const rdlMaterialRows = rdlItems.map((item) => {
    const questions = questionsByItem.get(String(item.logical_item_id)) ?? [];
    const materialId = one(
      Array.from(new Set(questions.map((question) => String(question.material_id)))),
      `RDL item ${String(item.logical_item_id)} must reference one material`
    );
    const material = one(materialsById.get(materialId) ?? [], `Missing RDL material ${materialId}`);
    if (material.binding_status !== "bound" || typeof material.hitbox_data_path !== "string") {
      throw new Error(`RDL material ${materialId} is not bound to a selection map.`);
    }
    return { materialId, material };
  });
  const uniqueRdlMaterials = Array.from(
    new Map(rdlMaterialRows.map((value) => [value.materialId, value.material])).entries()
  );
  onProgress(`Fetching ${uniqueRdlMaterials.length} RDL production selection maps`);
  const fetchedMaps = await mapWithConcurrency(uniqueRdlMaterials, 8, async ([materialId, material]) => {
    const url = resolveReadingAssetUrl(String(material.hitbox_data_path), options.assetBaseUrl);
    const response = await (options.fetchImpl ?? fetch)(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to fetch RDL selection map ${materialId}: HTTP ${response.status}.`);
    try {
      return [materialId, parseRdlSelectionMap(normalizeRdlSelectionMapForLexical(await response.json()))] as const;
    } catch (error) {
      throw new Error(`Invalid RDL selection map ${materialId}: ${(error as Error).message}`);
    }
  });
  const rdlMaps = new Map(fetchedMaps);

  const ctw: CtwLexicalInput[] = readingItems
    .filter((item) => item.module === "ctw")
    .map((item) => {
      const sourceItemId = String(item.logical_item_id);
      const question = one(questionsByItem.get(sourceItemId) ?? [], `CTW item ${sourceItemId} must have one question`);
      const questionId = String(question.question_id);
      return {
        sourceItemId,
        paragraphs: (ctwParagraphsByQuestion.get(questionId) ?? []).map((row) => ({
          paragraphId: String(row.paragraph_id),
          paragraphOrder: Number(row.paragraph_order)
        })),
        segments: (ctwSegmentsByQuestion.get(questionId) ?? []).map((row) => ({
          paragraphId: String(row.paragraph_id),
          segmentOrder: Number(row.segment_order),
          segmentType: String(row.segment_type) as "text" | "blank",
          textContent: row.text_content === null ? null : String(row.text_content),
          slotId: row.slot_id === null ? null : String(row.slot_id)
        })),
        slots: (ctwSlotsByQuestion.get(questionId) ?? []).map((row) => ({
          slotId: String(row.slot_id),
          paragraphId: String(row.paragraph_id),
          answer: String(row.answer)
        }))
      };
    });

  const rdl: RdlLexicalInput[] = rdlItems.map((item) => {
    const sourceItemId = String(item.logical_item_id);
    const questions = questionsByItem.get(sourceItemId) ?? [];
    const materialId = one(
      Array.from(new Set(questions.map((question) => String(question.material_id)))),
      `RDL item ${sourceItemId} must reference one material`
    );
    const selectionMap = rdlMaps.get(materialId);
    if (!selectionMap) throw new Error(`Missing fetched RDL selection map ${materialId}.`);
    return {
      sourceItemId,
      materialId,
      selectionMap,
      questions: questions.map((question) => ({
        questionId: String(question.question_id),
        questionOrder: Number(question.question_order),
        stem: String(question.stem),
        options: (optionsByQuestion.get(String(question.question_id)) ?? []).map((option) => ({
          optionId: String(option.option_id),
          optionOrder: Number(option.option_order),
          optionText: String(option.option_text)
        }))
      }))
    };
  });

  const rap: RapLexicalInput[] = readingItems
    .filter((item) => item.module === "rap")
    .map((item) => {
      const sourceItemId = String(item.logical_item_id);
      const passage = one(passagesByItem.get(sourceItemId) ?? [], `RAP item ${sourceItemId} must have one passage`);
      const passageId = String(passage.passage_id);
      const passageSentences = sentencesByPassage.get(passageId) ?? [];
      return {
        sourceItemId,
        passageId,
        paragraphs: (paragraphsByPassage.get(passageId) ?? []).map((paragraph) => ({
          paragraphId: String(paragraph.paragraph_id),
          paragraphOrder: Number(paragraph.paragraph_order),
          paragraphText: String(paragraph.paragraph_text),
          sentences: passageSentences
            .filter((sentence) => sentence.paragraph_id === paragraph.paragraph_id)
            .map((sentence) => ({
              sentenceId: String(sentence.sentence_id),
              sentenceOrder: Number(sentence.sentence_order),
              sentenceText: String(sentence.sentence_text)
            }))
        })),
        questions: (questionsByItem.get(sourceItemId) ?? []).map((question) => ({
          questionId: String(question.question_id),
          questionOrder: Number(question.question_order),
          questionType: String(question.question_type) as RapLexicalInput["questions"][number]["questionType"],
          stem: String(question.stem),
          insertSentence: question.insert_sentence === null ? null : String(question.insert_sentence),
          options: (optionsByQuestion.get(String(question.question_id)) ?? []).map((option) => ({
            optionId: String(option.option_id),
            optionOrder: Number(option.option_order),
            optionText: String(option.option_text)
          })),
          insertionAnchors: (anchorsByQuestion.get(String(question.question_id)) ?? []).map((anchor) => ({
            anchorId: String(anchor.anchor_id),
            anchorOrder: Number(anchor.anchor_order),
            boundaryIndex: Number(anchor.boundary_index),
            paragraphId: String(anchor.paragraph_id),
            afterSentenceId: anchor.after_sentence_id === null ? null : String(anchor.after_sentence_id)
          }))
        }))
      };
    });

  const sourcesByItem = groupBy(practiceSources, "item_id");
  const mapsBySource = groupBy(practiceQuestionMaps, "source_id");
  const basQuestionById = new Map(basQuestions.map((row) => [String(row.question_id), row]));
  const emailById = new Map(emailQuestions.map((row) => [String(row.question_id), row]));
  const academicById = new Map(academicQuestions.map((row) => [String(row.question_id), row]));
  const bas: BasLexicalInput[] = [];
  const writeEmail: WriteEmailLexicalInput[] = [];
  const academicDiscussion: AcademicDiscussionLexicalInput[] = [];

  for (const item of practiceItems) {
    const itemId = String(item.item_id);
    const canonical = one(
      (sourcesByItem.get(itemId) ?? []).filter((source) => source.is_canonical === true),
      `Practice item ${itemId} must have one canonical source`
    );
    const sourceId = String(canonical.source_id);
    if (item.task_type === "build_sentence") {
      bas.push({
        sourceItemId: itemId,
        sourceId,
        isCanonical: true,
        questions: (mapsBySource.get(sourceId) ?? []).map((mapping) => {
          const raw = basQuestionById.get(String(mapping.source_question_id));
          if (!raw) throw new Error(`Missing BAS raw question ${String(mapping.source_question_id)}.`);
          return {
            sourceQuestionId: String(raw.question_id),
            logicalQuestionOrder: Number(mapping.logical_question_order),
            prompt: String(raw.prompt),
            sentenceTemplate: raw.sentence_template === null ? null : String(raw.sentence_template),
            correctOrderText: raw.correct_order_text === null ? null : String(raw.correct_order_text),
            finalSentence: String(raw.final_sentence)
          };
        })
      });
      continue;
    }
    const rawQuestionId = String(canonical.source_question_id);
    if (item.task_type === "email") {
      const raw = emailById.get(rawQuestionId);
      if (!raw) throw new Error(`Missing canonical Email question ${rawQuestionId}.`);
      writeEmail.push({
        sourceItemId: itemId,
        sourceQuestionId: rawQuestionId,
        isCanonical: true,
        recipient: String(raw.recipient),
        question: {
          scenario: String(raw.scenario),
          taskInstruction: String(raw.task_instruction),
          requirement1: String(raw.requirement_1),
          requirement2: String(raw.requirement_2),
          requirement3: String(raw.requirement_3),
          subject: String(raw.subject)
        }
      });
      continue;
    }
    if (item.task_type === "academic_discussion") {
      const raw = academicById.get(rawQuestionId);
      if (!raw) throw new Error(`Missing canonical Academic Discussion question ${rawQuestionId}.`);
      academicDiscussion.push({
        sourceItemId: itemId,
        sourceQuestionId: rawQuestionId,
        isCanonical: true,
        question: {
          professorPrompt: String(raw.professor_prompt),
          student1Response: String(raw.student_1_response),
          student2Response: String(raw.student_2_response)
        }
      });
    }
  }

  const bySourceItemId = <T extends { sourceItemId: string }>(left: T, right: T) =>
    left.sourceItemId.localeCompare(right.sourceItemId);
  onProgress("Canonical source tables and RDL maps loaded");
  return {
    ctw: ctw.sort(bySourceItemId),
    rdl: rdl.sort(bySourceItemId),
    rap: rap.sort(bySourceItemId),
    bas: bas.sort(bySourceItemId),
    writeEmail: writeEmail.sort(bySourceItemId),
    academicDiscussion: academicDiscussion.sort(bySourceItemId)
  };
}
