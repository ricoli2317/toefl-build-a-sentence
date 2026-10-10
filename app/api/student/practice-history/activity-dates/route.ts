import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { parsePracticeActivityQuery, readPracticeActivityDates } from "@/lib/practiceActivityDates.server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await requireUserWithRole(bearerToken(request), "student");
  if (auth.error || !auth.userId) return readingAttemptJson({ error: "无权查看练习记录。" }, { status: 401 });
  let query;
  try { query = parsePracticeActivityQuery(new URL(request.url).searchParams); }
  catch { return readingAttemptJson({ error: "无效日期查询。" }, { status: 400 }); }
  try { return readingAttemptJson(await readPracticeActivityDates(createServiceSupabase(), auth.userId, query, ["reading", "writing"])); }
  catch { return readingAttemptJson({ error: "练习日期暂时无法读取，请稍后重试。" }, { status: 503 }); }
}
