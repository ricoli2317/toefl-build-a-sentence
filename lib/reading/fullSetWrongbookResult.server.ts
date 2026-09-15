import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReadingCorrectionResultAnswer } from "./correctionResult";
import type { ReadingAnswerRow } from "./history";
import { loadReadingFullSets } from "./fullSets.server";
import { buildSubmittedReadingAnswerState, type SubmittedReadingAnswerRow } from "./review";
import { loadReadingAnswerDisclosures } from "./reviewDisclosures.server";
import { loadStudentReadingPractice } from "./studentPractice";
import { selectReadingWrongbookPractice } from "./wrongbook";
import { loadReadingFullSetPreservedAnswers } from "./fullSetWrongbook.server";
import type { ReadingFullSetWrongbookTarget } from "../wrongQuestions";

export type FullSetWrongbookAttemptRow = {
  attempt_id: string;
  correct_points: number;
  elapsed_seconds: number;
  source_attempt_id: string;
  source_full_set_id: string;
  started_at: string;
  status: string;
  submitted_at: string | null;
  targets: ReadingFullSetWrongbookTarget[];
  total_points: number;
};

type CorrectionRow = ReadingAnswerRow & {
  logical_item_id: string;
  source_occurrence_id: string;
};

export type ReadingFullSetWrongbookReviewItem = {
  answerId: string;
  isAnswered: boolean;
  isCorrect: boolean;
  moduleNumber: 1 | 2;
  occurrenceId: string;
  order: number;
  questionId: string;
  questionTimeSeconds: number | null;
  slotId: string | null;
  taskType: ReadingFullSetWrongbookTarget["taskType"];
};

export async function loadReadingFullSetWrongbookResultData(input: {
  attempt: FullSetWrongbookAttemptRow;
  db: SupabaseClient;
}) {
  const { attempt, db } = input;
  if (attempt.status !== "submitted" || !attempt.submitted_at) throw new Error("READING_WRONGBOOK_NOT_SUBMITTED");
  const answerResult = await db.from("reading_wrongbook_attempt_answers")
    .select("attempt_answer_id,logical_item_id,question_id,slot_id,answer_kind,student_answer,is_correct,question_time_seconds,source_occurrence_id")
    .eq("attempt_id", attempt.attempt_id);
  if (answerResult.error) throw new Error(answerResult.error.message);
  const rows = (answerResult.data ?? []) as CorrectionRow[];
  if (!rows.length) throw new Error("READING_FULL_SET_CORRECTION_ANSWERS_MISSING");
  const targetByKey = new Map(attempt.targets.map((target) => [targetKey(target), target]));
  const orderedRows = rows.sort((left, right) => {
    const leftTarget = targetByKey.get(rowKey(left));
    const rightTarget = targetByKey.get(rowKey(right));
    return (leftTarget?.moduleNumber ?? 0) - (rightTarget?.moduleNumber ?? 0)
      || (leftTarget?.order ?? 0) - (rightTarget?.order ?? 0)
      || left.attempt_answer_id.localeCompare(right.attempt_answer_id);
  });
  const presentations = await loadReadingAnswerDisclosures(db, orderedRows);
  const fullSets = await loadReadingFullSets(db);
  const fullSet = fullSets.find((candidate) => candidate.fullSetId === attempt.source_full_set_id);
  const title = fullSet?.title ?? attempt.source_full_set_id;
  const answers = orderedRows.map((row, reviewIndex): ReadingCorrectionResultAnswer => {
    const target = targetByKey.get(rowKey(row));
    const presentation = presentations[row.attempt_answer_id];
    if (!target || !presentation) throw new Error("READING_FULL_SET_CORRECTION_TARGET_MISSING");
    return {
      answerId: row.attempt_answer_id,
      correctAnswer: presentation.correctAnswer,
      isAnswered: Boolean(row.student_answer?.trim()),
      isCorrect: row.is_correct,
      order: target.order,
      questionId: row.question_id,
      questionTimeSeconds: row.question_time_seconds,
      reviewIndex,
      studentAnswer: presentation.studentAnswer
    };
  });
  return { answers, presentations, rows: orderedRows, title };
}

