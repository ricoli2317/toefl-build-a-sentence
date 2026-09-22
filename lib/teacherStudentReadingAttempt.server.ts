import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReadingFullSetFinalSnapshot } from "./reading/fullSetReviewServer.ts";
import type { ReadingFullSetReviewPayload } from "./reading/fullSetReview.ts";
import {
  buildSubmittedReadingAnswerState,
  buildSubmittedReadingReviewItems,
  type SubmittedReadingAnswerRow
} from "./reading/review.ts";
import {
  loadReadingAnswerDisclosures,
  type ReadingDisclosureAnswerRow
} from "./reading/reviewDisclosures.server.ts";
import { loadStudentReadingPractice } from "./reading/studentPractice.ts";
import type { ReadingModule } from "./reading/types.ts";
import { selectReadingWrongbookPractice } from "./reading/wrongbook.ts";
import { loadReadingWrongbookPreservedAnswers } from "./reading/wrongbook.server.ts";
import type { ReadingWrongbookTarget } from "./wrongQuestions.ts";
import type { TeacherReadingAttemptReviewPayload } from "./teacherStudentPractice.ts";

type TeacherReadingAttemptDetailRow = {
  attempt_id: string;
  logical_item_id: string;
  task_type: string;
  status: string;
  submitted_at: string | null;
};

/**
 * Loads one submitted Reading attempt on demand for the teacher drill-down.
 * The attempt is located by attempt_id and student_id together, so repeated
 * practices of the same item can never resolve to a different attempt.
 */
export async function loadTeacherStudentReadingAttemptReview(
  db: SupabaseClient,
  studentId: string,
  attemptId: string
): Promise<TeacherReadingAttemptReviewPayload | null> {
  const attemptResult = await db
    .from("reading_attempts")
    .select("attempt_id,logical_item_id,task_type,status,submitted_at")
    .eq("attempt_id", attemptId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (attemptResult.error) throw new Error(attemptResult.error.message);
  const attempt = attemptResult.data as TeacherReadingAttemptDetailRow | null;
  if (!attempt || attempt.status !== "submitted" || !attempt.submitted_at) return null;
  if (!isReadingModuleTaskType(attempt.task_type)) return null;

  const practice = await loadStudentReadingPractice(db, String(attempt.logical_item_id));
  const answerResult = await db
    .from("reading_attempt_answers")
    .select(
      "attempt_answer_id,question_id,slot_id,answer_kind,student_answer,is_correct,question_time_seconds"
    )
    .eq("attempt_id", attemptId);
  if (answerResult.error) throw new Error(answerResult.error.message);
  const rows = (answerResult.data ?? []) as SubmittedReadingAnswerRow[];
  return {
    attempt: {
      attemptId: String(attempt.attempt_id),
      logicalItemId: String(attempt.logical_item_id),
      taskType: attempt.task_type,
      submittedAt: attempt.submitted_at
    },
    answers: buildSubmittedReadingAnswerState(practice, rows),
    disclosures: await loadReadingAnswerDisclosures(db, rows as ReadingDisclosureAnswerRow[]),
    practice,
    reviewItems: buildSubmittedReadingReviewItems(practice, rows)
  };
}

type TeacherReadingWrongbookAttemptDetailRow = {
  attempt_id: string;
  logical_item_id: string;
  task_type: string;
  status: string;
  started_at: string;
  submitted_at: string | null;
  targets: unknown;
};

/**
 * Wrongbook corrections reuse the same read-only payload shape as ordinary
 * attempts. Full-Set corrections keep their own student flow and are not
 * reachable from the student Reading list.
 */
export async function loadTeacherStudentReadingWrongbookAttemptReview(
  db: SupabaseClient,
  studentId: string,
  attemptId: string
): Promise<TeacherReadingAttemptReviewPayload | null> {
  const attemptResult = await db
    .from("reading_wrongbook_attempts")
    .select("attempt_id,logical_item_id,task_type,status,started_at,submitted_at,targets")
    .eq("attempt_id", attemptId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (attemptResult.error) throw new Error(attemptResult.error.message);
  const attempt = attemptResult.data as TeacherReadingWrongbookAttemptDetailRow | null;
  if (!attempt || attempt.status !== "submitted" || !attempt.submitted_at) return null;
  if (!isReadingModuleTaskType(attempt.task_type)) return null;
  const targets = Array.isArray(attempt.targets)
    ? attempt.targets as ReadingWrongbookTarget[]
    : [];
  if (targets.length === 0) return null;

  const fullPractice = await loadStudentReadingPractice(db, String(attempt.logical_item_id));
  const [answerResult, preservedAnswers] = await Promise.all([
    db
      .from("reading_wrongbook_attempt_answers")
      .select(
        "attempt_answer_id,question_id,slot_id,answer_kind,student_answer,is_correct,question_time_seconds"
      )
      .eq("attempt_id", attemptId),
    attempt.task_type === "ctw"
      ? loadReadingWrongbookPreservedAnswers({
          before: attempt.started_at,
          db,
          logicalItemId: String(attempt.logical_item_id),
          studentId,
          targets
        })
      : Promise.resolve([] as SubmittedReadingAnswerRow[])
  ]);
  if (answerResult.error) throw new Error(answerResult.error.message);

  const practice = selectReadingWrongbookPractice(fullPractice, targets);
  const rows = [
    ...(answerResult.data ?? []),
    ...preservedAnswers
  ] as SubmittedReadingAnswerRow[];
  return {
    attempt: {
      attemptId: String(attempt.attempt_id),
      logicalItemId: String(attempt.logical_item_id),
      taskType: attempt.task_type,
      submittedAt: attempt.submitted_at
    },
    answers: buildSubmittedReadingAnswerState(practice, rows),
    disclosures: await loadReadingAnswerDisclosures(db, rows as ReadingDisclosureAnswerRow[]),
    practice,
    reviewItems: buildSubmittedReadingReviewItems(practice, rows)
  };
}

type TeacherReadingFullSetAttemptDetailRow = {
  attempt_id: string;
  full_set_id: string;
  status: string;
  completed_at: string | null;
};

/**
 * Full Set attempts reuse the canonical final snapshot. Student review hrefs
 * are dropped: the teacher shell navigates between questions in memory.
 */
export async function loadTeacherStudentReadingFullSetAttemptReview(
  db: SupabaseClient,
  studentId: string,
  attemptId: string
): Promise<ReadingFullSetReviewPayload | null> {
  const attemptResult = await db
    .from("reading_full_set_attempts")
    .select("attempt_id,full_set_id,status,completed_at")
    .eq("attempt_id", attemptId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (attemptResult.error) throw new Error(attemptResult.error.message);
  const attempt = attemptResult.data as TeacherReadingFullSetAttemptDetailRow | null;
  if (!attempt || attempt.status !== "completed" || !attempt.completed_at) return null;

  const snapshot = await loadReadingFullSetFinalSnapshot(db, {
    attempt_id: String(attempt.attempt_id),
    full_set_id: String(attempt.full_set_id),
    status: String(attempt.status),
    completed_at: attempt.completed_at
  });
  return {
    ...snapshot.review,
    reviewItems: snapshot.review.reviewItems.map(({ href: _href, ...item }) => item)
  };
}

function isReadingModuleTaskType(value: string): value is ReadingModule {
  return value === "ctw" || value === "rdl" || value === "rap";
}
