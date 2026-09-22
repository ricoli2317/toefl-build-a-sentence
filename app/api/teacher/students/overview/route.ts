import { NextResponse } from "next/server";
import {
  listTeacherStudentDomainBindings,
  listVisibleStudentIds
} from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  buildTeacherStudentOverview,
  type TeacherStudentOverviewCandidate,
  type TeacherStudentPracticeRow,
  type TeacherStudentPracticeSource
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

type ReadingPracticeRow = {
  attempt_id: string;
  student_id: string;
  elapsed_seconds: number | null;
  submitted_at: string | null;
};

type BasPracticeRow = {
  attempt_id: string;
  student_id: string;
  time_spent_seconds: number | null;
  submitted_at: string | null;
};

type WritingPracticeRow = {
  attempt_id: string;
  user_id: string;
  elapsed_seconds: number | null;
  submitted_at: string | null;
};

type ReadingFullSetRow = {
  attempt_id: string;
  student_id: string;
  completed_at: string | null;
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
 * Reads only ids, stored durations, and canonical completion timestamps in
 * batches of visible students. One query per table per batch; never one query
 * per student and never answers, prompts, responses, or review payloads.
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

function practiceRow(
  studentId: string,
  source: TeacherStudentPracticeSource,
  durationSeconds: number | null,
  completedAt: string | null
): TeacherStudentPracticeRow {
  return { studentId, source, durationSeconds, completedAt };
}

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

    const { studentDomains } = await listTeacherStudentDomainBindings(db, actor);
    const [
      profiles,
      readingAttempts,
      readingWrongbookAttempts,
      basAttempts,
      writingAttempts,
      readingFullSetAttempts
    ] = await Promise.all([
      readRowsForStudents<ProfileRow>(visibleStudentIds, (batch, from, to) =>
        db
          .from("profiles")
          .select("id,email,full_name")
          .in("id", batch)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      readRowsForStudents<ReadingPracticeRow>(visibleStudentIds, (batch, from, to) =>
        db
          .from("reading_attempts")
          .select("attempt_id,student_id,elapsed_seconds,submitted_at")
          .eq("status", "submitted")
          .not("submitted_at", "is", null)
          .in("student_id", batch)
          .order("student_id", { ascending: true })
          .order("attempt_id", { ascending: true })
          .range(from, to)
      ),
      readRowsForStudents<ReadingPracticeRow>(visibleStudentIds, (batch, from, to) =>
        db
          .from("reading_wrongbook_attempts")
          .select("attempt_id,student_id,elapsed_seconds,submitted_at")
          .eq("status", "submitted")
          .not("submitted_at", "is", null)
          .in("student_id", batch)
          .order("student_id", { ascending: true })
          .order("attempt_id", { ascending: true })
          .range(from, to)
      ),
      readRowsForStudents<BasPracticeRow>(visibleStudentIds, (batch, from, to) =>
        db
          .from("attempts")
          .select("attempt_id,student_id,time_spent_seconds,submitted_at")
          .not("submitted_at", "is", null)
          .in("student_id", batch)
          .order("student_id", { ascending: true })
          .order("attempt_id", { ascending: true })
          .range(from, to)
      ),
      readRowsForStudents<WritingPracticeRow>(visibleStudentIds, (batch, from, to) =>
        db
          .from("writing_attempts")
          .select("attempt_id,user_id,elapsed_seconds,submitted_at")
          .eq("status", "submitted")
          .not("submitted_at", "is", null)
          .in("user_id", batch)
          .order("user_id", { ascending: true })
          .order("attempt_id", { ascending: true })
          .range(from, to)
      ),
      readRowsForStudents<ReadingFullSetRow>(visibleStudentIds, (batch, from, to) =>
        db
          .from("reading_full_set_attempts")
          .select("attempt_id,student_id,completed_at")
          .eq("status", "completed")
          .not("completed_at", "is", null)
          .in("student_id", batch)
          .order("student_id", { ascending: true })
          .order("attempt_id", { ascending: true })
          .range(from, to)
      )
    ]);

    const practiceRows: TeacherStudentPracticeRow[] = [
      ...readingAttempts.map((row) =>
        practiceRow(String(row.student_id), "reading", row.elapsed_seconds, row.submitted_at)
      ),
      ...readingWrongbookAttempts.map((row) =>
        practiceRow(String(row.student_id), "reading-wrongbook", row.elapsed_seconds, row.submitted_at)
      ),
      ...basAttempts.map((row) =>
        practiceRow(String(row.student_id), "build-sentence", row.time_spent_seconds, row.submitted_at)
      ),
      ...writingAttempts.map((row) =>
        practiceRow(String(row.user_id), "writing", row.elapsed_seconds, row.submitted_at)
      ),
      ...readingFullSetAttempts.map((row) =>
        practiceRow(String(row.student_id), "reading-full-set", null, row.completed_at)
      )
    ];

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

    return json({ students: buildTeacherStudentOverview({ practiceRows, students }) });
  } catch (error) {
    console.error("Teacher student overview load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "学生列表加载失败，请稍后重试。" }, { status: 500 });
  }
}
