import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  appendSupabaseDebugMetrics,
  instrumentSupabaseClient,
  wantsSupabaseDebugMetrics,
  type SupabaseQueryMetric
} from "@/lib/supabase/debugMetrics.server";
import {
  loadPendingReviewCount,
  loadRecentActivity,
  loadTeacherAssignmentReminders,
  loadTeacherInactiveStudents
} from "@/lib/teacherDashboardServer";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import type { TeacherDashboardPayload } from "@/lib/teacherDashboard";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

export async function GET(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看教师首页数据。" }, { status: 403 });
  }

  const debugMetrics: SupabaseQueryMetric[] = [];
  const debugEnabled = wantsSupabaseDebugMetrics(request);

  try {
    const baseDb = createServiceSupabase();
    const db = debugEnabled ? instrumentSupabaseClient(baseDb, debugMetrics) : baseDb;
    const now = new Date();

    // One embedded bindings+profiles query resolves the whole teaching scope:
    // visible students, per-student domains, and display names.
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    const studentNames = new Map(
      Array.from(scope.studentProfiles, ([studentId, profile]) => [studentId, profile.displayName])
    );
    const hasWritingDomain = scope.teacherDomains.includes("writing");
    const hasReadingDomain = scope.teacherDomains.includes("reading");

    const [pendingReviewCount, assignmentReminders, inactiveStudents, recentActivity] =
      await Promise.all([
        loadPendingReviewCount(db, auth.userId, scope.writingStudentIds),
        loadTeacherAssignmentReminders(db, auth.userId, now, studentNames),
        loadTeacherInactiveStudents(db, scope.visibleStudentIds, now, studentNames),
        loadRecentActivity(
          db,
          {
            hasReadingDomain,
            hasWritingDomain,
            readingStudentIds: scope.readingStudentIds,
            writingStudentIds: scope.writingStudentIds
          },
          studentNames
        )
      ]);

    const payload: TeacherDashboardPayload = {
      teacherDomains: scope.teacherDomains,
      studentCount: scope.visibleStudentIds.length,
      pendingReviewCount,
      assignmentReminders,
      inactiveStudents,
      recentActivity
    };
    const response = json(payload);
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  } catch (error) {
    console.error("Teacher dashboard load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    const response = json({ error: "教师首页数据加载失败，请稍后重试。" }, { status: 500 });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  }
}
