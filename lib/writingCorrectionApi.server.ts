import { requireWritingStudent, writingJson } from "./writingServer";
import { createServiceSupabase } from "./supabase/server";
import { correctionDisplayName } from "./writingCorrectionTitle.server.ts";
import { WritingCorrectionError } from "./writingCorrection.ts";
import { createOrResumeWritingCorrection, loadOwnedWritingCorrection,
  loadWritingCorrectionHistory, mutateWritingCorrection } from "./writingCorrection.server.ts";

export async function writingCorrectionRequest(request: Request, attemptId?: string) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.userId) return writingJson({ error: "Unauthorized" }, { status: 401 });
    const db = createServiceSupabase();
    if (request.method === "GET") {
      const result = attemptId
        ? await loadOwnedWritingCorrection(db, auth.userId, attemptId)
        : await loadWritingCorrectionHistory(db, auth.userId, new URL(request.url).searchParams.get("originalAttemptId") ?? "");
      if ("attempt" in result) result.attempt.display_name = await correctionDisplayName(db, result.attempt);
      return writingJson(result);
    }
    let body: unknown;
    try { body = await request.json(); } catch {
      throw new WritingCorrectionError("INVALID_INPUT", "请求需为有效 JSON。", 400);
    }
    const result = attemptId
      ? await mutateWritingCorrection(db, auth.userId, attemptId, body)
      : await createOrResumeWritingCorrection(db, auth.userId, body);
    result.attempt.display_name = await correctionDisplayName(db, result.attempt);
    return writingJson(result, { status: !attemptId && !result.resumed ? 201 : 200 });
  } catch (error) {
    if (error instanceof WritingCorrectionError) {
      return writingJson({ code: error.code, error: error.message }, { status: error.status });
    }
    return writingJson({ code: "CORRECTION_REQUEST_FAILED", error: "订正操作失败，请稍后重试。" }, { status: 500 });
  }
}
