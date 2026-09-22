import { NextResponse } from "next/server";
import {
  listTeacherStudentDomainBindings,
  listVisibleStudentIds
} from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  buildTeacherStudentOverviewFromSummaries,
  type TeacherStudentOverviewCandidate,
  type TeacherStudentPracticeSummaryRow
} from "@/lib/teacherStudentOverview";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";

export const dynamic = "force-dynamic";

const DATABASE_BATCH_SIZE = 100;

type PageError = { message: string };

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

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
 * Teacher student list. The summary table is maintained incrementally by
 * database triggers on practice completion, so this endpoint never reads
 * reading_attempts, reading_wrongbook_attempts, attempts, writing_attempts, or
 * reading_full_set_attempts.
 */
export async function GET(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看学生列表。" }, { status: 403 });
  }

  try {
    const db = createServiceSupabase();
    const actor = { userId: auth.userId, role: auth.role };
    const visibleStudentIds = await listVisibleStudentIds(db, actor);
    if (visibleStudentIds.length === 0) {
      return json({ students: [] });
    }

    const [domainBindings, profiles, summaries] = await Promise.all([
      listTeacherStudentDomainBindings(db, actor),
      readRowsForStudents<ProfileRow>(visibleStudentIds, (batch, from, to) =>
        db
          .from("profiles")
          .select("id,email,full_name")
          .in("id", batch)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      readRowsForStudents<SummaryRow>(visibleStudentIds, (batch, from, to) =>
        db
          .from("student_practice_summary")
          .select("student_id,total_practice_seconds,latest_practice_at")
          .in("student_id", batch)
          .order("student_id", { ascending: true })
          .range(from, to)
      )
    ]);
    const { studentDomains } = domainBindings;

    const profileById = new Map(profiles.map((profile) => [String(profile.id), profile]));
    const students: TeacherStudentOverviewCandidate[] = visibleStudentIds.map((studentId) => {
      const profile = profileById.get(studentId);
      return {
        studentId,
        studentDisplayName: getPreferredUserDisplayName({
          email: profile?.email ?? null,
          profileFullName: profile?.full_name ?? null
        }),
        studentEmail: profile?.email ?? "",
        domains: studentDomains.get(studentId) ?? []
      };
    });
    const summaryRows: TeacherStudentPracticeSummaryRow[] = summaries.map((row) => ({
      studentId: String(row.student_id),
      totalPracticeSeconds: row.total_practice_seconds,
      latestPracticeAt: row.latest_practice_at
    }));

    return json({ students: buildTeacherStudentOverviewFromSummaries({ students, summaries: summaryRows }) });
  } catch (error) {
    console.error("Teacher student overview load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "学生列表加载失败，请稍后重试。" }, { status: 500 });
  }
}
