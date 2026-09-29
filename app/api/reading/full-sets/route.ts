import { bearerToken, loadStudentCatalogAuthorization, verifyAuthenticatedIdentity } from "@/lib/auth";
import {
  attachReadingFullSetStudentStates,
  buildReadingFullSetCatalogStates,
  type ReadingFullSetCatalogAttemptRow
} from "@/lib/reading/fullSets";
import { loadCachedPublicReadingFullSetCatalog } from "@/lib/reading/catalogCache.server";
import { loadReadingFullSetPickerCatalog } from "@/lib/reading/fullSets.server";
import { loadStudentPracticeItemStates } from "@/lib/studentPracticeItemState.server";
import { runStudentCatalogCriticalPath } from "@/lib/studentCatalogCriticalPath.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/reading/full-sets");
  const respond = (data: unknown, init?: ResponseInit) => json(data, init, timing);
  try {
    const token = bearerToken(request);
    const db = createServiceSupabase();
    // One request: cached complete Full Set public catalog + one sparse state
    // query, both started in parallel with the database profile authorization.
    // The browser slices 10 items per page locally.
    const result = await runStudentCatalogCriticalPath({
      timing,
      identity: async () => {
        const identity = await verifyAuthenticatedIdentity(token, timing);
        return identity.error || !identity.userId
          ? { ok: false as const, status: 401 as const, error: "请先登录后再查看阅读套题。" }
          : { ok: true as const, userId: identity.userId };
      },
      loadCatalog: () => loadCachedPublicReadingFullSetCatalog(),
      loadState: (studentId) => loadStudentPracticeItemStates(db, {
        studentId,
        taskType: "full_set",
        timing
      }),
      authorization: (userId) => loadStudentCatalogAuthorization(token, userId, timing),
      merge: async (publicCatalogResult, stateResult, studentId) => {
        if (!publicCatalogResult.ok) throw publicCatalogResult.error;
        if (!stateResult.ok) throw stateResult.error;
        const publicCatalog = publicCatalogResult.value;
        const state = stateResult.value;
        if (state.available) {
          return {
            fullSets: attachReadingFullSetStudentStates(publicCatalog, state.rows),
            total: publicCatalog.length
          };
        }

        // Transitional fallback while the sparse state migration is rolling out.
        const catalog = await loadReadingFullSetPickerCatalog(db);
        const attemptsResult = await db.from("reading_full_set_attempts")
          .select("attempt_id,full_set_id,status,completed_at,created_at")
          .eq("student_id", studentId);
        if (attemptsResult.error) {
          throw new Error(`read Reading Full Set catalog attempts: ${attemptsResult.error.message}`);
        }
        const stateByFullSet = buildReadingFullSetCatalogStates(
          (attemptsResult.data ?? []) as ReadingFullSetCatalogAttemptRow[]
        );
        return {
          fullSets: catalog.map((fullSet) => ({
            ...fullSet,
            studentState: stateByFullSet.get(fullSet.fullSetId) ?? fullSet.studentState
          })),
          total: catalog.length
        };
      }
    });
    if (result.forbidden) {
      return respond({ error: result.error }, { status: result.status });
    }
    return respond(result.data);
  } catch (error) {
    console.error("Reading Full Set catalog load failed", { error });
    return respond({ error: "阅读套题列表加载失败，请稍后重试。" }, { status: 500 });
  }
}

function json(
  data: unknown,
  init: ResponseInit | undefined,
  timing: ReturnType<typeof createStudentPerformanceTrace>
) {
  return NextResponse.json(data, {
    ...init,
    headers: timing.finishHeaders({ ...init?.headers, "Cache-Control": "no-store" })
  });
}
