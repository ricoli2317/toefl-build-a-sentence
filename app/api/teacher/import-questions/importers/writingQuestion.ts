import { chunkRows, importResult, serializeError } from "./common";
import type { FailedRow, ImporterContext } from "./types";

const LOOKUP_BATCH_SIZE = 100;

type WritingImporterConfig = {
  fields: readonly string[];
  table: "email_questions" | "academic_discussion_questions";
  upsertOperation: string;
};

type ValidWritingRow = {
  payload: Record<string, string>;
  questionId: string;
  rowNumber: number;
  setId: string;
};

function normalizeWritingRow(row: Record<string, string>, fields: readonly string[]) {
  return Object.fromEntries(fields.map((field) => [field, String(row[field] ?? "")])) as Record<
    string,
    string
  >;
}

function validateRequiredFields(row: Record<string, string>, fields: readonly string[]) {
  return fields.find((field) => !row[field]?.trim()) ?? null;
}

function setIdConflictReason(conflictingQuestionId: string) {
  return `set_id 已被另一条 question_id 使用（${conflictingQuestionId}）`;
}

function databaseWriteReason(error: unknown) {
  const serialized = serializeError(error);
  const isUniqueSetIdConflict =
    serialized.code === "23505" &&
    `${serialized.message} ${serialized.details ?? ""}`.toLocaleLowerCase().includes("set_id");

  return isUniqueSetIdConflict ? "set_id 已被另一条 question_id 使用" : serialized.message;
}

export async function importWritingQuestions(
  { rows, supabase }: ImporterContext,
  config: WritingImporterConfig
) {
  const failedRows: FailedRow[] = [];
  const validRows: ValidWritingRow[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const payload = normalizeWritingRow(rows[index], config.fields);
    const questionId = payload.question_id;
    const rowNumber = index + 2;
    const setId = payload.set_id;
    const missingField = validateRequiredFields(payload, config.fields);

    if (missingField) {
      failedRows.push({
        rowNumber,
        questionId,
        setId,
        reason: `Missing ${missingField}`,
        operation: "validate row"
      });
      continue;
    }

    validRows.push({ payload, questionId, rowNumber, setId });
  }

  const existingByQuestionId = new Map<string, string>();
  const existingBySetId = new Map<string, string>();
  const questionIds = Array.from(new Set(validRows.map((row) => row.questionId)));
  const setIds = Array.from(new Set(validRows.map((row) => row.setId)));

  for (const batch of chunkRows(questionIds, LOOKUP_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from(config.table)
      .select("question_id,set_id")
      .in("question_id", batch);
    if (error) throw Object.assign(error, { operation: "read existing writing question IDs" });
    for (const item of data ?? []) {
      existingByQuestionId.set(String(item.question_id), String(item.set_id));
      existingBySetId.set(String(item.set_id), String(item.question_id));
    }
  }

  for (const batch of chunkRows(setIds, LOOKUP_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from(config.table)
      .select("question_id,set_id")
      .in("set_id", batch);
    if (error) throw Object.assign(error, { operation: "read existing writing set IDs" });
    for (const item of data ?? []) {
      existingByQuestionId.set(String(item.question_id), String(item.set_id));
      existingBySetId.set(String(item.set_id), String(item.question_id));
    }
  }

  const importableRows: ValidWritingRow[] = [];
  const csvQuestionIds = new Set<string>();
  const csvSetIds = new Map<string, string>();

  for (const row of validRows) {
    if (csvQuestionIds.has(row.questionId)) {
      failedRows.push({
        rowNumber: row.rowNumber,
        questionId: row.questionId,
        setId: row.setId,
        reason: "CSV 中存在重复的 question_id",
        operation: "validate row"
      });
      continue;
    }

    const existingSetOwner = existingBySetId.get(row.setId);
    const csvSetOwner = csvSetIds.get(row.setId);
    const conflictingQuestionId =
      existingSetOwner && existingSetOwner !== row.questionId
        ? existingSetOwner
        : csvSetOwner && csvSetOwner !== row.questionId
          ? csvSetOwner
          : null;

    if (conflictingQuestionId) {
      failedRows.push({
        rowNumber: row.rowNumber,
        questionId: row.questionId,
        setId: row.setId,
        reason: setIdConflictReason(conflictingQuestionId),
        operation: "validate set_id uniqueness"
      });
      continue;
    }

    csvQuestionIds.add(row.questionId);
    csvSetIds.set(row.setId, row.questionId);
    importableRows.push(row);
  }

  let insertedCount = 0;
  let updatedCount = 0;

  for (const row of importableRows) {
    const { error } = await supabase
      .from(config.table)
      .upsert(row.payload, { onConflict: "question_id" });

    if (error) {
      const serialized = serializeError(error);
      failedRows.push({
        rowNumber: row.rowNumber,
        questionId: row.questionId,
        setId: row.setId,
        reason: databaseWriteReason(error),
        operation: config.upsertOperation,
        code: serialized.code,
        details: serialized.details,
        hint: serialized.hint
      });
      continue;
    }

    if (existingByQuestionId.has(row.questionId)) updatedCount += 1;
    else {
      insertedCount += 1;
      existingByQuestionId.set(row.questionId, row.setId);
    }
  }

  return importResult(insertedCount, updatedCount, failedRows);
}
