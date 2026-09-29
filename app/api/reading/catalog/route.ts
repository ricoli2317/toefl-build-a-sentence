import { bearerToken, loadStudentCatalogAuthorization, verifyAuthenticatedIdentity } from "@/lib/auth";
import {
  attachReadingCatalogStudentStates,
  buildReadingCatalogPayload,
  isReadingModule,
  type ReadingCatalogAttemptRow,
  type ReadingCatalogItemRow
} from "@/lib/reading/catalog";
import { loadCachedPublicReadingCatalog } from "@/lib/reading/catalogCache.server";
import { loadStudentPracticeItemStates } from "@/lib/studentPracticeItemState.server";
import { runStudentCatalogCriticalPath } from "@/lib/studentCatalogCriticalPath.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/reading/catalog");
  const respond = (data: unknown, init?: ResponseInit) => json(data, init, timing);
  try {
    const token = bearerToken(request);
    const taskType = new URL(request.url).searchParams.get("taskType");
    if (!isReadingModule(taskType)) {
      return respond({ error: "请选择有效的阅读练习类型。" }, { status: 400 });
    }

    // Authentication is gated by runStudentCatalogCriticalPath; the service
    // client lets the launched catalog read the finalized inventory without
    // mutating its legacy release flag. One request: cached public lightweight
    // catalog + one sparse indexed student-state query, merged server-side.
    // Search text is never read here.
    const db = createServiceSupabase();
    const result = await runStudentCatalogCriticalPath({
      timing,
      identity: async () => {
        const identity = await verifyAuthenticatedIdentity(token, timing);
        return identity.error || !identity.userId
          ? { ok: false as const, status: 401 as const, error: "请先登录后再查看阅读练习。" }
          : { ok: true as const, userId: identity.userId };
      },
      loadCatalog: () => loadCachedPublicReadingCatalog(taskType),
      loadState: (studentId) => loadStudentPracticeItemStates(db, {
        studentId,
        taskType,
        timing
      }),
      authorization: (userId) => loadStudentCatalogAuthorization(token, userId, timing),
      merge: async (publicCatalogResult, stateResult, studentId) => {
        if (!publicCatalogResult.ok) throw publicCatalogResult.error;
        if (!stateResult.ok) throw stateResult.error;
        const publicCatalog = publicCatalogResult.value;
        const state = stateResult.value;
        if (state.available) {
          return attachReadingCatalogStudentStates(publicCatalog, state.rows);
        }

        // Transitional fallback while the sparse state migration is rolling out.
        const legacy = await loadLegacyReadingCatalogInput(db, studentId, taskType);
        if (legacy.error) {
          throw new Error(legacy.error);
        }
        return buildReadingCatalogPayload(legacy);
      }
    });
    if (result.forbidden) {
      return respond({ error: result.error }, { status: result.status });
    }
    return respond(result.data);
  } catch (error) {
    console.error("Reading catalog load failed", { error });
    return respond({ error: "阅读练习列表加载失败，请稍后重试。" }, { status: 500 });
  }
}

async function loadLegacyReadingCatalogInput(
  db: ReturnType<typeof createServiceSupabase>,
  studentId: string,
  taskType: "ctw" | "rdl" | "rap"
) {
  const [itemResult, attemptResult] = await Promise.all([
    readAllSupabaseRows<ReadingCatalogItemRow>((from, to) =>
      db.from("reading_logical_items")
        .select("logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count,catalog_category,reading_source_occurrences(occurrence_id,occurrence_date)")
        .eq("module", taskType)
        .range(from, to)
    ),
    readAllSupabaseRows<ReadingCatalogAttemptRow>((from, to) =>
      db.from("reading_attempts")
        .select("attempt_id,logical_item_id,task_type,status,elapsed_seconds,correct_points,total_points,submitted_at,created_at,updated_at")
        .eq("student_id", studentId)
        .eq("task_type", taskType)
        .range(from, to)
    )
  ]);
  if (itemResult.error || attemptResult.error) {
    return {
      taskType,
      items: [],
      attempts: [],
      error: itemResult.error?.message ?? attemptResult.error?.message ?? "unknown error"
    };
  }
  return {
    taskType,
    items: itemResult.data ?? [],
    attempts: attemptResult.data ?? [],
    error: null
  };
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
