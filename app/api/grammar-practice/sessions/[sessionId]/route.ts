import { NextResponse } from "next/server";
import { bearerToken, requireAuthenticatedAccount, roleCanAccess } from "@/lib/auth";
import type { GrammarPracticeSessionPayload } from "@/lib/grammarPractice";
import { mapPracticeAccessError } from "@/lib/practiceEntitlements";
import { createAnonSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Owner-only BAS Grammar session resume. This is a read and never spends a
 * category entitlement. The database RPC derives the owner from auth.uid().
 */
export async function PATCH(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  try {
    const token = bearerToken(request);
    const auth = await requireAuthenticatedAccount(token);
    if (auth.error || !auth.userId || !auth.role || !token) {
      return json({ error: "请先登录后再保存语法练习。" }, { status: 401 });
    }
    if (!roleCanAccess(auth.role, "student")) {
      return json({ error: "无权保存语法练习。" }, { status: 403 });
    }

    const sessionId = String(params.sessionId ?? "").trim();
    if (!UUID_PATTERN.test(sessionId)) {
      return json({ error: "无效的语法练习记录。" }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) as {
      answers?: unknown;
      questionTimes?: unknown;
      currentIndex?: unknown;
      elapsedSeconds?: unknown;
      paused?: unknown;
      revision?: unknown;
    } | null;
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) =>
          ![
            "answers",
            "questionTimes",
            "currentIndex",
            "elapsedSeconds",
            "paused",
            "revision"
          ].includes(key)
      ) ||
      (body.paused !== undefined && typeof body.paused !== "boolean") ||
      !body.answers ||
      typeof body.answers !== "object" ||
      Array.isArray(body.answers) ||
      !body.questionTimes ||
      typeof body.questionTimes !== "object" ||
      Array.isArray(body.questionTimes) ||
      !Number.isInteger(body.currentIndex) ||
      (body.currentIndex as number) < 0 ||
      !Number.isInteger(body.elapsedSeconds) ||
      (body.elapsedSeconds as number) < 0 ||
      !Number.isSafeInteger(body.revision) ||
      (body.revision as number) < 1
    ) {
      return json({ error: "练习进度数据无效。" }, { status: 400 });
    }

    const { error } = await createAnonSupabase(token).rpc(
      "save_bas_grammar_practice_draft",
      {
        p_session_id: sessionId,
        p_draft: {
          answers: body.answers,
          questionTimes: body.questionTimes,
          currentIndex: body.currentIndex,
          elapsedSeconds: body.elapsedSeconds,
          paused: body.paused === true,
          revision: body.revision
        }
      }
    );
    if (error) {
      const failure = mapPracticeAccessError(
        error,
        "练习进度保存失败，请稍后重试。"
      );
      if (failure.status >= 500) {
        console.error("[grammar-practice-session] draft_failed", {
          code: error.code ?? null,
          message: error.message
        });
      }
      return json({ error: failure.message }, { status: failure.status });
    }
    return json({ saved: true });
  } catch (error) {
    console.error("[grammar-practice-session] request_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "练习进度保存失败，请稍后重试。" }, { status: 500 });
  }
}

export async function GET(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  try {
    const token = bearerToken(request);
    const auth = await requireAuthenticatedAccount(token);
    if (auth.error || !auth.userId || !auth.role || !token) {
      return json({ error: "请先登录后再继续语法练习。" }, { status: 401 });
    }
    if (!roleCanAccess(auth.role, "student")) {
      return json({ error: "无权继续语法练习。" }, { status: 403 });
    }

    const sessionId = String(params.sessionId ?? "").trim();
    if (!UUID_PATTERN.test(sessionId)) {
      return json({ error: "无效的语法练习记录。" }, { status: 400 });
    }

    const { data, error } = await createAnonSupabase(token).rpc(
      "get_bas_grammar_practice_session",
      { p_session_id: sessionId }
    );
    if (error) {
      const failure = mapPracticeAccessError(
        error,
        "语法练习加载失败，请稍后重试。"
      );
      if (failure.status >= 500) {
        console.error("[grammar-practice-session] resume_failed", {
          code: error.code ?? null,
          message: error.message
        });
      }
      return json({ error: failure.message }, { status: failure.status });
    }

    const payload = data as GrammarPracticeSessionPayload | null;
    if (!payload?.session?.sessionId || payload.session.sessionId !== sessionId) {
      return json({ error: "语法练习加载结果无效。" }, { status: 500 });
    }
    return json(payload);
  } catch (error) {
    console.error("[grammar-practice-session] request_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "语法练习加载失败，请稍后重试。" }, { status: 500 });
  }
}
