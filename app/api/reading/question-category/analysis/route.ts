import { readingAttemptJson, readingAttemptError, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import { loadQuestionCategoryAnalysis } from "@/lib/reading/questionCategoryAnalysis.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  try {
    return readingAttemptJson({ ranking: await loadQuestionCategoryAnalysis(createServiceSupabase(), auth.userId) });
  } catch (error) {
    return readingAttemptError(error instanceof Error ? error : null, "题型统计加载失败，请稍后重试。");
  }
}
