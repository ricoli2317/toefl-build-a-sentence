import type { SupabaseClient } from "@supabase/supabase-js";
import { mapWithConcurrency } from "./mapWithConcurrency.ts";
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
import {
  loadReadingCtwContextAnswers,
  loadReadingWrongbookPreservedAnswers
} from "./reading/wrongbook.server.ts";
import {
  buildReadingWrongbookSessionReviewPayload,
  type ReadingWrongbookSessionReviewGroup,
  type ReadingWrongbookSessionReviewPayload
} from "./reading/wrongbookSession.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import type { TeacherReadingAttemptReviewPayload } from "./teacherStudentPractice.ts";
import type { WrongQuestionSessionGroup } from "./wrongQuestionBank.ts";
import type { ReadingWrongbookTarget } from "./wrongQuestions.ts";

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
  scope: "history" | "today";
  targets: unknown;
};

/**
 * Wrongbook corrections reuse the same read-only payload shape as ordinary
 * attempts. Full-Set corrections keep their own student flow and are not
 * reachable from the student Reading list.
 *
 * The payload mirrors the student's correction review exactly: navigation
 * items are the correction targets only, the paragraph keeps preserved rows,
 * and (with `includeContext`, i.e. for history sessions) the untargeted CTW
 * slots carry the same read-only context the student sees.
 */
export async function loadTeacherStudentReadingWrongbookAttemptReview(
  db: SupabaseClient,
  studentId: string,
  attemptId: string,
  options?: { includeContext?: boolean }
): Promise<TeacherReadingAttemptReviewPayload | null> {
  const attemptResult = await db
    .from("reading_wrongbook_attempts")
    .select("attempt_id,logical_item_id,task_type,status,started_at,submitted_at,scope,targets")
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
  const correctionRows = (answerResult.data ?? []) as SubmittedReadingAnswerRow[];
  const rows = [
    ...correctionRows,
    ...preservedAnswers
  ] as SubmittedReadingAnswerRow[];
  const contextAnswers = options?.includeContext
    && attempt.task_type === "ctw"
    && attempt.scope === "history"
    ? await loadReadingCtwContextAnswers({
        db,
        logicalItemId: String(attempt.logical_item_id),
        targets
      })
    : [];
  return {
    attempt: {
      attemptId: String(attempt.attempt_id),
      logicalItemId: String(attempt.logical_item_id),
      taskType: attempt.task_type,
      submittedAt: attempt.submitted_at
    },
    answers: buildSubmittedReadingAnswerState(practice, rows, {
      tolerateMissingCtwSlots: true,
      contextAnswers
    }),
    disclosures: await loadReadingAnswerDisclosures(db, rows as ReadingDisclosureAnswerRow[]),
    practice,
    reviewItems: buildSubmittedReadingReviewItems(practice, correctionRows)
  };
}

type TeacherWrongbookSessionRow = {
  created_at: string;
  manifest: { groups?: WrongQuestionSessionGroup[]; kind?: string } | null;
  mode: "history" | "today";
  progress: Record<string, { attemptId?: string | null } | null> | null;
  session_id: string;
  task_type: string;
};

/**
 * Teacher drill-down for one wrong-question practice SESSION. The attempt id a
 * session record links to resolves back to its session, and the whole session
 * is rendered exactly like the student's session review: every material in the
 * frozen order, continuous global numbering, the same answers and correct
 * answers, and the same CTW context fill for history sessions. Returns null for
 * attempts that are not part of a session (entry / Full Set corrections), which
 * keep their single-attempt view.
 */
export async function loadTeacherStudentReadingWrongbookSessionReview(
  db: SupabaseClient,
  studentId: string,
  attemptId: string
): Promise<ReadingWrongbookSessionReviewPayload | null> {
  const sessionsResult = await readAllSupabaseRows<TeacherWrongbookSessionRow>((from, to) =>
    db
      .from("student_wrong_question_sessions")
      .select("session_id,task_type,mode,manifest,progress,created_at")
      .eq("student_id", studentId)
      .order("created_at", { ascending: false })
      .order("session_id", { ascending: true })
      .range(from, to)
  );
  if (sessionsResult.error) throw new Error(sessionsResult.error.message);
  const session = (sessionsResult.data ?? []).find((row) =>
    Object.values(row.progress ?? {}).some((entry) => entry?.attemptId === attemptId));
  if (!session) return null;
  if (!isReadingModuleTaskType(session.task_type)) return null;
  const groups = Array.isArray(session.manifest?.groups) ? session.manifest!.groups : [];
  if (groups.length === 0) return null;

  const includeContext = session.mode === "history";
  const reviews = await mapWithConcurrency(groups, 3, async (group) => {
    const progress = session.progress?.[group.logicalItemId];
    if (!progress?.attemptId) return null;
    return loadTeacherStudentReadingWrongbookAttemptReview(
      db,
      studentId,
      String(progress.attemptId),
      { includeContext }
    );
  });
  if (reviews.some((review) => !review)) return null;
  const groupReviews: ReadingWrongbookSessionReviewGroup[] = groups.map((group, index) => ({
    group,
    payload: reviews[index]!
  }));
  const payload = buildReadingWrongbookSessionReviewPayload({
    groupReviews,
    reviewHref: () => "",
    sessionId: String(session.session_id),
    taskType: session.task_type,
    title: session.mode === "today" ? "今日错题订正" : "历史错题练习"
  });
  // Teacher navigation stays in memory; student-only question hrefs are dropped.
  return {
    ...payload,
    reviewItems: payload.reviewItems.map(({ href: _href, ...item }) => item)
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
