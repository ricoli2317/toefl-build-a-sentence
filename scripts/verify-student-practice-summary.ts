import { readAllSupabaseRows } from "../lib/supabasePagination.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";
import {
  aggregateTeacherStudentPracticeSummaries,
  type TeacherStudentPracticeRow
} from "../lib/teacherStudentOverview.ts";

type SummaryRow = {
  student_id: string;
  total_practice_seconds: number | string | null;
  latest_practice_at: string | null;
};

type ReadingAttemptRow = {
  student_id: string;
  elapsed_seconds: number | null;
  submitted_at: string | null;
};

type BasAttemptRow = {
  student_id: string;
  time_spent_seconds: number | null;
  submitted_at: string | null;
};

type WritingAttemptRow = {
  user_id: string;
  elapsed_seconds: number | null;
  submitted_at: string | null;
};

type FullSetAttemptRow = {
  student_id: string;
  completed_at: string | null;
};

async function main() {
  const db = createServiceSupabase();
  const [summaryResult, readingResult, wrongbookResult, basResult, writingResult, fullSetResult] =
    await Promise.all([
      readAllSupabaseRows<SummaryRow>((from, to) =>
        db
          .from("student_practice_summary")
          .select("student_id,total_practice_seconds,latest_practice_at")
          .order("student_id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<ReadingAttemptRow>((from, to) =>
        db
          .from("reading_attempts")
          .select("student_id,elapsed_seconds,submitted_at")
          .eq("status", "submitted")
          .not("submitted_at", "is", null)
          .order("student_id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<ReadingAttemptRow>((from, to) =>
        db
          .from("reading_wrongbook_attempts")
          .select("student_id,elapsed_seconds,submitted_at")
          .eq("status", "submitted")
          .not("submitted_at", "is", null)
          .order("student_id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<BasAttemptRow>((from, to) =>
        db
          .from("attempts")
          .select("student_id,time_spent_seconds,submitted_at")
          .not("submitted_at", "is", null)
          .order("student_id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<WritingAttemptRow>((from, to) =>
        db
          .from("writing_attempts")
          .select("user_id,elapsed_seconds,submitted_at")
          .eq("status", "submitted")
          .not("submitted_at", "is", null)
          .order("user_id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<FullSetAttemptRow>((from, to) =>
        db
          .from("reading_full_set_attempts")
          .select("student_id,completed_at")
          .eq("status", "completed")
          .not("completed_at", "is", null)
          .order("student_id", { ascending: true })
          .range(from, to)
      )
    ]);

  const queryError =
    summaryResult.error ?? readingResult.error ?? wrongbookResult.error ??
    basResult.error ?? writingResult.error ?? fullSetResult.error;
  if (queryError) throw new Error(queryError.message);

  const practiceRows: TeacherStudentPracticeRow[] = [
    ...(readingResult.data ?? []).map((row) => ({
      studentId: String(row.student_id),
      source: "reading" as const,
      durationSeconds: row.elapsed_seconds,
      completedAt: row.submitted_at
    })),
    ...(wrongbookResult.data ?? []).map((row) => ({
      studentId: String(row.student_id),
      source: "reading-wrongbook" as const,
      durationSeconds: row.elapsed_seconds,
      completedAt: row.submitted_at
    })),
    ...(basResult.data ?? []).map((row) => ({
      studentId: String(row.student_id),
      source: "build-sentence" as const,
      durationSeconds: row.time_spent_seconds,
      completedAt: row.submitted_at
    })),
    ...(writingResult.data ?? []).map((row) => ({
      studentId: String(row.user_id),
      source: "writing" as const,
      durationSeconds: row.elapsed_seconds,
      completedAt: row.submitted_at
    })),
    ...(fullSetResult.data ?? []).map((row) => ({
      studentId: String(row.student_id),
      source: "reading-full-set" as const,
      durationSeconds: null,
      completedAt: row.completed_at
    }))
  ];

  const expected = aggregateTeacherStudentPracticeSummaries(practiceRows);
  const actual = new Map(
    (summaryResult.data ?? []).map((row) => [
      String(row.student_id),
      {
        totalPracticeSeconds: Number.isFinite(Number(row.total_practice_seconds))
          ? Math.max(0, Math.round(Number(row.total_practice_seconds)))
          : 0,
        latestPracticeAt: row.latest_practice_at
      }
    ])
  );

  const studentIds = Array.from(
    new Set([...Array.from(expected.keys()), ...Array.from(actual.keys())])
  ).sort();
  const totalMismatches: Array<Record<string, unknown>> = [];
  const latestMismatches: Array<Record<string, unknown>> = [];
  const orphanSummaryRows: Array<Record<string, unknown>> = [];

  for (const studentId of studentIds) {
    const wanted = expected.get(studentId) ?? { totalPracticeSeconds: 0, latestPracticeAt: null };
    const stored = actual.get(studentId);
    if (!stored) {
      if (wanted.totalPracticeSeconds !== 0 || wanted.latestPracticeAt !== null) {
        totalMismatches.push({
          studentId,
          expected: wanted.totalPracticeSeconds,
          actual: null
        });
        latestMismatches.push({
          studentId,
          expected: wanted.latestPracticeAt,
          actual: null
        });
      }
      continue;
    }
    if (!expected.has(studentId)) {
      orphanSummaryRows.push({
        studentId,
        actualTotal: stored.totalPracticeSeconds,
        actualLatest: stored.latestPracticeAt
      });
      if (stored.totalPracticeSeconds !== 0 || stored.latestPracticeAt !== null) {
        totalMismatches.push({ studentId, expected: 0, actual: stored.totalPracticeSeconds });
        latestMismatches.push({ studentId, expected: null, actual: stored.latestPracticeAt });
      }
      continue;
    }
    if (stored.totalPracticeSeconds !== wanted.totalPracticeSeconds) {
      totalMismatches.push({
        studentId,
        expected: wanted.totalPracticeSeconds,
        actual: stored.totalPracticeSeconds
      });
    }
    const expectedTime = wanted.latestPracticeAt ? Date.parse(wanted.latestPracticeAt) : null;
    const actualTime = stored.latestPracticeAt ? Date.parse(stored.latestPracticeAt) : null;
    if (expectedTime !== actualTime) {
      latestMismatches.push({
        studentId,
        expected: wanted.latestPracticeAt,
        actual: stored.latestPracticeAt
      });
    }
  }

  console.log("student_practice_summary verification (read-only)");
  console.log(JSON.stringify({
    students: studentIds.length,
    studentsWithPractice: expected.size,
    summaryRows: actual.size,
    orphanSummaryRows: orphanSummaryRows.length,
    totalPracticeSecondsMismatches: totalMismatches.length,
    latestPracticeAtMismatches: latestMismatches.length,
    mismatch: totalMismatches.length + latestMismatches.length
  }, null, 2));
  if (totalMismatches.length > 0) {
    console.log("totalPracticeSeconds mismatches (first 20):");
    console.log(JSON.stringify(totalMismatches.slice(0, 20), null, 2));
  }
  if (latestMismatches.length > 0) {
    console.log("latestPracticeAt mismatches (first 20):");
    console.log(JSON.stringify(latestMismatches.slice(0, 20), null, 2));
  }
  if (orphanSummaryRows.length > 0) {
    console.log("summary rows without any source record:");
    console.log(JSON.stringify(orphanSummaryRows.slice(0, 20), null, 2));
  }
  if (totalMismatches.length + latestMismatches.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
