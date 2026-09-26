import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  appendSupabaseDebugMetrics,
  instrumentSupabaseClient,
  wantsSupabaseDebugMetrics,
  type SupabaseQueryMetric
} from "@/lib/supabase/debugMetrics.server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import { readPendingPasswordResetRequestIds } from "@/lib/passwordResetRequests.server";
import {
  buildTeacherStudentOverviewFromSummaries,
  type TeacherStudentOverviewCandidate,
  type TeacherStudentPracticeSummaryRow
} from "@/lib/teacherStudentOverview";

export const dynamic = "force-dynamic";

const DATABASE_BATCH_SIZE = 100;

type PageError = { message: string };

type SummaryRow = {
  student_id: string;
  total_practice_seconds: number | null;
  latest_practice_at: string | null;
};

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

function batchesOf(values: string[]) {
  const batches: string[][] = [];
  for (let index = 0; index < values.length; index += DATABASE_BATCH_SIZE) {
    batches.push(values.slice(index, index + DATABASE_BATCH_SIZE));
  }
  return batches;
}

/**
 * Reads a per-student table in batches of visible students. One query per
 * batch; never one query per student and never any practice history table.
 */
async function readRowsForStudents<Row>(
  studentIds: string[],
  readPage: (
    batch: string[],
    from: number,
    to: number
  ) => PromiseLike<{ data: Row[] | null; error: PageError | null }>
) {
  const rows: Row[] = [];
  for (const batch of batchesOf(studentIds)) {
    const result = await readAllSupabaseRows<Row>((from, to) => readPage(batch, from, to));
    if (result.error) throw new Error(result.error.message);
    rows.push(...(result.data ?? []));
  }
  return rows;
}

/**
 * Teacher student list. The scope (bindings + student profiles) resolves in one
 * embedded query, and the summary table is maintained incrementally by database
 * triggers on practice completion, so this endpoint never reads
 * reading_attempts, reading_wrongbook_attempts, attempts, writing_attempts, or
 * reading_full_set_attempts.
 */
export async function GET(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看学生列表。" }, { status: 403 });
  }

  const debugMetrics: SupabaseQueryMetric[] = [];
  const debugEnabled = wantsSupabaseDebugMetrics(request);

  try {
    const baseDb = createServiceSupabase();
    const db = debugEnabled ? instrumentSupabaseClient(baseDb, debugMetrics) : baseDb;
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    if (scope.visibleStudentIds.length === 0) {
      return json({ students: [] });
    }

    const summaries = await readRowsForStudents<SummaryRow>(scope.visibleStudentIds, (batch, from, to) =>
      db
        .from("student_practice_summary")
        .select("student_id,total_practice_seconds,latest_practice_at")
        .in("student_id", batch)
        .order("student_id", { ascending: true })
        .range(from, to)
    );

    // Pending forgot-password requests are attached only for students this
    // teacher is currently bound to (the scope is binding-derived), so a
    // request is globally one row but visible to every bound teacher.
    const requestIdByStudentId = await readPendingPasswordResetRequestIds(db, {
      userIds: scope.visibleStudentIds,
      role: "student"
    });

    const students: TeacherStudentOverviewCandidate[] = scope.visibleStudentIds.map((studentId) => {
      const profile = scope.studentProfiles.get(studentId);
      return {
        studentId,
        studentDisplayName: profile?.displayName ?? "学生",
        studentEmail: profile?.email ?? "",
        domains: scope.studentDomains.get(studentId) ?? []
      };
    });
    const summaryRows: TeacherStudentPracticeSummaryRow[] = summaries.map((row) => ({
      studentId: String(row.student_id),
      totalPracticeSeconds: row.total_practice_seconds,
      latestPracticeAt: row.latest_practice_at
    }));

    const response = json({
      students: buildTeacherStudentOverviewFromSummaries({ students, summaries: summaryRows }).map(
        (entry) => ({
          ...entry,
          passwordResetRequestId: requestIdByStudentId.get(entry.studentId) ?? null
        })
      )
    });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  } catch (error) {
    console.error("Teacher student overview load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    const response = json({ error: "学生列表加载失败，请稍后重试。" }, { status: 500 });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  }
}