export async function loadReadingFullSetWrongbookReviewData(input: {
  attempt: FullSetWrongbookAttemptRow;
  db: SupabaseClient;
}) {
  const base = await loadReadingFullSetWrongbookResultData(input);
  const targetGroups = new Map<string, ReadingFullSetWrongbookTarget[]>();
  for (const target of input.attempt.targets) {
    targetGroups.set(target.occurrenceId, [...(targetGroups.get(target.occurrenceId) ?? []), target]);
  }
  const occurrenceTargets = Array.from(targetGroups.values()).sort((left, right) =>
    (left[0]?.moduleNumber ?? 0) - (right[0]?.moduleNumber ?? 0)
    || (left[0]?.order ?? 0) - (right[0]?.order ?? 0)
  );
  const practices = await Promise.all(occurrenceTargets.map(async (targets) => {
    const first = targets[0];
    if (!first) throw new Error("READING_FULL_SET_CORRECTION_TARGET_MISSING");
    return selectReadingWrongbookPractice(await loadStudentReadingPractice(input.db, first.logicalItemId), targets);
  }));
  const preservedByOccurrence = await loadReadingFullSetPreservedAnswers({
    before: input.attempt.started_at,
    db: input.db,
    excludeAttemptId: input.attempt.attempt_id,
    sourceAttemptId: input.attempt.source_attempt_id,
    targets: occurrenceTargets.flatMap((targets) => targets)
  });
  const occurrences = occurrenceTargets.map((targets, index) => {
    const first = targets[0]!;
    const practice = practices[index];
    const correctionRows = base.rows.filter((row) => row.source_occurrence_id === first.occurrenceId);
    const preservedRows: SubmittedReadingAnswerRow[] = (preservedByOccurrence[first.occurrenceId] ?? []).map((answer, preservedIndex) => ({
      answer_kind: answer.answerKind,
      attempt_answer_id: `preserved:${first.occurrenceId}:${answer.questionId}:${answer.slotId ?? preservedIndex}`,
      is_correct: true,
      question_id: answer.questionId,
      slot_id: answer.slotId,
      student_answer: answer.studentAnswer
    }));
    return {
      answers: buildSubmittedReadingAnswerState(practice, [...correctionRows, ...preservedRows]),
      occurrenceId: first.occurrenceId,
      practice
    };
  });
  const reviewItems = base.rows.map((row): ReadingFullSetWrongbookReviewItem => {
    const target = input.attempt.targets.find((candidate) => targetKey(candidate) === rowKey(row));
    if (!target) throw new Error("READING_FULL_SET_CORRECTION_TARGET_MISSING");
    return {
      answerId: row.attempt_answer_id,
      isAnswered: Boolean(row.student_answer?.trim()),
      isCorrect: row.is_correct,
      moduleNumber: target.moduleNumber,
      occurrenceId: target.occurrenceId,
      order: target.order,
      questionId: target.questionId,
      questionTimeSeconds: row.question_time_seconds,
      slotId: target.slotId,
      taskType: target.taskType
    };
  });
  return { ...base, occurrences, reviewItems };
}

function targetKey(target: Pick<ReadingFullSetWrongbookTarget, "logicalItemId" | "occurrenceId" | "questionId" | "slotId">) {
  return [target.occurrenceId, target.logicalItemId, target.questionId, target.slotId ?? "question"].join(":");
}

function rowKey(row: Pick<CorrectionRow, "logical_item_id" | "source_occurrence_id" | "question_id" | "slot_id">) {
  return [row.source_occurrence_id, row.logical_item_id, row.question_id, row.slot_id ?? "question"].join(":");
}
