import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import { loadTeacherStudentPracticeRange } from "@/lib/teacherStudentPracticeRange.server";
import { normalizePracticeTimeZone } from "@/lib/teacherStudentPracticeRange";
import type { StudentBindingDomain } from "@/lib/studentBindings";

export const dynamic = "force-dynamic";

/**
 * Lightweight range statistics for one student. It returns only the seven
 * summary cards and the per-day ten-category counters; it never loads practice
 * records, answers, question content or Full Set review data.
 */
export async function GET(
  request: Request,
  { params }: { params: { studentId: string } }
) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看该学生的练习记录。" }, { status: 403 });
  }

  const studentId = String(params.studentId ?? "").trim();
  if (!studentId) return json({ error: "无效的学生。" }, { status: 400 });

  const url = new URL(request.url);
  const startAt = parseDateBoundary(url.searchParams.get("startAt"));
  const endAt = parseDateBoundary(url.searchParams.get("endAt"));
  if (!startAt || !endAt || Date.parse(startAt) >= Date.parse(endAt)) {
    return json({ error: "无效的日期范围。" }, { status: 400 });
  }
  const timeZone = normalizePracticeTimeZone(url.searchParams.get("timeZone"));

  try {
    const db = createServiceSupabase();
    const scope = await loadTeacherScope(db, { userId: auth.userId, role: auth.role });
    const profile = scope.studentProfiles.get(studentId);
    if (!profile) return json({ error: "未找到该学生。" }, { status: 404 });

    const boundDomains = scope.studentDomains.get(studentId) ?? [];
    const readingAllowed = boundDomains.includes("reading");
    const writingAllowed = boundDomains.includes("writing");
    if (!readingAllowed && !writingAllowed) {
      return json({ error: "无权查看该学生的练习记录。" }, { status: 403 });
    }

    const domains: StudentBindingDomain[] = [];
    if (readingAllowed) domains.push("reading");
    if (writingAllowed) domains.push("writing");

    const stats = await loadTeacherStudentPracticeRange(
      db,
      studentId,
      startAt,
      endAt,
      timeZone,
      { reading: readingAllowed, writing: writingAllowed }
    );

    return json({
      student: {
        studentId,
        displayName: profile.displayName,
        account: profile.email || "—",
        domains
      },
      range: { startAt, endAt, timeZone },
      reading: stats.reading,
      writing: stats.writing,
      days: stats.days
    });
  } catch (error) {
    console.error("Teacher student practice range load failed", {
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
