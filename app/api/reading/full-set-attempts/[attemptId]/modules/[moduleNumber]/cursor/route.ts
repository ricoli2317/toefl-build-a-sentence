import {
  isUuid,
  moduleNumber,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";

export const dynamic = "force-dynamic";

type CursorResult = {
  accepted: boolean;
  cursorRevision: number;
  reason?: "locked" | "stale_revision" | "timed_out";
};

export async function PUT(
  request: Request,
  { params }: { params: { attemptId: string; moduleNumber: string } }
) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error || !auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  const parsedModuleNumber = moduleNumber(params.moduleNumber);
  if (!isUuid(params.attemptId) || !parsedModuleNumber) {
    return readingFullSetAttemptJson({ error: "无效的套题题位请求。" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const occurrenceId = typeof body.occurrenceId === "string" ? body.occurrenceId.trim() : "";
  const questionIndex = body.questionIndex;
  const cursorRevision = body.cursorRevision;
  if (
    !occurrenceId
    || typeof questionIndex !== "number"
    || !Number.isInteger(questionIndex)
    || questionIndex < 0
    || typeof cursorRevision !== "number"
    || !Number.isSafeInteger(cursorRevision)
    || cursorRevision < 1
  ) {
    return readingFullSetAttemptJson({ error: "无效的套题题位请求。" }, { status: 400 });
  }

  const { data, error } = await auth.client.rpc("update_reading_full_set_navigation_cursor", {
    p_attempt_id: params.attemptId,
    p_cursor_revision: cursorRevision,
    p_module_number: parsedModuleNumber,
    p_occurrence_id: occurrenceId,
    p_question_index: questionIndex
  });
  if (error) return readingFullSetAttemptError(error, "套题题位保存失败。");
  if (!isCursorResult(data)) {
    return readingFullSetAttemptJson({ error: "套题题位保存状态无效。" }, { status: 500 });
  }
  return readingFullSetAttemptJson(data);
}

function isCursorResult(value: unknown): value is CursorResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<CursorResult>;
  return typeof result.accepted === "boolean"
    && Number.isInteger(result.cursorRevision)
    && (
      result.reason === undefined
      || result.reason === "locked"
      || result.reason === "stale_revision"
      || result.reason === "timed_out"
    );
}
