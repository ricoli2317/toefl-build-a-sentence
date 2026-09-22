import { NextResponse } from "next/server";
import {
  appendSupabaseDebugMetrics,
  instrumentSupabaseClient,
  wantsSupabaseDebugMetrics,
  type SupabaseQueryMetric
} from "@/lib/supabase/debugMetrics.server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadInactiveStudentsWithLastActivity } from "@/lib/teacherStudentActivity.server";
import { loadTeacherScope } from "@/lib/teacherScope.server";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

export async function GET(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看未活跃学生名单。" }, { status: 403 });
  }

  const debugMetrics: SupabaseQueryMetric[] = [];
  const debugEnabled = wantsSupabaseDebugMetrics(request);

  try {
    const baseDb = createServiceSupabase();
    const db = debugEnabled ? instrumentSupabaseClient(baseDb, debugMetrics) : baseDb;
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    const { inactiveStudentIds, lastActivityByStudent } =
      await loadInactiveStudentsWithLastActivity(db, scope.visibleStudentIds, new Date());

    const ranked = [...inactiveStudentIds].sort((left, right) => {
      const leftActivity = lastActivityByStudent.get(left);
      const rightActivity = lastActivityByStudent.get(right);
      if (leftActivity === rightActivity) return left.localeCompare(right);
      if (!leftActivity) return -1;
      if (!rightActivity) return 1;
      return Date.parse(leftActivity) - Date.parse(rightActivity);
    });

    const response = json({
      students: ranked.map((studentId) => ({
        studentId,
        studentName: scope.studentProfiles.get(studentId)?.displayName ?? "学生",
        lastActivityAt: lastActivityByStudent.get(studentId) ?? null
      }))
    });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  } catch (error) {
    console.error("Teacher inactive students load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    const response = json({ error: "未活跃学生名单加载失败，请稍后重试。" }, { status: 500 });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  }
}
