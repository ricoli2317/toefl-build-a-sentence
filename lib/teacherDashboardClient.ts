import type { TeacherDashboardPayload } from "@/lib/teacherDashboard";
import { createBrowserSupabase } from "@/lib/supabase/client";

export async function loadTeacherDashboardPayload(): Promise<TeacherDashboardPayload> {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();

  const response = await fetch("/api/teacher/dashboard", {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session?.access_token ?? ""}`
    }
  });
  const payload = (await response.json().catch(() => ({}))) as
    | TeacherDashboardPayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error : null;
    throw new Error(message || "无法加载教师首页数据。");
  }
  return payload as TeacherDashboardPayload;
}
