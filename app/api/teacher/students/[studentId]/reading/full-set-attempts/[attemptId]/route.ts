import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  appendSupabaseDebugMetrics,
  instrumentSupabaseClient,
  wantsSupabaseDebugMetrics,
  type SupabaseQueryMetric
} from "@/lib/supabase/debugMetrics.server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import { loadTeacherStudentReadingFullSetAttemptReview } from "@/lib/teacherStudentReadingAttempt.server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string; studentId: string } }
) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看该学生的阅读套题记录。" }, { status: 403 });
  }

  const studentId = String(params.studentId ?? "").trim();
  const attemptId = String(params.attemptId ?? "").trim();
  if (!studentId || !attemptId) {
    return json({ error: "无效的阅读套题记录。" }, { status: 400 });
  }

  const debugMetrics: SupabaseQueryMetric[] = [];
  const debugEnabled = wantsSupabaseDebugMetrics(request);

  try {
    const baseDb = createServiceSupabase();
    const db = debugEnabled ? instrumentSupabaseClient(baseDb, debugMetrics) : baseDb;
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    const profile = scope.studentProfiles.get(studentId);
    if (!profile) return json({ error: "未找到该学生。" }, { status: 404 });
    if (!scope.studentDomains.get(studentId)?.includes("reading")) {
      return json({ error: "无权查看该学生的阅读套题记录。" }, { status: 403 });
    }

    const detail = await loadTeacherStudentReadingFullSetAttemptReview(db, studentId, attemptId);
    if (!detail) return json({ error: "未找到这次阅读套题记录。" }, { status: 404 });

    return debugEnabled
      ? appendSupabaseDebugMetrics(json(detail), debugMetrics)
      : json(detail);
  } catch (error) {
    console.error("Teacher student Reading Full Set attempt load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    const response = json({ error: "套题作答加载失败，请稍后重试。" }, { status: 500 });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
