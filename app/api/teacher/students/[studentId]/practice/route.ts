import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  appendSupabaseDebugMetrics,
  instrumentSupabaseClient,
  wantsSupabaseDebugMetrics,
  type SupabaseQueryMetric
} from "@/lib/supabase/debugMetrics.server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import {
  loadTeacherStudentReadingPractice,
  loadTeacherStudentWritingPractice
} from "@/lib/teacherStudentPractice.server";
import type { StudentBindingDomain } from "@/lib/studentBindings";

export const dynamic = "force-dynamic";

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

  const debugMetrics: SupabaseQueryMetric[] = [];
  const debugEnabled = wantsSupabaseDebugMetrics(request);

  try {
    const baseDb = createServiceSupabase();
    const db = debugEnabled ? instrumentSupabaseClient(baseDb, debugMetrics) : baseDb;
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

    const [reading, writing] = await Promise.all([
      readingAllowed
        ? loadTeacherStudentReadingPractice(db, studentId, startAt, endAt)
        : Promise.resolve(null),
      writingAllowed
        ? loadTeacherStudentWritingPractice(db, studentId, startAt, endAt)
        : Promise.resolve(null)
    ]);

    const response = json({
      student: {
        studentId,
        displayName: profile.displayName,
        account: profile.email || "—",
        domains
      },
      range: { startAt, endAt },
      reading,
      writing
    });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  } catch (error) {
    console.error("Teacher student practice load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    const response = json({ error: "学生练习记录加载失败，请稍后重试。" }, { status: 500 });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
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
