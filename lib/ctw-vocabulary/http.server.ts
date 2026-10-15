import { NextResponse } from "next/server";
import { bearerToken, requireAuthenticatedAccount, canUseStudentExperience } from "@/lib/auth";
import { createAnonSupabase } from "@/lib/supabase/server";
import { VocabularyInputError } from "./input.ts";
import { VocabularyStoreError } from "./store.server.ts";

export function vocabularyJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export async function vocabularyRoute(request: Request,
  work: (client: ReturnType<typeof createAnonSupabase>, studentId: string) => Promise<unknown>) {
  try {
    const token = bearerToken(request), account = await requireAuthenticatedAccount(token);
    if (account.error || !account.userId || !account.role || !token)
      return vocabularyJson({ error: "请先登录有效账号。" }, account.errorCode === "ACCOUNT_DISABLED" ? 403 : 401);
    if (!canUseStudentExperience(account.role)) return vocabularyJson({ error: "无权访问词测。" }, 403);
    return vocabularyJson(await work(createAnonSupabase(token), account.userId));
  } catch (error) {
    if (error instanceof VocabularyInputError || error instanceof SyntaxError)
      return vocabularyJson({ error: "词测参数或答案无效。" }, 400);
    if (error instanceof VocabularyStoreError) {
      const status = error.code === "CTW_VOCAB_UNAVAILABLE" ? 503
         : ["CTW_VOCAB_ATTEMPT_CONFLICT", "CTW_REVIEW_CONFLICT", "CTW_REVIEW_REVISION"].includes(error.code) ? 409
         : ["CTW_VOCAB_ENTRY_NOT_FOUND", "CTW_VOCAB_RESULT_NOT_FOUND", "CTW_VOCAB_LIST_NOT_FOUND", "CTW_REVIEW_NOT_FOUND"].includes(error.code) ? 404
         : ["CTW_VOCAB_INVALID_FORM_TYPE", "CTW_VOCAB_INVALID_LIST_RESULT", "CTW_REVIEW_INVALID", "CTW_REVIEW_INVALID_PARENT", "CTW_REVIEW_INVALID_MEMBERS"].includes(error.code) ? 400 : 500;
       return vocabularyJson({ error: error.code === "CTW_VOCAB_UNAVAILABLE" ? "词表功能尚未接入完整数据库，请联系管理员执行相应增量 SQL。"
         : error.code === "CTW_REVIEW_CONFLICT" ? "其他页面已保存不同操作，请核对；本地待同步记录已保留。" : error.code,
         code: error.code === "CTW_REVIEW_CONFLICT" ? "REVIEW_SYNC_CONFLICT" : error.code }, status);
    }
    return vocabularyJson({ error: "词测服务暂时不可用。" }, 500);
  }
}
