import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  buildStudentBindingCandidates,
  searchActiveStudents,
  type TeacherStudentProfileRow
} from "@/lib/teacherStudentBindings";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, {
  ...init,
  headers: { ...init?.headers, "Cache-Control": "no-store" }
});

function errorResponse(auth: { error: string | null }) {
  const forbidden = auth.error === "Forbidden";
  return json(
    { message: forbidden ? "仅普通教师可以绑定学生。" : "登录状态已失效，请重新登录。" },
    { status: forbidden ? 403 : 401 }
  );
}

export async function GET(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) return errorResponse(auth);

  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim();
    const studentId = (url.searchParams.get("studentId") ?? "").trim();
    // Search is always explicit: no query and no id means no student directory
    // is loaded.
    if (!query && !studentId) return json({ students: [] });

    const supabase = createServiceSupabase();
    const students: TeacherStudentProfileRow[] = studentId
      ? await (async () => {
          const { data, error } = await supabase
            .from("profiles")
            .select("id,email,full_name")
            .eq("id", studentId)
            .eq("role", "student")
            .eq("is_active", true)
            .maybeSingle();
          if (error) throw error;
          return data ? [data as TeacherStudentProfileRow] : [];
        })()
      : await searchActiveStudents(supabase, query);

    const candidates = await buildStudentBindingCandidates(supabase, students);
    return json({ students: candidates });
  } catch (error) {
    console.error("[teacher-students-search] failed", error);
    return json({ message: "学生搜索失败，请稍后重试。" }, { status: 500 });
  }
}
