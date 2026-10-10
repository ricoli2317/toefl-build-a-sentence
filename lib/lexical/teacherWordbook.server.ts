import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import { readingAttemptJson } from "@/lib/reading/attemptServer";
import { parseWordbookQuery, type WordbookDomain } from "./wordbookList.ts";
import { readWordbookList, readWordbookActivityDates } from "./wordbookList.server.ts";
import { ReviewError, reviewPage, reviewUuid, type ReviewState } from "./wordbookReview.ts";
import { reviewRpc } from "./wordbookReview.server.ts";

type ReadKind = "scope" | "list" | "dates" | "history" | "result";
const forbidden = () => new ReviewError("WORDBOOK_FORBIDDEN", 403, "无权查看该学生或学科的生词本。");
const invalid = () => new ReviewError("WORDBOOK_INVALID", 400, "无效的生词本查询参数。");

/** GET-only teacher adapter. Authorize the target owner AND domain on every
 * request, before reading counts, senses, examples, or historical snapshots.
 * Student writes continue to use the authenticated owner's ID, never this ID.
 */
export async function teacherWordbookRead(request: Request, params: { studentId: string; sessionId?: string }, kind: ReadKind) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId || auth.role !== "teacher") throw forbidden();
    const studentId = reviewUuid(params.studentId);
    const search = new URL(request.url).searchParams;
    const db = createServiceSupabase();
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    const student = scope.studentProfiles.get(studentId);
    const domains = scope.studentDomains.get(studentId) ?? [];
    if (!student || !domains.length) throw forbidden();
    if (kind === "scope") {
      if (search.size) throw invalid();
      return readingAttemptJson({ studentId, displayName: student.displayName, domains });
    }
    // Require an explicit domain; never silently fall back to another subject.
    const domain = search.get("domain");
    if (domain !== "reading" && domain !== "writing") throw invalid();
    if (!domains.includes(domain)) throw forbidden();
    if (kind === "list" || kind === "dates") {
      let query;
      try { query = parseWordbookQuery(search); } catch { throw invalid(); }
      if (kind === "dates" && !query.month) throw invalid();
      return readingAttemptJson(kind === "list" ? await readWordbookList(db, studentId, query)
        : await readWordbookActivityDates(db, studentId, query));
    }
    const allowed = kind === "history" ? ["domain", "page"] : ["domain"];
    search.forEach((_value, key) => { if (!allowed.includes(key) || search.getAll(key).length !== 1) throw invalid(); });
    if (kind === "history") {
      const page = reviewPage(search.get("page"));
      // Filter BEFORE counting and paginating; the student history RPC includes
      // both subjects and must not be used then filtered after the fact.
      const { data, error, count } = await db.from("student_wordbook_review_sessions")
        .select("session_id", { count: "exact" }).eq("student_id", studentId).eq("domain", domain)
        .order("started_at", { ascending: false }).order("session_id")
        .range((page - 1) * 10, page * 10 - 1);
      if (error || !data || count === null) throw new Error("HISTORY_UNAVAILABLE");
      const items = await Promise.all(data.map(async row => {
        const state = await readSavedResult(db, studentId, domain, row.session_id);
        return { ...state.session, summary: state.summary };
      }));
      return readingAttemptJson({ items, total: count, page, pageSize: 10 });
    }
    const sessionId = reviewUuid(params.sessionId);
    // An authorized domain parameter cannot be used to read a different-domain
    // session or a different student's session. Fail without exposing its data.
    const { data, error } = await db.from("student_wordbook_review_sessions").select("session_id")
      .eq("student_id", studentId).eq("domain", domain).eq("session_id", sessionId).maybeSingle();
    if (error) throw new Error("RESULT_UNAVAILABLE");
    if (!data) throw forbidden();
    return readingAttemptJson(await readSavedResult(db, studentId, domain, sessionId));
  } catch (error) {
    return readingAttemptJson({ error: error instanceof ReviewError ? error.message : "生词本暂时无法读取，请稍后重试。",
      code: error instanceof ReviewError ? error.code : "WORDBOOK_UNAVAILABLE" },
    { status: error instanceof ReviewError ? error.status : 503 });
  }
}

async function readSavedResult(db: ReturnType<typeof createServiceSupabase>, studentId: string, domain: WordbookDomain, sessionId: string) {
  // STABLE read RPC only. flow_state/readReviewRound may INSERT an initial flow
  // even on GET, so neither is allowed in the teacher's read-only path.
  const state = await reviewRpc(db, "wordbook_review_read", {
    p_student: studentId, p_session: sessionId, p_position: null
  }) as ReviewState;
  if (state.session?.domain !== domain || state.session?.session_id !== sessionId) throw forbidden();
  return state;
}
