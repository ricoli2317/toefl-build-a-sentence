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

type SupabaseLikeError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
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
      error: serialized.message,
      operation,
      batch,
      ...serialized
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

export async function POST(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error || !auth.userId) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = (await request.json()) as { rows?: Partial<ImportQuestionRow>[] };
    if (!Array.isArray(body.rows)) {
      return NextResponse.json({ error: "Invalid import payload" }, { status: 400 });
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
            error: headerError.message,
            operation: "validate CSV headers",
            ...headerError
          },
          { status: 400 }
        );
      }
    }

    const supabase = createServiceSupabase();
    const questionIds = body.rows
      .map((row) => String(row.question_id ?? "").trim())
      .filter((questionId): questionId is string => Boolean(questionId));

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

    let insertedCount = 0;
    let updatedCount = 0;
    const failedRows: FailedRow[] = [];

    for (let index = 0; index < body.rows.length; index += 1) {
      const normalized = normalizeRow(body.rows[index]);
      const rowNumber = index + 2;
      const validationError = validateRow(normalized);

      if (validationError) {
        failedRows.push({
          rowNumber,
          questionId: normalized.question_id,
          reason: validationError,
          operation: "validate row"
        });
        continue;
      }

      const questionOrder = Number(normalized.question_order);
      const blankCount = Number(normalized.blank_count);

      const { error: setError } = await supabase.from("question_sets").upsert(
        {
          set_id: String(normalized.set_id),
          set_title: normalized.set_title,
          is_active: true,
          created_by: auth.userId
        },
        { onConflict: "set_id" }
      );

      if (setError) {
        const serialized = serializeError(setError);
        console.error("Teacher CSV import row failed", {
          batch: `CSV row ${rowNumber}`,
          error: setError,
          operation: "upsert question_sets",
          questionId: normalized.question_id,
          rowNumber
        });
        failedRows.push({
          rowNumber,
          questionId: normalized.question_id,
          reason: serialized.message,
          operation: "upsert question_sets",
          code: serialized.code,
          details: serialized.details,
          hint: serialized.hint
        });
        continue;
      }

      const wasExisting = existingIds.has(normalized.question_id);
      const { error: questionError } = await supabase.from("questions").upsert(
        {
          question_id: String(normalized.question_id),
          set_id: String(normalized.set_id),
          set_title: normalized.set_title,
          question_order: questionOrder,
          prompt: normalized.prompt,
          sentence_template: normalized.sentence_template,
          blank_count: blankCount,
          options_text: normalized.options_text,
          correct_order_text: normalized.correct_order_text,
          distractors_text: normalized.distractors_text,
          final_sentence: normalized.final_sentence,
          grammar_tags_text: normalized.grammar_tags_text
        },
        { onConflict: "question_id" }
      );

      if (questionError) {
        const serialized = serializeError(questionError);
        console.error("Teacher CSV import row failed", {
          batch: `CSV row ${rowNumber}`,
          error: questionError,
          operation: "upsert questions",
          questionId: normalized.question_id,
          rowNumber
        });
        failedRows.push({
          rowNumber,
          questionId: normalized.question_id,
          reason: serialized.message,
          operation: "upsert questions",
          code: serialized.code,
          details: serialized.details,
          hint: serialized.hint
        });
        continue;
      }

      if (wasExisting) {
        updatedCount += 1;
      } else {
        insertedCount += 1;
        existingIds.add(normalized.question_id);
      }
    }

    return NextResponse.json({
      successCount: insertedCount + updatedCount,
      insertedCount,
      updatedCount,
      failedCount: failedRows.length,
      failedRows
    });
  } catch (error) {
    return jsonImportError({
      error,
      operation: "import CSV questions"
    });
  }
}
