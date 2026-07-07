import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";

const REQUIRED_FIELDS = [
  "question_id",
  "set_id",
  "set_title",
  "question_order",
  "prompt",
  "sentence_template",
  "blank_count",
  "options_text",
  "correct_order_text",
  "distractors_text",
  "final_sentence",
  "grammar_tags_text"
] as const;

const QUESTION_BATCH_SIZE = 100;
const QUESTION_SETS_SET_ID_TEXT_SQL =
  "alter table public.question_sets alter column set_id type text using set_id::text;";

type ImportQuestionRow = Record<(typeof REQUIRED_FIELDS)[number], string>;

type FailedRow = {
  rowNumber: number;
  questionId: string;
  reason: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
  operation?: string;
};

type ImportWarning = {
  message: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
  operation?: string;
};

type SupabaseLikeError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

type ValidImportRow = {
  row: ImportQuestionRow;
  rowNumber: number;
};

function validateRow(row: Partial<ImportQuestionRow>) {
  for (const field of REQUIRED_FIELDS) {
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

function serializeError(error: unknown) {
  const supabaseError = error as SupabaseLikeError;
  return {
    message:
      supabaseError?.message ??
      (error instanceof Error ? error.message : "Unknown import error"),
    code: supabaseError?.code ?? null,
    details: supabaseError?.details ?? null,
    hint: supabaseError?.hint ?? null
  };
}

function jsonImportError({
  batch,
  error,
  operation,
  status = 500
}: {
  batch?: string;
  error: unknown;
  operation: string;
  status?: number;
}) {
  const serialized = serializeError(error);
  console.error("Teacher CSV import failed", {
    batch,
    error,
    operation
  });

  return NextResponse.json(
    {
      ...serialized,
      success: false,
      error: serialized.message,
      message: serialized.message,
      operation,
      batch
    },
    { status }
  );
}

function checkHeaders(row: Partial<ImportQuestionRow>) {
  const receivedFields = Object.keys(row);
  const missingFields = REQUIRED_FIELDS.filter((field) => !(field in row));
  const unexpectedFields = receivedFields.filter(
    (field) => !REQUIRED_FIELDS.includes(field as (typeof REQUIRED_FIELDS)[number])
  );

  if (missingFields.length === 0 && unexpectedFields.length === 0) return null;

  return {
    message: "CSV headers do not match the required template.",
    code: "CSV_HEADER_MISMATCH",
    details: `Missing fields: ${missingFields.join(", ") || "none"}. Unexpected fields: ${
      unexpectedFields.join(", ") || "none"
    }. Required header: ${REQUIRED_FIELDS.join(",")}`,
    hint: "Use the exact required header names in the first CSV row."
  };
}

function normalizeRow(row: Partial<ImportQuestionRow>) {
  return Object.fromEntries(
    REQUIRED_FIELDS.map((field) => [field, String(row[field] ?? "").trim()])
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

function chunkRows<T>(rows: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
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

export async function POST(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error || !auth.userId) {
      return NextResponse.json(
        {
          success: false,
          error: auth.error,
          message: auth.error,
          operation: "authorize teacher import"
        },
        { status: 401 }
      );
    }

    const body = (await request.json()) as { rows?: Partial<ImportQuestionRow>[] };
    if (!Array.isArray(body.rows)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid import payload",
          message: "Invalid import payload",
          operation: "parse import request"
        },
        { status: 400 }
      );
    }

    if (body.rows.length > 0) {
      const headerError = checkHeaders(body.rows[0]);
      if (headerError) {
        console.error("Teacher CSV import failed", {
          error: headerError,
          operation: "validate CSV headers"
        });
        return NextResponse.json(
          {
            success: false,
            error: headerError.message,
            operation: "validate CSV headers",
            ...headerError
          },
          { status: 400 }
        );
      }
    }

    const supabase = createServiceSupabase();
    const failedRows: FailedRow[] = [];
    const validRows: ValidImportRow[] = [];
    const warnings: ImportWarning[] = [];

    for (let index = 0; index < body.rows.length; index += 1) {
      const row = normalizeRow(body.rows[index]);
      const rowNumber = index + 2;
      const validationError = validateRow(row);

      if (validationError) {
        failedRows.push({
          rowNumber,
          questionId: row.question_id,
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

      if (error) {
        return jsonImportError({
          batch: `preflight question_id lookup for ${questionIds.length} rows`,
          error,
          operation: "read existing question IDs"
        });
      }

      for (const item of data ?? []) {
        existingIds.add(String(item.question_id));
      }
    }

    const setRows = Array.from(
      new Map(
        validRows.map(({ row }) => [
          row.set_id,
          {
            set_id: String(row.set_id),
            set_title: row.set_title,
            is_active: true,
            created_by: auth.userId
          }
        ])
      ).values()
    );

    if (setRows.length > 0) {
      const { error: setError } = await supabase
        .from("question_sets")
        .upsert(setRows, { onConflict: "set_id" });

      if (setError) {
        console.error("Teacher CSV import batch failed", {
          batch: `question_sets batch for ${setRows.length} sets`,
          error: setError,
          operation: "upsert question_sets"
        });

        if (isQuestionSetsUuidSetIdError(setError)) {
          warnings.push(questionSetsUuidWarning(setError));
        } else {
          const serialized = serializeError(setError);
          for (const { row, rowNumber } of validRows) {
            failedRows.push({
              rowNumber,
              questionId: row.question_id,
              reason: serialized.message,
              operation: "upsert question_sets",
              code: serialized.code,
              details: serialized.details,
              hint: serialized.hint
            });
          }

          return NextResponse.json({
            success: true,
            successCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            failedCount: failedRows.length,
            failedRows,
            warnings
          });
        }
      }
    }

    let insertedCount = 0;
    let updatedCount = 0;
    const questionBatches = chunkRows(validRows, QUESTION_BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < questionBatches.length; batchIndex += 1) {
      const batch = questionBatches[batchIndex];
      const batchLabel = `questions batch ${batchIndex + 1}/${questionBatches.length}, CSV rows ${
        batch[0]?.rowNumber ?? "?"
      }-${batch[batch.length - 1]?.rowNumber ?? "?"}`;
      const { error: questionError } = await supabase
        .from("questions")
        .upsert(batch.map(({ row }) => questionPayload(row)), { onConflict: "question_id" });

      if (questionError) {
        const serialized = serializeError(questionError);
        const uuidSetIdHint = isQuestionSetsUuidSetIdError(questionError)
          ? `If questions.set_id is also uuid, convert it to text. Required text set_id values look like 202603-0301-1. Related SQL for question_sets: ${QUESTION_SETS_SET_ID_TEXT_SQL}`
          : serialized.hint;

        console.error("Teacher CSV import batch failed", {
          batch: batchLabel,
          error: questionError,
          operation: "upsert questions"
        });

        for (const { row, rowNumber } of batch) {
          failedRows.push({
            rowNumber,
            questionId: row.question_id,
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
        if (existingIds.has(row.question_id)) {
          updatedCount += 1;
        } else {
          insertedCount += 1;
          existingIds.add(row.question_id);
        }
      }
    }

    return NextResponse.json({
      success: true,
      successCount: insertedCount + updatedCount,
      insertedCount,
      updatedCount,
      failedCount: failedRows.length,
      failedRows,
      warnings
    });
  } catch (error) {
    return jsonImportError({
      error,
      operation: "import CSV questions"
    });
  }
}
