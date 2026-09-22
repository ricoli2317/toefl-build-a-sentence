import { NextResponse } from "next/server";
import { canAccessStudentDomain } from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
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

  try {
    const db = createServiceSupabase();
    const actor = { userId: auth.userId, role: auth.role };
    const profileResult = await db
      .from("profiles")
      .select("id,email,full_name")
      .eq("id", studentId)
      .eq("role", "student")
      .eq("is_active", true)
      .maybeSingle();
    if (profileResult.error) throw new Error(profileResult.error.message);
    const profile = profileResult.data as {
      id: string;
      email: string | null;
      full_name: string | null;
    } | null;
    if (!profile) return json({ error: "未找到该学生。" }, { status: 404 });

    const [readingAllowed, writingAllowed] = await Promise.all([
      canAccessStudentDomain(db, actor, studentId, "reading"),
      canAccessStudentDomain(db, actor, studentId, "writing")
    ]);
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

    return json({
      student: {
        studentId: profile.id,
        displayName: getPreferredUserDisplayName({
          email: profile.email,
          profileFullName: profile.full_name
        }),
        account: profile.email?.trim() || "—",
        domains
      },
      range: { startAt, endAt },
      reading,
      writing
    });
  } catch (error) {
    console.error("Teacher student practice load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "学生练习记录加载失败，请稍后重试。" }, { status: 500 });
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
