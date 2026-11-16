import { randomUUID } from "node:crypto";
import { readingAttemptJson, readingAttemptError, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { isReadingQuestionCategory } from "@/lib/reading/questionCategory";
import { createCategorySession, CategoryRequestError } from "@/lib/reading/questionCategory.server";
import { isWrongQuestionHistoryAmount } from "@/lib/wrongQuestionBank";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  const { data, error } = await auth.client.rpc("reading_question_category_counts");
  if (error) return readingAttemptError(error, "题型数量加载失败，请稍后重试。");
  return readingAttemptJson({ categories: data });
}
export async function POST(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || Array.isArray(body) || !isReadingQuestionCategory(body.questionCategory)
    || !isWrongQuestionHistoryAmount(body.amount)
    || Object.keys(body).some((key) => key !== "questionCategory" && key !== "amount" && key !== "requestId")
    || (body.requestId !== undefined
      && body.requestId !== null
      && (typeof body.requestId !== "string" || !UUID_PATTERN.test(body.requestId.trim())))) {
    return readingAttemptJson({ error: "请选择有效的题型和题目数量。" }, { status: 400 });
  }
  try {
    const requestId = typeof body.requestId === "string" && body.requestId.trim()
      ? body.requestId.trim()
      : randomUUID();
    const created = await createCategorySession(createServiceSupabase(), auth.userId, body.questionCategory, body.amount, requestId);
    return readingAttemptJson(
      {
        session: created.session,
        answers: created.answers,
        created: created.created
      },
      { status: created.created ? 201 : 200 }
    );
  } catch (error) {
    if (error instanceof CategoryRequestError) return readingAttemptJson({ error: error.message }, { status: error.status });
    return readingAttemptError(error instanceof Error ? error : null, "练习创建失败，请稍后重试。");
  }
}
