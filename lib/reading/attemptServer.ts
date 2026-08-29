import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createAnonSupabase } from "@/lib/supabase/server";

export type ReadingAttemptAuth = {
  client: ReturnType<typeof createAnonSupabase> | null;
  error: NextResponse | null;
  userId: string | null;
};

export function readingAttemptJson(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

export async function requireReadingAttemptStudent(
  request: Request
): Promise<ReadingAttemptAuth> {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "student");
  if (auth.error || !auth.userId || !token) {
    return {
      client: null,
      error: readingAttemptJson({ error: "请先登录后再开始阅读练习。" }, { status: 401 }),
      userId: null
    };
  }
  return { client: createAnonSupabase(token), error: null, userId: auth.userId };
}

export function readingAttemptError(
  error: { message?: string; code?: string } | null,
  fallback: string
) {
  const message = error?.message ?? "";
  if (message.includes("READING_ITEM_NOT_FOUND")) {
    return readingAttemptJson({ error: "没有找到这个阅读练习。" }, { status: 404 });
  }
  if (message.includes("READING_ATTEMPT_NOT_FOUND")) {
    return readingAttemptJson({ error: "没有找到这次阅读练习记录。" }, { status: 404 });
  }
  if (message.includes("READING_SUBMITTED_ATTEMPT_NOT_FOUND")) {
    return readingAttemptJson({ error: "没有找到可重新练习的提交记录。" }, { status: 404 });
  }
  if (
    message.includes("READING_INVALID_")
    || message.includes("READING_DUPLICATE_ANSWER_ID")
    || message.includes("READING_ANSWER_ID_NOT_IN_ITEM")
  ) {
    return readingAttemptJson({ error: "提交的阅读答案无效。" }, { status: 400 });
  }
  if (error?.code === "42501" || message.includes("READING_STUDENT_REQUIRED")) {
    return readingAttemptJson({ error: "无权操作这次阅读练习。" }, { status: 403 });
  }
  console.error("Reading attempt operation failed", {
    code: error?.code,
    message
  });
  return readingAttemptJson({ error: fallback }, { status: 500 });
}
