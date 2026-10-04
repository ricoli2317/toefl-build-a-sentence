import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { loadTeacherWritingReviewScores } from "./teacherStudentPractice.server.ts";
import type { PracticeHistoryLoadScope } from "./teacherStudentPractice.ts";
import {
  buildTeacherStudentPracticeRange,
  type TeacherPracticeRangeReadingInput,
  type TeacherPracticeRangeWritingInput,
  type TeacherRangeBasAttemptRow,
  type TeacherRangeFullSetAttemptRow,
  type TeacherRangeFullSetModuleRow,
  type TeacherRangeReadingAttemptRow,
  type TeacherRangeWrongbookAttemptRow,
  type TeacherRangeWrongbookSessionRow,
  type TeacherRangeWritingAttemptRow,
  type TeacherStudentPracticeRangeStats
} from "./teacherStudentPracticeRange.ts";

/**
 * Loads only the numbers the range statistics need. Every query is scoped to
 * one student and one time range and selects identity / scoring columns only —
 * never question text, answers, practice records, correction detail or Full Set
 * review content. Full Set accuracy comes from the module rows' stored grading
 * points, so no Full Set answers are read at all.
 */
export async function loadTeacherStudentPracticeRange(
  db: SupabaseClient,
  studentId: string,
  startAt: string,
  endAt: string,
  timeZone: string,
  allowed: { reading: boolean; writing: boolean },
  scope?: PracticeHistoryLoadScope
): Promise<TeacherStudentPracticeRangeStats> {
  const includeWrongbook = scope?.includeWrongbook !== false;
  const [reading, writing] = await Promise.all([
    allowed.reading
      ? loadReadingRange(db, studentId, startAt, endAt, includeWrongbook)
      : Promise.resolve(null),
    allowed.writing
      ? loadWritingRange(db, studentId, startAt, endAt)
      : Promise.resolve(null)
  ]);

  return buildTeacherStudentPracticeRange({
    reading,
    writing,
    timeZone,
    startAt,
    endAt,
    includeWrongbook,
    includeVirtualBas: scope?.includeVirtualBas !== false
  });
}

async function loadReadingRange(
  db: SupabaseClient,
  studentId: string,
  startAt: string,
  endAt: string,
  includeWrongbook: boolean
): Promise<TeacherPracticeRangeReadingInput> {
  // The student practice history never shows Entry / 今日错题 / 历史错题
  // counters, so it skips the wrong-question attempt and session queries
  // entirely instead of loading rows the day list will not display.
  const [attemptsResult, wrongbookResult, sessionsResult, fullSetResult] = await Promise.all([
    readAllSupabaseRows<TeacherRangeReadingAttemptRow>((from, to) =>
      db
        .from("reading_attempts")
        .select("task_type,status,correct_points,total_points,submitted_at")
        .eq("student_id", studentId)
        .eq("status", "submitted")
        .gte("submitted_at", startAt)
        .lt("submitted_at", endAt)
        .order("submitted_at", { ascending: false })
        .range(from, to)
    ),
    includeWrongbook
      ? readAllSupabaseRows<TeacherRangeWrongbookAttemptRow>((from, to) =>
          db
            .from("reading_wrongbook_attempts")
            .select("attempt_id,status,submitted_at")
            .eq("student_id", studentId)
            .eq("status", "submitted")
            .gte("submitted_at", startAt)
            .lt("submitted_at", endAt)
            .order("submitted_at", { ascending: false })
            .range(from, to)
        )
      : Promise.resolve({
          data: [] as TeacherRangeWrongbookAttemptRow[],
          error: null as { message: string } | null
        }),
    // Sessions own their attempts for Entry classification. Only sessions that
    // can still touch this range are read: created before the range ends and
    // either unfinished or completed inside/after the range start.
    includeWrongbook
      ? readAllSupabaseRows<TeacherRangeWrongbookSessionRow>((from, to) =>
          db
            .from("student_wrong_question_sessions")
            .select("session_id,mode,status,completed_at,progress")
            .eq("student_id", studentId)
            .lt("created_at", endAt)
            .or(`completed_at.is.null,completed_at.gte.${startAt}`)
            .order("session_id", { ascending: true })
            .range(from, to)
        )
      : Promise.resolve({
          data: [] as TeacherRangeWrongbookSessionRow[],
          error: null as { message: string } | null
        }),
    readAllSupabaseRows<TeacherRangeFullSetAttemptRow>((from, to) =>
      db
        .from("reading_full_set_attempts")
        .select("attempt_id,completed_at")
        .eq("student_id", studentId)
        .eq("status", "completed")
        .gte("completed_at", startAt)
        .lt("completed_at", endAt)
        .order("completed_at", { ascending: false })
        .range(from, to)
    )
  ]);
  const queryError = attemptsResult.error
    ?? wrongbookResult.error
    ?? sessionsResult.error
    ?? fullSetResult.error;
  if (queryError) throw new Error(queryError.message);

  const fullSetAttemptIds = (fullSetResult.data ?? []).map((attempt) =>
    String(attempt.attempt_id));
  const modulesResult = fullSetAttemptIds.length
    ? await readAllSupabaseRows<TeacherRangeFullSetModuleRow>((from, to) =>
        db
          .from("reading_full_set_module_attempts")
          .select("attempt_id,module_attempt_id,correct_points,total_points")
          .in("attempt_id", fullSetAttemptIds)
          .eq("status", "submitted")
          .range(from, to)
      )
    : { data: [] as TeacherRangeFullSetModuleRow[], error: null };
  if (modulesResult.error) throw new Error(modulesResult.error.message);

  return {
    attempts: attemptsResult.data ?? [],
    wrongbookAttempts: wrongbookResult.data ?? [],
    sessions: sessionsResult.data ?? [],
    fullSetAttempts: fullSetResult.data ?? [],
    fullSetModules: modulesResult.data ?? []
  };
}

async function loadWritingRange(
  db: SupabaseClient,
  studentId: string,
  startAt: string,
  endAt: string
): Promise<TeacherPracticeRangeWritingInput> {
  const [basResult, writingResult] = await Promise.all([
    readAllSupabaseRows<TeacherRangeBasAttemptRow>((from, to) =>
      db
        .from("attempts")
        .select("set_id,set_title,correct_count,total_questions,submitted_at")
        .eq("student_id", studentId)
        .gte("submitted_at", startAt)
        .lt("submitted_at", endAt)
        .order("submitted_at", { ascending: false })
        .range(from, to)
    ),
    readAllSupabaseRows<TeacherRangeWritingAttemptRow>((from, to) =>
      db
        .from("writing_attempts")
        .select("attempt_id,task_type,submitted_at")
        .eq("user_id", studentId)
        .eq("status", "submitted")
        .gte("submitted_at", startAt)
        .lt("submitted_at", endAt)
        .order("submitted_at", { ascending: false })
        .range(from, to)
    )
  ]);
  const queryError = basResult.error ?? writingResult.error;
  if (queryError) throw new Error(queryError.message);

  const writingAttempts = writingResult.data ?? [];
  const reviewScores = await loadTeacherWritingReviewScores(
    db,
    writingAttempts.map((attempt) => String(attempt.attempt_id))
  );

  return {
    basAttempts: basResult.data ?? [],
    writingAttempts,
    reviewScores
  };
}
