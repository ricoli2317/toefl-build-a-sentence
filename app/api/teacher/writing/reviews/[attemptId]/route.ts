import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  assertWritingReviewTeacher,
  loadWritingReviewWorkspace,
  saveWritingReviewWorkspace,
  WritingReviewWorkspaceServerError
} from "@/lib/writingReviewWorkspaceServer";

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
    assertWritingReviewTeacher(
      await requireUserWithRole(bearerToken(request), "teacher")
    );
    return json(
      await loadWritingReviewWorkspace(createServiceSupabase(), params.attemptId)
    );
  } catch (error) {
    return workspaceError(error, params.attemptId, "load");
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    assertWritingReviewTeacher(
      await requireUserWithRole(bearerToken(request), "teacher")
    );
    const body = await request.json();
    const review = await saveWritingReviewWorkspace(
      createServiceSupabase(),
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
