import { bearerToken, loadStudentCatalogAuthorization, verifyAuthenticatedIdentity } from "@/lib/auth";
import {
  getLogicalPracticeItems,
  isLogicalPracticeTaskType
} from "@/lib/practiceLogicalCatalog";
import { loadStudentPracticeItemStates } from "@/lib/studentPracticeItemState.server";
import {
  loadPracticeEntitlementEnforcementEnabled,
  loadStudentPracticeUnlockItemIds
} from "@/lib/practiceEntitlements.server";
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
    let viewerRole: "student" | "teacher" | "admin" | null = null;
    // One request: a cached public lightweight catalog, one sparse student
    // state query and one batched unlock query. The payload has no search text;
    // the search index is a separate request prefetched by the client.
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
      authorization: async (userId) => {
        const authorization = await loadStudentCatalogAuthorization(token, userId, timing);
        if (authorization.ok) viewerRole = authorization.role;
        return authorization;
      },
      merge: async (catalogResult, stateResult, studentId) => {
        if (!catalogResult.ok) throw catalogResult.error;
        if (!stateResult.ok) throw stateResult.error;
        const [catalog, unlockedItemIds, enforcementEnabled] = await Promise.all([
          getLogicalPracticeItems({
            supabase: db,
            taskType,
            timing,
            publicCatalogPromise: Promise.resolve(catalogResult.value),
            studentStatePromise: Promise.resolve(stateResult.value)
          }),
          viewerRole === "student"
            ? loadStudentPracticeUnlockItemIds(db, { studentId, taskType })
            : Promise.resolve(new Set<string>()),
          loadPracticeEntitlementEnforcementEnabled(db)
        ]);
        return {
          ...catalog,
          enforcementEnabled,
          viewerRole,
          items: catalog.items.map((item) => ({
            ...item,
            unlocked: unlockedItemIds.has(item.item_id)
          }))
        };
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
