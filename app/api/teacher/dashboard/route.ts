import { NextResponse } from "next/server";
import { listTeacherStudentDomainBindings, listVisibleStudentIds } from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  loadPendingReviewCount,
  loadRecentActivity,
  loadTeacherAssignmentReminders,
  loadTeacherInactiveStudents
} from "@/lib/teacherDashboardServer";
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

  try {
    const db = createServiceSupabase();
    const actor = { userId: auth.userId, role: auth.role };
    const now = new Date();

    const [{ teacherDomains, studentDomains }, visibleStudentIds] = await Promise.all([
      listTeacherStudentDomainBindings(db, actor),
      listVisibleStudentIds(db, actor)
    ]);
    const hasWritingDomain = teacherDomains.includes("writing");
    const hasReadingDomain = teacherDomains.includes("reading");
    const writingStudentIds = visibleStudentIds.filter((studentId) =>
      studentDomains.get(studentId)?.includes("writing")
    );
    const readingStudentIds = visibleStudentIds.filter((studentId) =>
      studentDomains.get(studentId)?.includes("reading")
    );

    const [pendingReviewCount, assignmentReminders, inactiveStudents, recentActivity] =
      await Promise.all([
        loadPendingReviewCount(db, auth.userId, writingStudentIds),
        loadTeacherAssignmentReminders(db, auth.userId, now),
        loadTeacherInactiveStudents(db, visibleStudentIds, now),
        loadRecentActivity(db, {
          hasReadingDomain,
          hasWritingDomain,
          readingStudentIds,
          writingStudentIds
        })
      ]);

    const payload: TeacherDashboardPayload = {
      teacherDomains,
      studentCount: visibleStudentIds.length,
      pendingReviewCount,
      assignmentReminders,
      inactiveStudents,
      recentActivity
    };
    return json(payload);
  } catch (error) {
    console.error("Teacher dashboard load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "教师首页数据加载失败，请稍后重试。" }, { status: 500 });
  }
}
