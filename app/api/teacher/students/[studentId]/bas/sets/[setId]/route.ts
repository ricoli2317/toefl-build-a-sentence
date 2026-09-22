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
import { loadTeacherStudentBasSet } from "@/lib/teacherStudentPractice.server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { setId: string; studentId: string } }
) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看该学生的 BAS 练习记录。" }, { status: 403 });
  }

  const studentId = String(params.studentId ?? "").trim();
  const requestedSetId = decodeURIComponent(String(params.setId ?? "")).trim();
  if (!studentId || !requestedSetId) {
    return json({ error: "无效的练习套题。" }, { status: 400 });
  }

  const debugMetrics: SupabaseQueryMetric[] = [];
  const debugEnabled = wantsSupabaseDebugMetrics(request);

  try {
    const baseDb = createServiceSupabase();
    const db = debugEnabled ? instrumentSupabaseClient(baseDb, debugMetrics) : baseDb;
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    const profile = scope.studentProfiles.get(studentId);
    if (!profile) return json({ error: "未找到该学生。" }, { status: 404 });
    if (!scope.studentDomains.get(studentId)?.includes("writing")) {
      return json({ error: "无权查看该学生的 BAS 练习记录。" }, { status: 403 });
    }

    const detail = await loadTeacherStudentBasSet(db, studentId, requestedSetId);

    const response = json({
      student: {
        studentId,
        displayName: profile.displayName,
        account: profile.email || "—"
      },
      ...detail
    });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  } catch (error) {
    console.error("Teacher student BAS set load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    const response = json({ error: "套题练习记录加载失败，请稍后重试。" }, { status: 500 });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
