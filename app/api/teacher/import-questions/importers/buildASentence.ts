import { BUILD_A_SENTENCE_HEADERS } from "@/lib/questionCsvSchemas";
import { chunkRows, importResult, serializeError } from "./common";
import type {
  FailedRow,
  ImporterContext,
  ImportWarning
} from "./types";

const QUESTION_BATCH_SIZE = 100;
const QUESTION_SETS_SET_ID_TEXT_SQL =
  "alter table public.question_sets alter column set_id type text using set_id::text;";

type ImportQuestionRow = Record<(typeof BUILD_A_SENTENCE_HEADERS)[number], string>;

type ValidImportRow = {
  row: ImportQuestionRow;
  rowNumber: number;
};

function validateRow(row: Partial<ImportQuestionRow>) {
  for (const field of BUILD_A_SENTENCE_HEADERS) {
    if (field !== "distractors_text" && field !== "grammar_tags_text" && !row[field]?.trim()) {
      return `Missing ${field}`;
    }
  }

  const questionOrder = Number(row.question_order);
  if (!Number.isInteger(questionOrder) || questionOrder < 1 || questionOrder > 10) {
    return "question_order must be an integer from 1 to 10";
  }

  const blankCount = Number(row.blank_count);
  if (!Number.isInteger(blankCount) || blankCount < 1) {
    return "blank_count must be a positive integer";
  }

  return null;
}

function normalizeRow(row: Record<string, string>) {
  return Object.fromEntries(
    BUILD_A_SENTENCE_HEADERS.map((field) => [field, String(row[field] ?? "").trim()])
  ) as ImportQuestionRow;
}

function isQuestionSetsUuidSetIdError(error: unknown) {
  const serialized = serializeError(error);
  return (
    serialized.code === "22P02" &&
    serialized.message.toLocaleLowerCase().includes("uuid")
  );
}

function questionSetsUuidWarning(error: unknown): ImportWarning {
  const serialized = serializeError(error);
  return {
    message:
      "question_sets.set_id appears to be uuid, so CSV text set_id values cannot be written to question_sets. Questions import will continue using questions.set_id as text.",
    operation: "upsert question_sets",
    code: serialized.code,
    details: serialized.details ?? serialized.message,
    hint: `Run this Supabase SQL if question_sets.set_id is still uuid: ${QUESTION_SETS_SET_ID_TEXT_SQL}`
  };
}

function questionPayload(row: ImportQuestionRow) {
  return {
    question_id: String(row.question_id),
    set_id: String(row.set_id),
    set_title: row.set_title,
    question_order: Number(row.question_order),
    prompt: row.prompt,
    sentence_template: row.sentence_template,
    blank_count: Number(row.blank_count),
    options_text: row.options_text,
    correct_order_text: row.correct_order_text,
    distractors_text: row.distractors_text,
    final_sentence: row.final_sentence,
    grammar_tags_text: row.grammar_tags_text
  };
}

export async function importBuildASentence({ rows, supabase, userId }: ImporterContext) {
  const failedRows: FailedRow[] = [];
  const validRows: ValidImportRow[] = [];
  const warnings: ImportWarning[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = normalizeRow(rows[index]);
    const rowNumber = index + 2;
    const validationError = validateRow(row);

    if (validationError) {
      failedRows.push({
        rowNumber,
        questionId: row.question_id,
        setId: row.set_id,
        reason: validationError,
        operation: "validate row"
      });
    } else {
      validRows.push({ row, rowNumber });
    }
  }

  const questionIds = validRows.map(({ row }) => row.question_id);
  const existingIds = new Set<string>();

  if (questionIds.length > 0) {
    const { data, error } = await supabase
      .from("questions")
      .select("question_id")
      .in("question_id", questionIds);

    if (error) throw Object.assign(error, { operation: "read existing question IDs" });
    for (const item of data ?? []) existingIds.add(String(item.question_id));
  }

  const setRows = Array.from(
    new Map(
      validRows.map(({ row }) => [
        row.set_id,
        {
          set_id: String(row.set_id),
          set_title: row.set_title,
          is_active: true,
          created_by: userId
        }
      ])
    ).values()
  );

  if (setRows.length > 0) {
    const { error: setError } = await supabase
      .from("question_sets")
      .upsert(setRows, { onConflict: "set_id" });

    if (setError) {
      if (isQuestionSetsUuidSetIdError(setError)) {
        warnings.push(questionSetsUuidWarning(setError));
      } else {
        const serialized = serializeError(setError);
        for (const { row, rowNumber } of validRows) {
          failedRows.push({
            rowNumber,
            questionId: row.question_id,
            setId: row.set_id,
            reason: serialized.message,
            operation: "upsert question_sets",
            code: serialized.code,
            details: serialized.details,
            hint: serialized.hint
          });
        }
        return importResult(0, 0, failedRows, warnings);
      }
    }
  }

  let insertedCount = 0;
  let updatedCount = 0;
  const questionBatches = chunkRows(validRows, QUESTION_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < questionBatches.length; batchIndex += 1) {
    const batch = questionBatches[batchIndex];
    const { error: questionError } = await supabase
      .from("questions")
      .upsert(batch.map(({ row }) => questionPayload(row)), { onConflict: "question_id" });

    if (questionError) {
      const serialized = serializeError(questionError);
      const uuidSetIdHint = isQuestionSetsUuidSetIdError(questionError)
        ? `If questions.set_id is also uuid, convert it to text. Required text set_id values look like 202603-0301-1. Related SQL for question_sets: ${QUESTION_SETS_SET_ID_TEXT_SQL}`
        : serialized.hint;

      for (const { row, rowNumber } of batch) {
        failedRows.push({
          rowNumber,
          questionId: row.question_id,
          setId: row.set_id,
          reason: serialized.message,
          operation: "upsert questions",
          code: serialized.code,
          details: serialized.details,
          hint: uuidSetIdHint
        });
      }
      continue;
    }

    for (const { row } of batch) {
      if (existingIds.has(row.question_id)) updatedCount += 1;
      else {
        insertedCount += 1;
        existingIds.add(row.question_id);
      }
    }
  }

  return importResult(insertedCount, updatedCount, failedRows, warnings);
}
