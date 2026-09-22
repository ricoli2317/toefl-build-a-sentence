import { NextResponse } from "next/server";
import { canAccessStudentDomain } from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { loadTeacherStudentBasAnswerDetail } from "@/lib/teacherStudentPractice.server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptAnswerId: string; studentId: string } }
) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看该学生的 BAS 答题记录。" }, { status: 403 });
  }

  const studentId = String(params.studentId ?? "").trim();
  const attemptAnswerId = String(params.attemptAnswerId ?? "").trim();
  if (!studentId || !attemptAnswerId) {
    return json({ error: "无效的答题记录。" }, { status: 400 });
  }

  try {
    const db = createServiceSupabase();
    if (!(await canAccessStudentDomain(db, { userId: auth.userId, role: auth.role }, studentId, "writing"))) {
      return json({ error: "无权查看该学生的 BAS 答题记录。" }, { status: 403 });
    }

    const [profileResult, detail] = await Promise.all([
      db
        .from("profiles")
        .select("id,email,full_name")
        .eq("id", studentId)
        .eq("role", "student")
        .eq("is_active", true)
        .maybeSingle(),
      loadTeacherStudentBasAnswerDetail(db, studentId, attemptAnswerId)
    ]);
    if (profileResult.error) throw new Error(profileResult.error.message);
    const profile = profileResult.data as {
      id: string;
      email: string | null;
      full_name: string | null;
    } | null;
    if (!profile) return json({ error: "未找到该学生。" }, { status: 404 });
    if (!detail) return json({ error: "未找到答题记录。" }, { status: 404 });

    return json({
      student: {
        studentId: profile.id,
        displayName: getPreferredUserDisplayName({
          email: profile.email,
          profileFullName: profile.full_name
        }),
        account: profile.email?.trim() || "—"
      },
      ...detail
    });
  } catch (error) {
    console.error("Teacher student BAS answer load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "答题详情加载失败，请稍后重试。" }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
