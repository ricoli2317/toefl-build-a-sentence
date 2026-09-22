import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  assertWritingReviewTeacher,
  loadAuthorizedWritingReviewSource,
  loadWritingReviewWorkspace,
  saveWritingReviewWorkspace,
  WritingReviewWorkspaceServerError
} from "@/lib/writingReviewWorkspaceServer";
import {
  createHistoricalPracticeDisplayResolver,
  loadWritingHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings
} from "@/lib/historicalPracticeDisplay";
import type { WritingReviewWorkspaceSource } from "@/lib/writingReviewSource";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

// The resolver only resolves question-bank sources; custom snapshots and a
// missing assignment never consult the practice-item mapping.
function resolveQuestionSource(
  source: WritingReviewWorkspaceSource
): "question_bank" | "custom" | null {
  if (!source.attempt.assignment_id) return "question_bank";
  if (!source.assignment) return null;
  return source.assignment.question_source === "custom" ? "custom" : "question_bank";
}

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    assertWritingReviewTeacher(auth);
    const supabase = createServiceSupabase();
    const source = await loadAuthorizedWritingReviewSource(
      supabase,
      { userId: auth.userId!, role: auth.role! },
      params.attemptId
    );
    // The mapping query only needs this attempt's question id, so it starts
    // together with the workspace load instead of waiting behind it.
    const historicalDisplayResolverPromise =
      resolveQuestionSource(source) === "question_bank"
        ? loadWritingHistoricalPracticeDisplayResolver(
            supabase,
            source.attempt.task_type,
            [source.attempt.question_id]
          )
        : Promise.resolve(createHistoricalPracticeDisplayResolver({ items: [], sources: [] }));
    const [workspace, historicalDisplayResolver] = await Promise.all([
      loadWritingReviewWorkspace(supabase, params.attemptId, { source }),
      historicalDisplayResolverPromise
    ]);
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
    const source = await loadAuthorizedWritingReviewSource(
      supabase,
      { userId: auth.userId!, role: auth.role! },
      params.attemptId
    );
    const body = await request.json();
    const review = await saveWritingReviewWorkspace(
      supabase,
      params.attemptId,
      body,
      { source }
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
