import type { SupabaseClient } from "@supabase/supabase-js";
import { requireStudentApiAuth, studentApiJson } from "@/lib/studentRequest.server";
import {
  isWrongQuestionBankTaskType,
  normalizeWrongQuestionHistoryAmount,
  type WrongQuestionPracticeSession
} from "@/lib/wrongQuestionBank";
import {
  createWrongQuestionPracticeSession,
  loadBasQuestionsByIds,
  loadWrongQuestionHistoryCount,
  loadWrongQuestionPracticeSession
} from "@/lib/wrongQuestionBank.server";
import { wrongQuestionBusinessDate } from "@/lib/wrongQuestionBusinessDate";

export const dynamic = "force-dynamic";

/**
 * Creates or resumes the frozen wrong-question practice session. The manifest
 * is stored once (identities + order only); content is never bulk-loaded here.
 */
export async function POST(request: Request) {
  try {
    const { auth, error } = await requireStudentApiAuth(request);
    if (error || !auth) return error ?? studentApiJson({ error: "Unauthorized" }, 401);

    const body = await request.json().catch(() => ({})) as {
      amount?: unknown;
      mode?: unknown;
      sessionId?: unknown;
      taskType?: unknown;
    };
    const taskType = isWrongQuestionBankTaskType(body.taskType) ? body.taskType : null;
    const mode = body.mode === "history" || body.mode === "today" ? body.mode : null;
    if (!taskType || !mode) {
      return studentApiJson({ error: "无效的错题练习请求。" }, 400);
    }
    const amount = body.amount === null || body.amount === undefined
      ? null
      : normalizeWrongQuestionHistoryAmount(body.amount);
    if (body.amount !== null && body.amount !== undefined && amount === null) {
      return studentApiJson({ error: "无效的错题练习数量。" }, 400);
    }
    // "Practice all history questions" is cancelled: a history session must
    // always be one of the 5 / 10 / 15 / 20 amounts.
    if (mode === "history" && amount === null) {
      return studentApiJson({ error: "历史错题练习需要选择 5 / 10 / 15 / 20 题。" }, 400);
    }

    if (typeof body.sessionId === "string" && body.sessionId.trim()) {
      const resumed = await loadWrongQuestionPracticeSession(
        auth.db,
        auth.userId,
        body.sessionId.trim()
      );
      if (resumed && resumed.taskType === taskType && resumed.mode === mode) {
        return studentApiJson(await sessionPayload(auth.db, resumed));
      }
    }

    if (mode === "history") {
      const historyCount = await loadWrongQuestionHistoryCount(auth.db, auth.userId, taskType);
      if (historyCount === 0) {
        return studentApiJson({ error: "当前没有历史错题。" }, 409);
      }
    }

    let session: WrongQuestionPracticeSession;
    try {
      session = await createWrongQuestionPracticeSession({
        amount,
        db: auth.db,
        mode,
        practiceDate: wrongQuestionBusinessDate(),
        studentId: auth.userId,
        taskType
      });
    } catch (caught) {
      if (caught instanceof Error && caught.message === "WRONG_QUESTION_SESSION_EMPTY") {
        return studentApiJson({ error: "当前没有待订正错题。" }, 409);
      }
      throw caught;
    }
    return studentApiJson(await sessionPayload(auth.db, session));
  } catch (caught) {
    return studentApiJson(
      { error: caught instanceof Error ? caught.message : "错题练习创建失败。" },
      500
    );
  }
}

async function sessionPayload(db: SupabaseClient, session: WrongQuestionPracticeSession) {
  if (session.taskType !== "bas") return { session };
  const questions = await loadBasQuestionsByIds(db, session.questionIds ?? []);
  return { questions, session };
}
