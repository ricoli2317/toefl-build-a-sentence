import type { SupabaseClient } from "@supabase/supabase-js";
import { mapWithConcurrency } from "./mapWithConcurrency.ts";
import { loadReadingFullSetFinalSnapshot } from "./reading/fullSetReviewServer.ts";
import { readingFullSetReviewTotalTime, type ReadingFullSetReviewPayload } from "./reading/fullSetReview.ts";
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
import type { TeacherReadingAttemptReviewPayload, TeacherReadingResultSummary } from "./teacherStudentPractice.ts";
import type { WrongQuestionSessionGroup } from "./wrongQuestionBank.ts";
import type { ReadingWrongbookTarget } from "./wrongQuestions.ts";

type TeacherReadingAttemptDetailRow = {
  attempt_id: string;
  logical_item_id: string;
  task_type: string;
  status: string;
  submitted_at: string | null;
  elapsed_seconds: number | null;
  correct_points: number | null;
  total_points: number | null;
};

/**
 * Loads one submitted Reading attempt on demand for the teacher drill-down.
 * The attempt is located by attempt_id and student_id together, so repeated
 * practices of the same item can never resolve to a different attempt.
 *
 * The attempt carries the same result numbers the student result page shows,
 * so the teacher can open the student-shaped result view first and only then a
 * read-only question page.
 */
export async function loadTeacherStudentReadingAttemptReview(
  db: SupabaseClient,
  studentId: string,
  attemptId: string
): Promise<TeacherReadingAttemptReviewPayload | null> {
  const attemptResult = await db
    .from("reading_attempts")
    .select("attempt_id,logical_item_id,task_type,status,submitted_at,elapsed_seconds,correct_points,total_points")
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
      submittedAt: attempt.submitted_at,
      correctPoints: nonNegativeInteger(attempt.correct_points),
      totalPoints: nonNegativeInteger(attempt.total_points),
      elapsedSeconds: nonNegativeInteger(attempt.elapsed_seconds)
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
  elapsed_seconds: number | null;
  correct_points: number | null;
  total_points: number | null;
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
    .select("attempt_id,logical_item_id,task_type,status,started_at,submitted_at,scope,targets,elapsed_seconds,correct_points,total_points")
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
      submittedAt: attempt.submitted_at,
      correctPoints: nonNegativeInteger(attempt.correct_points),
      totalPoints: nonNegativeInteger(attempt.total_points),
      elapsedSeconds: nonNegativeInteger(attempt.elapsed_seconds)
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
 *
 * The summary mirrors the student's session result numbers (summed over the
 * session's sources) so the teacher opens the result view first.
 */
/**
 * Result of resolving a wrongbook attempt back to its frozen session.
 *
 * `none`       — the attempt is not part of any session (entry / Full Set
 *                correction): the single-attempt view is correct.
 * `incomplete` — the attempt belongs to a session the student has not finished.
 *                No result page exists for it and a single-material view would
 *                misrepresent the practice, so callers must show the
 *                not-finished state instead.
 * `session`    — the finished session's result summary + read-only review.
 */
export type TeacherReadingWrongbookSessionLookup =
  | { kind: "none" }
  | { kind: "incomplete" }
  | {
      kind: "session";
      review: ReadingWrongbookSessionReviewPayload;
      summary: TeacherReadingResultSummary;
    };

export async function loadTeacherStudentReadingWrongbookSessionDetail(
  db: SupabaseClient,
  studentId: string,
  attemptId: string
): Promise<TeacherReadingWrongbookSessionLookup> {
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
  if (!session) return { kind: "none" };
  // A reading correction can only belong to a reading session. A malformed row
  // must fail loudly rather than fall back to a single-material read-only page.
  if (!isReadingModuleTaskType(session.task_type)) {
    throw new Error("TEACHER_READING_SESSION_TASK_TYPE_INVALID");
  }
  const groups = Array.isArray(session.manifest?.groups) ? session.manifest!.groups : [];
  if (groups.length === 0) throw new Error("TEACHER_READING_SESSION_MANIFEST_MISSING");
  // Unfinished: the student page sends the student back to keep practising and
  // has no result; never render the completed part as a material-sized review.
  if (groups.some((group) => !session.progress?.[group.logicalItemId]?.attemptId)) {
    return { kind: "incomplete" };
  }

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
  if (reviews.some((review) => !review)) {
    throw new Error("TEACHER_READING_SESSION_SOURCE_MISSING");
  }
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
  const review = {
    ...payload,
    reviewItems: payload.reviewItems.map(({ href: _href, ...item }) => item)
  };
  // Same aggregation rule as the student session result: one scoring point per
  // answer row, summed across the session's sources in frozen order.
  let correctPoints = 0;
  let elapsedSeconds = 0;
  let totalPoints = 0;
  let submittedAt = String(session.created_at ?? "");
  for (const reviewEntry of reviews) {
    if (!reviewEntry) continue;
    correctPoints += nonNegativeInteger(reviewEntry.attempt.correctPoints);
    elapsedSeconds += nonNegativeInteger(reviewEntry.attempt.elapsedSeconds);
    totalPoints += nonNegativeInteger(reviewEntry.attempt.totalPoints);
    if (reviewEntry.attempt.submittedAt) submittedAt = reviewEntry.attempt.submittedAt;
  }
  return {
    kind: "session",
    review,
    summary: {
      correctPoints,
      elapsedSeconds,
      submittedAt,
      title: session.mode === "today" ? "今日错题订正" : "历史错题练习",
      totalPoints
    }
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
): Promise<{ review: ReadingFullSetReviewPayload; summary: TeacherReadingResultSummary } | null> {
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
  const review = {
    ...snapshot.review,
    reviewItems: snapshot.review.reviewItems.map(({ href: _href, ...item }) => item)
  };
  // The student Full Set result summary: one scoring point per answer row, the
  // official score display, and the review total time (unknown stays unknown).
  const answers = snapshot.result.answers;
  return {
    review,
    summary: {
      correctPoints: answers.filter((answer) => answer.isCorrect).length,
      elapsedSeconds: readingFullSetReviewTotalTime(answers),
      scoreDisplay: snapshot.result.score.display,
      submittedAt: snapshot.result.attempt.completedAt,
      title: snapshot.result.attempt.title,
      totalPoints: answers.length
    }
  };
}

function isReadingModuleTaskType(value: string): value is ReadingModule {
  return value === "ctw" || value === "rdl" || value === "rap";
}

function nonNegativeInteger(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}
