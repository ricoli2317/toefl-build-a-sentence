import { requireStudentApiAuth, studentApiJson } from "@/lib/studentRequest.server";
import {
  loadBasQuestionsByIds,
  loadWrongQuestionPracticeSession,
  loadWrongQuestionSessionElapsedSeconds
} from "@/lib/wrongQuestionBank.server";

export const dynamic = "force-dynamic";

/** Resumes the frozen session manifest so refresh/back never re-randomizes. */
export async function GET(
  request: Request,
  { params }: { params: { sessionId: string } }
) {
  try {
    const { auth, error } = await requireStudentApiAuth(request);
    if (error || !auth) return error ?? studentApiJson({ error: "Unauthorized" }, 401);

    const sessionId = params.sessionId?.trim();
    if (!sessionId) return studentApiJson({ error: "无效的错题练习请求。" }, 400);

    const session = await loadWrongQuestionPracticeSession(auth.db, auth.userId, sessionId);
    if (!session) return studentApiJson({ error: "错题练习不存在或已失效。" }, 404);

    if (session.taskType !== "bas") {
      // The session-wide elapsed time travels with the manifest (first-screen
      // data), so the review can show the final number immediately.
      const elapsedSeconds = await loadWrongQuestionSessionElapsedSeconds(auth.db, session);
      return studentApiJson({ session: { ...session, elapsedSeconds } });
    }
    const questions = await loadBasQuestionsByIds(auth.db, session.questionIds ?? []);
    return studentApiJson({ questions, session });
  } catch (caught) {
    return studentApiJson(
      { error: caught instanceof Error ? caught.message : "错题练习加载失败。" },
      500
    );
  }
}
