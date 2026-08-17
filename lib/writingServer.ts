import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createAnonSupabase } from "@/lib/supabase/server";
import {
  WRITING_TASK_CONFIG,
  isWritingTaskType,
  type WritingAttempt,
  type WritingQuestion,
  type WritingTaskType
} from "@/lib/writing";
import { isWritingQuestionSnapshot } from "./writingAssignments.ts";

export function writingJson(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: {
      ...init?.headers,
      "Cache-Control": "no-store"
    }
  });
}

export async function requireWritingStudent(request: Request) {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "student");
  if (auth.error || !auth.userId || !token) {
    return {
      error: writingJson({ error: auth.error ?? "Unauthorized" }, { status: 401 }),
      supabase: null,
      userId: null
    };
  }

  return {
    error: null,
    supabase: createAnonSupabase(token),
    userId: auth.userId
  };
}

export function parseWritingTaskType(value: unknown) {
  return isWritingTaskType(value) ? value : null;
}

export async function readWritingQuestion(
  supabase: ReturnType<typeof createAnonSupabase>,
  taskType: WritingTaskType,
  questionId: string,
  assignmentId?: string | null
) {
  if (assignmentId) {
    const { data, error } = await supabase
      .from("writing_assignments")
      .select("task_type,question_source,question_snapshot,status,deleted_at")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    if (error) return { data: null, error, questionSource: null };
    if (data?.task_type === taskType && isWritingQuestionSnapshot(taskType, data.question_snapshot)) {
      return {
        assignmentAvailable: data.status === "active" && data.deleted_at === null,
        data: data.question_snapshot,
        error: null,
        questionSource: data.question_source === "custom" ? "custom" as const : "question_bank" as const
      };
    }
    return { data: null, error: null, questionSource: null };
  }
  const { data, error } = await supabase
    .from(WRITING_TASK_CONFIG[taskType].questionTable)
    .select("*")
    .eq("question_id", questionId)
    .maybeSingle();

  return {
    assignmentAvailable: true,
    data: data as WritingQuestion | null,
    error,
    questionSource: "question_bank" as const
  };
}

export async function readOwnedWritingAttempt(
  supabase: ReturnType<typeof createAnonSupabase>,
  userId: string,
  attemptId: string
) {
  const { data, error } = await supabase
    .from("writing_attempts")
    .select("*")
    .eq("attempt_id", attemptId)
    .eq("user_id", userId)
    .maybeSingle();

  return { data: data as WritingAttempt | null, error };
}

export function clampRemainingSeconds(value: unknown, timeLimit: number) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return timeLimit;
  return Math.max(0, Math.min(timeLimit, Math.floor(seconds)));
}
