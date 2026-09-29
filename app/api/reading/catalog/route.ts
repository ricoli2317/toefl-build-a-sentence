import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  attachReadingCatalogStudentStates,
  buildReadingCatalogPayload,
  isReadingModule,
  type ReadingCatalogAttemptRow,
  type ReadingCatalogItemRow
} from "@/lib/reading/catalog";
import { loadCachedPublicReadingCatalog } from "@/lib/reading/catalogCache.server";
import { loadStudentPracticeItemStates } from "@/lib/studentPracticeItemState.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "student");
  if (auth.error || !auth.userId || !token) {
    return json({ error: "请先登录后再查看阅读练习。" }, { status: 401 });
  }
  const taskType = new URL(request.url).searchParams.get("taskType");
  if (!isReadingModule(taskType)) {
    return json({ error: "请选择有效的阅读练习类型。" }, { status: 400 });
  }

  // Authentication is checked above; the service client lets the launched
  // catalog read the finalized inventory without mutating its legacy release flag.
  const db = createServiceSupabase();
  try {
    // One request: cached public lightweight catalog + one sparse indexed
    // student-state query, merged server-side. Search text is never read here.
    const [publicCatalog, stateResult] = await Promise.all([
      loadCachedPublicReadingCatalog(taskType),
      loadStudentPracticeItemStates(db, { studentId: auth.userId, taskType })
    ]);
    if (stateResult.available) {
      return json(attachReadingCatalogStudentStates(publicCatalog, stateResult.rows));
    }

    // Transitional fallback while the sparse state migration is rolling out.
    const legacy = await loadLegacyReadingCatalogInput(db, auth.userId, taskType);
    if (legacy.error) {
      console.error("Reading catalog load failed", { error: legacy.error });
      return json({ error: "阅读练习列表加载失败，请稍后重试。" }, { status: 500 });
    }
    return json(buildReadingCatalogPayload(legacy));
  } catch (error) {
    console.error("Reading catalog load failed", { error });
    return json({ error: "阅读练习列表加载失败，请稍后重试。" }, { status: 500 });
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

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
