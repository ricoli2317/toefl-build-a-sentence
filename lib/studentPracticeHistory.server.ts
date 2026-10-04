import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadTeacherStudentReadingPractice,
  loadTeacherStudentWritingPractice,
  type TeacherReadingCatalogLoader
} from "./teacherStudentPractice.server.ts";
import { loadTeacherStudentPracticeRange } from "./teacherStudentPracticeRange.server.ts";
import type {
  StudentPracticeHistoryDayPayload,
  StudentPracticeHistoryRangePayload
} from "./studentPracticeHistory.ts";

/**
 * The student practice history reuses the teacher student-detail loaders with
 * the seven-public-task-type scope: wrong-question corrections, their frozen
 * sessions and the virtual BAS id spaces stay out, so the page never duplicates
 * the wrong-question bank. Every query stays scoped to the authenticated
 * student id the caller passes in (never a client-supplied student id).
 */
const STUDENT_PRACTICE_HISTORY_SCOPE = {
  includeWrongbook: false,
  includeVirtualBas: false
} as const;

export async function loadStudentPracticeHistoryDay(
  db: SupabaseClient,
  studentId: string,
  startAt: string,
  endAt: string,
  loadCatalog: TeacherReadingCatalogLoader
): Promise<StudentPracticeHistoryDayPayload> {
  const [reading, writing] = await Promise.all([
    loadTeacherStudentReadingPractice(
      db,
      studentId,
      startAt,
      endAt,
      loadCatalog,
      STUDENT_PRACTICE_HISTORY_SCOPE
    ),
    loadTeacherStudentWritingPractice(
      db,
      studentId,
      startAt,
      endAt,
      STUDENT_PRACTICE_HISTORY_SCOPE
    )
  ]);
  return { range: { startAt, endAt }, reading, writing };
}

export async function loadStudentPracticeHistoryRange(
  db: SupabaseClient,
  studentId: string,
  startAt: string,
  endAt: string,
  timeZone: string
): Promise<StudentPracticeHistoryRangePayload> {
  const stats = await loadTeacherStudentPracticeRange(
    db,
    studentId,
    startAt,
    endAt,
    timeZone,
    { reading: true, writing: true },
    STUDENT_PRACTICE_HISTORY_SCOPE
  );
  return {
    range: { startAt, endAt, timeZone },
    reading: stats.reading,
    writing: stats.writing,
    days: stats.days
  };
}
