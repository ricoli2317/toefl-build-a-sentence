import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { loadCachedPublicReadingCatalog } from "@/lib/reading/catalogCache.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { loadStudentPracticeHistoryDay } from "@/lib/studentPracticeHistory.server";

export const dynamic = "force-dynamic";

/**
 * One calendar day of the authenticated student's own practice records.
 *
 * The subject is always the session user id: the route accepts no student id,
 * so it can never read another student's data. It reuses the teacher
 * student-detail loaders (cached reading catalog numbering, historical title
 * resolution and published review scores) with the seven-task-type scope.
 */
export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/student/practice-history");
  try {
    const auth = await timing.measure("auth", "require_student", () =>
      requireUserWithRole(bearerToken(request), "student")
    );
    if (auth.error || !auth.userId) {
      return json({ error: "无权查看练习记录。" }, { status: 401 });
    }

    const url = new URL(request.url);
    const startAt = parseDateBoundary(url.searchParams.get("startAt"));
    const endAt = parseDateBoundary(url.searchParams.get("endAt"));
    if (!startAt || !endAt || Date.parse(startAt) >= Date.parse(endAt)) {
      return json({ error: "无效的日期范围。" }, { status: 400 });
    }

    const payload = await timing.measure("database", "student_practice_history_day", () =>
      loadStudentPracticeHistoryDay(
        createServiceSupabase(),
        auth.userId!,
        startAt,
        endAt,
        loadCachedPublicReadingCatalog
      )
    );
    return json(payload);
  } catch (error) {
    console.error("Student practice history day load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "练习记录加载失败，请稍后重试。" }, { status: 500 });
  }
}

function parseDateBoundary(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
