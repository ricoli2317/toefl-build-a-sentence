import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import { parsePracticeActivityQuery, readPracticeActivityDates } from "@/lib/practiceActivityDates.server";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { studentId: string } }) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || auth.role !== "teacher") return readingAttemptJson({ error: "无权查看练习记录。" }, { status: 403 });
  let query;
  try { query = parsePracticeActivityQuery(new URL(request.url).searchParams); }
  catch { return readingAttemptJson({ error: "无效日期查询。" }, { status: 400 }); }
  try {
    const db = createServiceSupabase();
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    const domains = scope.studentDomains.get(params.studentId) ?? [];
    if (!scope.studentProfiles.has(params.studentId) || !domains.length) return readingAttemptJson({ error: "无权查看该学生的练习记录。" }, { status: 403 });
    return readingAttemptJson(await readPracticeActivityDates(db, params.studentId, query, domains, true));
  } catch { return readingAttemptJson({ error: "练习日期暂时无法读取，请稍后重试。" }, { status: 503 }); }
}
