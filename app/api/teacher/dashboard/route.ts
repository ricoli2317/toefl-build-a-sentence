import { NextResponse } from "next/server";
import { listTeacherStudentDomainBindings, listVisibleStudentIds } from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { loadBuildSentenceHistoricalPracticeDisplayResolver } from "@/lib/historicalPracticeDisplay";
import { isReadingModule } from "@/lib/reading/catalog";
import { safeReadingItemTitle } from "@/lib/reading/history";
import type { ReadingModule } from "@/lib/reading/types";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  buildTeacherDashboardActivity,
  type TeacherDashboardPayload,
  type TeacherDashboardReadingActivityInput,
  type TeacherDashboardWritingActivityInput
} from "@/lib/teacherDashboard";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";

export const dynamic = "force-dynamic";

const RECENT_ACTIVITY_QUERY_LIMIT = 8;
const DATABASE_BATCH_SIZE = 100;

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

type WritingAttemptRow = {
  attempt_id: string;
  student_id: string;
  set_id: string;
  set_title: string | null;
  submitted_at: string | null;
};

type ReadingAttemptRow = {
  attempt_id: string;
  student_id: string;
  logical_item_id: string;
  task_type: string;
  submitted_at: string | null;
};

type ReadingItemRow = {
  logical_item_id: string;
  module: string;
  title: string | null;
};

type PageError = { message: string };

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

async function countForStudents(
  studentIds: string[],
  build: (
    batch: string[]
  ) => PromiseLike<{ count: number | null; error: PageError | null }>
) {
  let total = 0;
  for (const batch of batchesOf(studentIds)) {
    const { count, error } = await build(batch);
    if (error) throw new Error(error.message);
    total += count ?? 0;
  }
  return total;
}

async function loadRecentRows<T>(
  studentIds: string[],
  build: (
    batch: string[],
    limit: number
  ) => PromiseLike<{ data: unknown[] | null; error: PageError | null }>
) {
  const rows: T[] = [];
  for (const batch of batchesOf(studentIds)) {
    const { data, error } = await build(batch, RECENT_ACTIVITY_QUERY_LIMIT);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

function startOfServerDayIso() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}

export async function GET(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看教师首页数据。" }, { status: 403 });
  }

  try {
    const db = createServiceSupabase();
    const actor = { userId: auth.userId, role: auth.role };
    const { teacherDomains, studentDomains } = await listTeacherStudentDomainBindings(db, actor);
    const hasWritingDomain = teacherDomains.includes("writing");
    const hasReadingDomain = teacherDomains.includes("reading");
    const visibleStudentIds = await listVisibleStudentIds(db, actor);
    const writingStudentIds = visibleStudentIds.filter((studentId) =>
      studentDomains.get(studentId)?.includes("writing")
    );
    const readingStudentIds = visibleStudentIds.filter((studentId) =>
      studentDomains.get(studentId)?.includes("reading")
    );
    const todayStart = startOfServerDayIso();

    const [profileResult, writingOverview, readingOverview, writingRecent, readingRecent] =
      await Promise.all([
        loadVisibleProfiles(db, visibleStudentIds),
        hasWritingDomain
          ? loadWritingOverview(db, writingStudentIds, todayStart)
          : Promise.resolve(null),
        hasReadingDomain
          ? loadReadingOverview(db, readingStudentIds, todayStart)
          : Promise.resolve(null),
        hasWritingDomain
          ? loadRecentRows<WritingAttemptRow>(writingStudentIds, (batch, limit) =>
              db
                .from("attempts")
                .select("attempt_id,student_id,set_id,set_title,submitted_at")
                .in("student_id", batch)
                .not("submitted_at", "is", null)
                .order("submitted_at", { ascending: false })
                .limit(limit)
            )
          : Promise.resolve([]),
        hasReadingDomain
          ? loadRecentRows<ReadingAttemptRow>(readingStudentIds, (batch, limit) =>
              db
                .from("reading_attempts")
                .select("attempt_id,student_id,logical_item_id,task_type,submitted_at")
                .eq("status", "submitted")
                .in("student_id", batch)
                .not("submitted_at", "is", null)
                .order("submitted_at", { ascending: false })
                .limit(limit)
            )
          : Promise.resolve([])
      ]);

    const studentNames = new Map(
      profileResult.data.map((profile) => [
        String(profile.id),
        getPreferredUserDisplayName({
          email: profile.email,
          profileFullName: profile.full_name
        })
      ])
    );
    const [writingActivity, readingActivity] = await Promise.all([
      resolveWritingActivity(db, writingRecent),
      resolveReadingActivity(db, readingRecent)
    ]);

    const payload: TeacherDashboardPayload = {
      teacherDomains,
      studentCount: visibleStudentIds.length,
      writing: writingOverview,
      reading: readingOverview,
      recentActivity: buildTeacherDashboardActivity({
        writing: writingActivity,
        reading: readingActivity,
        studentNames
      })
    };
    return json(payload);
  } catch (error) {
    console.error("Teacher dashboard load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "教师首页数据加载失败，请稍后重试。" }, { status: 500 });
  }
}

async function loadVisibleProfiles(
  db: ReturnType<typeof createServiceSupabase>,
  visibleStudentIds: string[]
) {
  const rows: ProfileRow[] = [];
  for (const batch of batchesOf(visibleStudentIds)) {
    const { data, error } = await db
      .from("profiles")
      .select("id,email,full_name")
      .in("id", batch);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as ProfileRow[]));
  }
  return { data: rows };
}

