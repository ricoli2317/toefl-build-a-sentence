import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  attachReadingFullSetStudentStates,
  buildReadingFullSetCatalogStates,
  type ReadingFullSetCatalogAttemptRow
} from "@/lib/reading/fullSets";
import { loadCachedPublicReadingFullSetCatalog } from "@/lib/reading/catalogCache.server";
import { loadReadingFullSetPickerCatalog } from "@/lib/reading/fullSets.server";
import { loadStudentPracticeItemStates } from "@/lib/studentPracticeItemState.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "student");
  if (auth.error || !auth.userId) {
    return json({ error: "请先登录后再查看阅读套题。" }, { status: 401 });
  }

  const db = createServiceSupabase();
  try {
    // One request: cached complete Full Set public catalog + one sparse state
    // query. The browser slices 10 items per page locally.
    const [publicCatalog, stateResult] = await Promise.all([
      loadCachedPublicReadingFullSetCatalog(),
      loadStudentPracticeItemStates(db, { studentId: auth.userId, taskType: "full_set" })
    ]);
    if (stateResult.available) {
      return json({
        fullSets: attachReadingFullSetStudentStates(publicCatalog, stateResult.rows),
        total: publicCatalog.length
      });
    }

    // Transitional fallback while the sparse state migration is rolling out.
    const catalog = await loadReadingFullSetPickerCatalog(db);
    const attemptsResult = await db.from("reading_full_set_attempts")
      .select("attempt_id,full_set_id,status,completed_at,created_at")
      .eq("student_id", auth.userId);
    if (attemptsResult.error) {
      throw new Error(`read Reading Full Set catalog attempts: ${attemptsResult.error.message}`);
    }
    const stateByFullSet = buildReadingFullSetCatalogStates(
      (attemptsResult.data ?? []) as ReadingFullSetCatalogAttemptRow[]
    );
    return json({
      fullSets: catalog.map((fullSet) => ({
        ...fullSet,
        studentState: stateByFullSet.get(fullSet.fullSetId) ?? fullSet.studentState
      })),
      total: catalog.length
    });
  } catch (error) {
    console.error("Reading Full Set catalog load failed", { error });
    return json({ error: "阅读套题列表加载失败，请稍后重试。" }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
