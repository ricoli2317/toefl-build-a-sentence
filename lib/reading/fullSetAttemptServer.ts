import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createAnonSupabase } from "@/lib/supabase/server";
import {
  isReadingFullSetAttemptSummary,
  readingFullSetActiveModuleAttempt,
  type ReadingFullSetAttemptSummary,
  type ReadingFullSetRunnerOccurrence,
  type ReadingFullSetRunnerPayload
} from "./fullSetAttempts.ts";
import type { ReadingFullSet } from "./fullSets.ts";

export type ReadingFullSetAttemptAuth = {
  client: ReturnType<typeof createAnonSupabase> | null;
  error: NextResponse | null;
  userId: string | null;
};

export function readingFullSetAttemptJson(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

export async function requireReadingFullSetStudent(
  request: Request
): Promise<ReadingFullSetAttemptAuth> {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "student");
  if (auth.error || !auth.userId || !token) {
    return {
      client: null,
      error: readingFullSetAttemptJson(
        { error: "请先登录后再开始套题练习。" },
        { status: 401 }
      ),
      userId: null
    };
  }
  return { client: createAnonSupabase(token), error: null, userId: auth.userId };
}

export function readingFullSetAttemptError(
  error: { message?: string; code?: string } | null,
  fallback: string
) {
  const message = error?.message ?? "";
  if (message.includes("FULL_SET_NOT_FOUND")) {
    return readingFullSetAttemptJson({ error: "没有找到这个完整阅读套题。" }, { status: 404 });
  }
  if (message.includes("FULL_SET_ATTEMPT_NOT_FOUND") || message.includes("FULL_SET_MODULE_NOT_FOUND")) {
    return readingFullSetAttemptJson({ error: "没有找到这次套题练习记录。" }, { status: 404 });
  }
  if (message.includes("FULL_SET_MODULE_1_NOT_SUBMITTED")) {
    return readingFullSetAttemptJson({ error: "请先完成 Module 1。" }, { status: 409 });
  }
  if (message.includes("FULL_SET_INVALID_") || message.includes("FULL_SET_DUPLICATE_") || message.includes("FULL_SET_ANSWER_ID_")) {
    return readingFullSetAttemptJson({ error: "提交的套题答案无效。" }, { status: 400 });
  }
  if (error?.code === "42501" || message.includes("FULL_SET_STUDENT_REQUIRED")) {
    return readingFullSetAttemptJson({ error: "无权操作这次套题练习。" }, { status: 403 });
  }
  console.error("Reading Full Set attempt operation failed", {
    code: error?.code,
    message
  });
  return readingFullSetAttemptJson({ error: fallback }, { status: 500 });
}

export async function loadOwnedReadingFullSetAttempt(
  client: SupabaseClient,
  attemptId: string
) {
  const { data, error } = await client.rpc("get_reading_full_set_attempt", {
    p_attempt_id: attemptId
  });
  if (error) return { attempt: null, error };
  return {
    attempt: isReadingFullSetAttemptSummary(data) ? data : null,
    error: isReadingFullSetAttemptSummary(data)
      ? null
      : { message: "FULL_SET_INVALID_ATTEMPT_RESULT" }
  };
}

export function buildReadingFullSetRunnerPayload(
  attempt: ReadingFullSetAttemptSummary,
  fullSet: ReadingFullSet
): ReadingFullSetRunnerPayload {
  const activeModule = readingFullSetActiveModuleAttempt(attempt);
  const moduleOccurrences = activeModule?.moduleNumber === 1
    ? fullSet.module1.occurrences
    : activeModule?.moduleNumber === 2
      ? fullSet.module2.occurrences
      : [];
  return {
    attempt,
    occurrences: moduleOccurrences.map((occurrence): ReadingFullSetRunnerOccurrence => ({
      occurrenceId: occurrence.occurrenceId,
      logicalItemId: occurrence.logicalItemId,
      taskType: occurrence.taskType,
      sourceQuestionStart: occurrence.sourceQuestionStart,
      sourceQuestionEnd: occurrence.sourceQuestionEnd
    })),
    title: fullSet.title ?? attempt.fullSetId
  };
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isFullSetId(value: string) {
  return /^\d{8}[A-Za-z]*$/.test(value);
}

export function moduleNumber(value: string | number): 1 | 2 | null {
  const parsed = Number(value);
  return parsed === 1 || parsed === 2 ? parsed : null;
}
