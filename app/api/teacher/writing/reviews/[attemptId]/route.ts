import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  assertWritingReviewTeacher,
  loadWritingReviewWorkspace,
  saveWritingReviewWorkspace,
  WritingReviewWorkspaceServerError
} from "@/lib/writingReviewWorkspaceServer";
import {
  createHistoricalPracticeDisplayResolver,
  loadWritingHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings
} from "@/lib/historicalPracticeDisplay";
import { canManageWritingAttempt } from "@/lib/accountAccess";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    assertWritingReviewTeacher(auth);
    const supabase = createServiceSupabase();
    if (!await canManageWritingAttempt(supabase, { userId: auth.userId!, role: auth.role! }, params.attemptId)) {
      throw new WritingReviewWorkspaceServerError("ATTEMPT_NOT_FOUND", "未找到这条写作提交。", 404);
    }
    const workspace = await loadWritingReviewWorkspace(supabase, params.attemptId);
    // Only this attempt's question mapping is needed; custom questions never
    // consult the question-bank mapping at all.
    const historicalDisplayResolver = workspace.question_source === "question_bank"
      ? await loadWritingHistoricalPracticeDisplayResolver(
          supabase,
          workspace.attempt.task_type,
          [workspace.attempt.question_id]
        )
      : createHistoricalPracticeDisplayResolver({ items: [], sources: [] });
    const display = historicalDisplayResolver.resolveWritingAttempt({
      assignmentId: workspace.attempt.assignment_id,
      assignmentDisplayName: workspace.question.set_title,
      fallbackDisplayName:
        workspace.question.set_title ||
        workspace.attempt.set_id ||
        workspace.attempt.question_id,
      questionSource: workspace.question_source,
      rawQuestionId: workspace.attempt.question_id,
      taskType: workspace.attempt.task_type
    });
    logHistoricalPracticeDisplayWarnings([display]);
    return json({
      ...workspace,
      displayName: display.displayName,
      reviewContext: workspace.attempt.assignment_id
        ? workspace.question_source === "custom"
          ? "assignment_custom"
          : "assignment_question_bank"
        : "free_practice",
      logicalDisplay: display.logicalDisplayName
        ? {
            itemId: display.itemId,
            displayNumber: display.displayNumber,
            displayTitle: display.displayTitle,
            displayName: display.logicalDisplayName
          }
        : null
    });
  } catch (error) {
    return workspaceError(error, params.attemptId, "load");
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    assertWritingReviewTeacher(auth);
    const supabase = createServiceSupabase();
    if (!await canManageWritingAttempt(supabase, { userId: auth.userId!, role: auth.role! }, params.attemptId)) {
      throw new WritingReviewWorkspaceServerError("ATTEMPT_NOT_FOUND", "未找到这条写作提交。", 404);
    }
    const body = await request.json();
    const review = await saveWritingReviewWorkspace(
      supabase,
      params.attemptId,
      body
    );
    return json({ review });
  } catch (error) {
    return workspaceError(error, params.attemptId, "save");
  }
}

function workspaceError(error: unknown, attemptId: string, operation: string) {
  if (error instanceof WritingReviewWorkspaceServerError) {
    return json({ code: error.code, message: error.message }, { status: error.status });
  }
  console.error("Unexpected writing review workspace error", {
    attemptId,
    operation,
    error: error instanceof Error ? error.message : "Unknown error"
  });
  return json(
    { code: "INTERNAL_SERVER_ERROR", message: "批改工作台操作失败，请稍后重试。" },
    { status: 500 }
  );
}
