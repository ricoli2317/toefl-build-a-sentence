import { bearerToken, loadStudentCatalogAuthorization, verifyAuthenticatedIdentity } from "@/lib/auth";
import {
  getLogicalPracticeItems,
  isLogicalPracticeTaskType
} from "@/lib/practiceLogicalCatalog";
import { loadStudentPracticeItemStates } from "@/lib/studentPracticeItemState.server";
import { runStudentCatalogCriticalPath } from "@/lib/studentCatalogCriticalPath.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { loadCachedPublicPracticeCatalog } from "@/lib/practiceCatalogCache.server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/practice-catalog");
  const respond = (data: unknown, init?: ResponseInit) => json(data, init, timing);
  try {
    const params = new URL(request.url).searchParams;
    const taskType = params.get("taskType");
    if (!isLogicalPracticeTaskType(taskType)) {
      return respond({ error: "Invalid practice task type." }, { status: 400 });
    }

    const token = bearerToken(request);
    const db = createServiceSupabase();
    // One request: a cached public lightweight catalog and one sparse student
    // state query, both started in parallel with the database profile
    // authorization. The payload has no search text; the search index is a
    // separate request prefetched by the client after the first screen renders.
    const result = await runStudentCatalogCriticalPath({
      timing,
      identity: async () => {
        const identity = await verifyAuthenticatedIdentity(token, timing);
        return identity.error || !identity.userId
          ? { ok: false as const, status: 401 as const, error: identity.error ?? "Unauthorized" }
          : { ok: true as const, userId: identity.userId };
      },
      loadCatalog: () => loadCachedPublicPracticeCatalog(taskType),
      loadState: (studentId) => loadStudentPracticeItemStates(db, {
        studentId,
        taskType,
        timing
      }),
      authorization: (userId) => loadStudentCatalogAuthorization(token, userId, timing),
      merge: async (catalogResult, stateResult) => {
        if (!catalogResult.ok) throw catalogResult.error;
        if (!stateResult.ok) throw stateResult.error;
        return getLogicalPracticeItems({
          supabase: db,
          taskType,
          timing,
          publicCatalogPromise: Promise.resolve(catalogResult.value),
          studentStatePromise: Promise.resolve(stateResult.value)
        });
      }
    });
    if (result.forbidden) {
      return respond({ error: result.error }, { status: result.status });
    }
    return respond(result.data);
  } catch (error) {
    console.error("[practice-catalog] logical_list_failed", error);
    return respond({ error: "Could not load the logical practice catalog." }, { status: 500 });
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
