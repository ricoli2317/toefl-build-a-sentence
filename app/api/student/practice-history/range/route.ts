import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { loadStudentPracticeHistoryRange } from "@/lib/studentPracticeHistory.server";
import { normalizePracticeTimeZone } from "@/lib/teacherStudentPracticeRange";

export const dynamic = "force-dynamic";

/**
 * Range statistics for the authenticated student's own records. It returns the
 * seven summary cards plus per-day counters only — never practice records,
 * answers, question content or Full Set review data — and is only requested
 * after the student picks a range.
 */
export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/student/practice-history/range");
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
    const timeZone = normalizePracticeTimeZone(url.searchParams.get("timeZone"));

    const payload = await timing.measure("database", "student_practice_history_range", () =>
      loadStudentPracticeHistoryRange(
        createServiceSupabase(),
        auth.userId!,
        startAt,
        endAt,
        timeZone
      )
    );
    return json(payload);
  } catch (error) {
    console.error("Student practice history range load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "范围统计加载失败，请稍后重试。" }, { status: 500 });
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