async function loadWritingOverview(
  db: ReturnType<typeof createServiceSupabase>,
  writingStudentIds: string[],
  todayStart: string
) {
  const [setCount, questionCount, todayAttemptCount] = await Promise.all([
    countRows(() =>
      db
        .from("practice_items")
        .select("item_id", { count: "exact", head: true })
        .eq("task_type", "build_sentence")
    ),
    countRows(() =>
      db.from("questions").select("question_id", { count: "exact", head: true })
    ),
    countForStudents(writingStudentIds, (batch) =>
      db
        .from("attempts")
        .select("attempt_id", { count: "exact", head: true })
        .in("student_id", batch)
        .not("submitted_at", "is", null)
        .gte("submitted_at", todayStart)
    )
  ]);
  return { setCount, questionCount, todayAttemptCount };
}

async function loadReadingOverview(
  db: ReturnType<typeof createServiceSupabase>,
  readingStudentIds: string[],
  todayStart: string
) {
  const [completedAttemptCount, todayAttemptCount] = await Promise.all([
    countForStudents(readingStudentIds, (batch) =>
      db
        .from("reading_attempts")
        .select("attempt_id", { count: "exact", head: true })
        .eq("status", "submitted")
        .in("student_id", batch)
    ),
    countForStudents(readingStudentIds, (batch) =>
      db
        .from("reading_attempts")
        .select("attempt_id", { count: "exact", head: true })
        .eq("status", "submitted")
        .in("student_id", batch)
        .gte("submitted_at", todayStart)
    )
  ]);
  return { completedAttemptCount, todayAttemptCount };
}

async function countRows(
  build: () => PromiseLike<{ count: number | null; error: PageError | null }>
) {
  const { count, error } = await build();
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function resolveWritingActivity(
  db: ReturnType<typeof createServiceSupabase>,
  rows: WritingAttemptRow[]
): Promise<TeacherDashboardWritingActivityInput[]> {
  const setIds = Array.from(new Set(rows.map((row) => String(row.set_id))));
  const resolver = await loadBuildSentenceHistoricalPracticeDisplayResolver(db, setIds);
  return rows
    .filter((row): row is WritingAttemptRow & { submitted_at: string } => Boolean(row.submitted_at))
    .map((row) => ({
      attemptId: String(row.attempt_id),
      studentId: String(row.student_id),
      title: resolver.resolveBuildSentence({
        fallbackDisplayName: row.set_title?.trim() || String(row.set_id),
        rawSetId: String(row.set_id)
      }).displayName,
      submittedAt: row.submitted_at
    }));
}

async function resolveReadingActivity(
  db: ReturnType<typeof createServiceSupabase>,
  rows: ReadingAttemptRow[]
): Promise<TeacherDashboardReadingActivityInput[]> {
  const itemIds = Array.from(new Set(rows.map((row) => String(row.logical_item_id))));
  const itemById = new Map<string, ReadingItemRow>();
  if (itemIds.length > 0) {
    for (const batch of batchesOf(itemIds)) {
      const { data, error } = await db
        .from("reading_logical_items")
        .select("logical_item_id,module,title")
        .in("logical_item_id", batch);
      if (error) throw new Error(error.message);
      for (const item of (data ?? []) as ReadingItemRow[]) {
        itemById.set(String(item.logical_item_id), item);
      }
    }
  }

  const activities: TeacherDashboardReadingActivityInput[] = [];
  for (const row of rows) {
    if (!row.submitted_at || !isReadingModule(row.task_type)) continue;
    const taskType = row.task_type as ReadingModule;
    const item = itemById.get(String(row.logical_item_id));
    activities.push({
      attemptId: String(row.attempt_id),
      studentId: String(row.student_id),
      taskType,
      itemTitle: safeReadingItemTitle(taskType, item?.title),
      submittedAt: row.submitted_at
    });
  }
  return activities;
}
