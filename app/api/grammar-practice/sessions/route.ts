import { NextResponse } from "next/server";
import { bearerToken, requireAuthenticatedAccount, roleCanAccess } from "@/lib/auth";
import {
  drawGrammarPracticeQuestions,
  loadGrammarQuestionPool,
  toPublicGrammarQuestion
} from "@/lib/grammarPractice.server";
import {
  GRAMMAR_PRACTICE_QUESTION_LIMIT,
  type GrammarPracticeSessionPayload
} from "@/lib/grammarPractice";
import { mapPracticeAccessError } from "@/lib/practiceEntitlements";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Explicit BAS Grammar random-practice Start.
 *
 * GET question previews never spend. This POST freezes the randomly drawn ten
 * questions and atomically spends one bas_category quota only when it creates
 * a genuinely new self-practice session. Reusing the same request id returns
 * the existing session without another spend.
 */
export async function POST(request: Request) {
  try {
    const token = bearerToken(request);
    const auth = await requireAuthenticatedAccount(token);
    if (auth.error || !auth.userId || !auth.role || !token) {
      return json({ error: "请先登录后再开始语法练习。" }, { status: 401 });
    }
    if (!roleCanAccess(auth.role, "student")) {
      return json({ error: "无权开始语法练习。" }, { status: 403 });
    }

    const body = (await request.json().catch(() => null)) as {
      tag?: unknown;
      requestId?: unknown;
    } | null;
    if (
      !body ||
      Array.isArray(body) ||
      typeof body.tag !== "string" ||
      !body.tag.trim() ||
      body.tag.trim().length > 200 ||
      typeof body.requestId !== "string" ||
      !UUID_PATTERN.test(body.requestId.trim()) ||
      Object.keys(body).some((key) => key !== "tag" && key !== "requestId")
    ) {
      return json({ error: "无效的语法练习启动请求。" }, { status: 400 });
    }

    const tag = body.tag.trim();
    const requestId = body.requestId.trim();
    const db = createServiceSupabase();
    const pool = await loadGrammarQuestionPool(db);
    const questions = drawGrammarPracticeQuestions(pool, tag);
    if (questions.length === 0) {
      return json({ error: "该语法标签暂无可练习题目，无法开始练习。" }, { status: 409 });
    }

    const manifest = {
      kind: "bas_grammar",
      version: 1,
      category: tag,
      questions: questions.map(toPublicGrammarQuestion)
    };
    const { data, error } = await db.rpc("start_bas_grammar_practice_session", {
      p_student_id: auth.userId,
      p_category: tag,
      p_manifest: manifest,
      p_request_id: requestId,
      p_origin: "self_practice",
      p_assignment_id: null
    });
    if (error) {
      const failure = mapPracticeAccessError(
        error,
        "语法练习启动失败，请稍后重试。"
      );
      if (failure.status >= 500) {
        console.error("[grammar-practice-session] start_failed", {
          code: error.code ?? null,
          message: error.message
        });
      }
      return json({ error: failure.message }, { status: failure.status });
    }

    const payload = data as GrammarPracticeSessionPayload | null;
    if (
      !payload?.session?.sessionId ||
      payload.session.category !== tag ||
      !Array.isArray(payload.session.questions) ||
      payload.session.questions.length === 0 ||
      payload.session.questions.length > GRAMMAR_PRACTICE_QUESTION_LIMIT
    ) {
      return json({ error: "语法练习启动结果无效。" }, { status: 500 });
    }

    return json(payload, { status: payload.created === false ? 200 : 201 });
  } catch (error) {
    console.error("[grammar-practice-session] request_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "语法练习启动失败，请稍后重试。" }, { status: 500 });
  }
}
