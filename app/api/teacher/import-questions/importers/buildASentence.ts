import { BUILD_A_SENTENCE_HEADERS } from "@/lib/questionCsvSchemas";
import { parseBuildSentenceOccurrences } from "@/lib/practiceImporter/occurrences";
import {
  buildSentenceInput,
  loadBuildSentenceCatalog,
  reconcilePracticeItemNumbers,
  syncBuildSentenceLogicalSource
} from "@/lib/practiceImporter/server";
import type { NumberingReconciliationItem } from "@/lib/practiceImporter/types";
import { parseTextArray } from "@/lib/practiceImporter/normalization";
import {
  addLogicalImportOutcome,
  chunkRows,
  emptyLogicalImportMetrics,
  importResult,
  serializeError
} from "./common";
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

  for (const field of ["options_text", "correct_order_text", "distractors_text"] as const) {
    try {
      parseTextArray(row[field], field, field === "distractors_text");
    } catch (error) {
      return error instanceof Error ? error.message : `${field} must be a JSON string array`;
    }
  }

  return null;
}

function normalizeRow(row: Record<string, string>) {
  return Object.fromEntries(
    BUILD_A_SENTENCE_HEADERS.map((field) => [field, String(row[field] ?? "")])
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
  const logicalMetrics = emptyLogicalImportMetrics();
  const numberingReconciliationItems: NumberingReconciliationItem[] = [];

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

  const validBySet = new Map<string, ValidImportRow[]>();
  for (const validRow of validRows) {
    validBySet.set(validRow.row.set_id, [
      ...(validBySet.get(validRow.row.set_id) ?? []),
      validRow
    ]);
  }
  const rejectedSetIds = new Set<string>();
  validBySet.forEach((setRows, setId) => {
    let reason: string | null = null;
    try {
      parseBuildSentenceOccurrences(setId, setRows[0]?.row.set_title);
    } catch (error) {
      reason = error instanceof Error ? error.message : "Unable to parse BAS occurrence";
    }
    if (reason) {
      rejectedSetIds.add(setId);
      for (const { row, rowNumber } of setRows) {
        failedRows.push({
          rowNumber,
          questionId: row.question_id,
          setId,
          reason,
          operation: "validate logical BAS set"
        });
      }
    }
  });
  const importableValidRows = validRows.filter(({ row }) => !rejectedSetIds.has(row.set_id));

  const questionIds = importableValidRows.map(({ row }) => row.question_id);
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
      importableValidRows.map(({ row }) => [
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
        for (const { row, rowNumber } of importableValidRows) {
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
        return importResult(0, 0, failedRows, warnings, logicalMetrics);
      }
    }
  }

  let insertedCount = 0;
  let updatedCount = 0;
  const successfulRows: ValidImportRow[] = [];
  const questionBatches = chunkRows(importableValidRows, QUESTION_BATCH_SIZE);

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
    successfulRows.push(...batch);
  }

  if (successfulRows.length > 0) {
    const catalog = await loadBuildSentenceCatalog(supabase);
    const successfulBySet = new Map<string, ValidImportRow[]>();
    for (const successfulRow of successfulRows) {
      successfulBySet.set(successfulRow.row.set_id, [
        ...(successfulBySet.get(successfulRow.row.set_id) ?? []),
        successfulRow
      ]);
    }
    const logicalSets = Array.from(successfulBySet.entries())
      .map(([setId, setRows]) => ({
        setId,
        setRows,
        occurrences: parseBuildSentenceOccurrences(setId, setRows[0].row.set_title)
      }))
      .sort(
        (left, right) =>
          left.occurrences[0].occurredOn.localeCompare(right.occurrences[0].occurredOn) ||
          left.setId.localeCompare(right.setId)
      );

    for (const logicalSet of logicalSets) {
      try {
        const { data: completeSetRows, error: completeSetError } = await supabase
          .from("questions")
          .select("question_id,set_id,question_order,sentence_template,blank_count,correct_order_text,options_text,distractors_text,final_sentence")
          .eq("set_id", logicalSet.setId)
          .order("question_order", { ascending: true });
        if (completeSetError) {
          throw Object.assign(completeSetError, { operation: "load complete BAS source" });
        }
        const outcome = await syncBuildSentenceLogicalSource({
          catalog,
          occurrences: logicalSet.occurrences,
          questions: (completeSetRows ?? []).map((row) => buildSentenceInput(row)),
          setId: logicalSet.setId,
          supabase
        });
        addLogicalImportOutcome(logicalMetrics, outcome);
        if (outcome.numberingReconciliation) {
          numberingReconciliationItems.push(outcome.numberingReconciliation);
        }
      } catch (error) {
        const serialized = serializeError(error);
        for (const { row, rowNumber } of logicalSet.setRows) {
          failedRows.push({
            rowNumber,
            questionId: row.question_id,
            setId: row.set_id,
            reason: serialized.message,
            operation: "sync logical BAS source",
            code: serialized.code,
            details: serialized.details,
            hint: serialized.hint
          });
        }
      }
    }
    await reconcilePracticeItemNumbers(
      supabase,
      "build_sentence",
      numberingReconciliationItems
    );
  }

  return importResult(insertedCount, updatedCount, failedRows, warnings, logicalMetrics);
}
