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

export async function POST(request: Request) {
  const auth = await requireUserWithRole(bearerToken(request), "teacher");
  if (auth.error || !auth.userId) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const body = (await request.json()) as { rows?: Partial<ImportQuestionRow>[] };
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: "Invalid import payload" }, { status: 400 });
  }

  const supabase = createServiceSupabase();
  const questionIds = body.rows
    .map((row) => row.question_id?.trim())
    .filter((questionId): questionId is string => Boolean(questionId));

  const existingIds = new Set<string>();
  if (questionIds.length > 0) {
    const { data, error } = await supabase
      .from("questions")
      .select("question_id")
      .in("question_id", questionIds);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    for (const item of data ?? []) {
      existingIds.add(item.question_id as string);
    }
  }

  let insertedCount = 0;
  let updatedCount = 0;
  const failedRows: FailedRow[] = [];

  for (let index = 0; index < body.rows.length; index += 1) {
    const row = body.rows[index];
    const rowNumber = index + 2;
    const validationError = validateRow(row);

    if (validationError) {
      failedRows.push({
        rowNumber,
        questionId: row.question_id ?? "",
        reason: validationError
      });
      continue;
    }

    const normalized = row as ImportQuestionRow;
    const questionOrder = Number(normalized.question_order);
    const blankCount = Number(normalized.blank_count);

    const { error: setError } = await supabase.from("question_sets").upsert(
      {
        set_id: normalized.set_id,
        set_title: normalized.set_title,
        is_active: true,
        created_by: auth.userId
      },
      { onConflict: "set_id" }
    );

    if (setError) {
      failedRows.push({
        rowNumber,
        questionId: normalized.question_id,
        reason: setError.message
      });
      continue;
    }

    const wasExisting = existingIds.has(normalized.question_id);
    const { error: questionError } = await supabase.from("questions").upsert(
      {
        question_id: normalized.question_id,
        set_id: normalized.set_id,
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
      failedRows.push({
        rowNumber,
        questionId: normalized.question_id,
        reason: questionError.message
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
}
