import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import { loadTeacherCategorySessionDetail } from "@/lib/reading/questionCategory.server";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { studentId: string; attemptId: string } }) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) return json({ error: "无权查看该学生的阅读练习记录。" }, 403);
  try {
    const db = createServiceSupabase();
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    if (!scope.studentProfiles.has(params.studentId) || !scope.studentDomains.get(params.studentId)?.includes("reading")) {
      return json({ error: "无权查看该学生的阅读练习记录。" }, 403);
    }
    const value = new URL(request.url).searchParams.get("question");
    const index = value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
    const sessionDetail = await loadTeacherCategorySessionDetail(db, params.studentId, params.attemptId, index);
    return sessionDetail ? json({ sessionDetail }) : json({ error: "未找到这次阅读练习记录。" }, 404);
  } catch {
    return json({ error: "阅读作答加载失败，请稍后重试。" }, 500);
  }
}
function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
