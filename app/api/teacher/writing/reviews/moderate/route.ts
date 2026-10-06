import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  isWritingReviewModerationAction,
  normalizeWritingReviewModerationAttemptIds
} from "@/lib/writingReviewModeration";
import { moderateWritingReviewAttempts } from "@/lib/writingReviewModeration.server";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

/**
 * One batch endpoint for 退回 / 忽略: the list sends the whole selection once,
 * the server re-checks teaching scope and the live 待批改 state (transactional
 * RPC) and answers per attempt, so concurrent review work can never be
 * moderated by mistake.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId || !auth.role) {
      const status = auth.error === "Forbidden" ? 403 : 401;
      return json(
        { code: "UNAUTHORIZED", message: auth.error ?? "Unauthorized" },
        { status }
      );
    }

    const body = (await request.json()) as {
      action?: unknown;
      attemptIds?: unknown;
    };
    if (!isWritingReviewModerationAction(body.action)) {
      return json(
        { code: "UNSUPPORTED_ACTION", message: "不支持的批改操作。" },
        { status: 400 }
      );
    }
    const attemptIds = normalizeWritingReviewModerationAttemptIds(body.attemptIds);
    if (attemptIds.length === 0) {
      return json(
        { code: "EMPTY_SELECTION", message: "请选择要处理的写作。" },
        { status: 400 }
      );
    }

    const results = await moderateWritingReviewAttempts(createServiceSupabase(), {
      action: body.action,
      attemptIds,
      actor: { userId: auth.userId, role: auth.role }
    });
    return json({ results });
  } catch (error) {
    console.error("Unexpected writing review moderation error", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "WRITING_REVIEW_MODERATION_FAILED", message: "操作失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
