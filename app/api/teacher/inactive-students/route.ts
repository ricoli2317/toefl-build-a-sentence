import { NextResponse } from "next/server";
import { listVisibleStudentIds } from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadInactiveStudentsWithLastActivity } from "@/lib/teacherStudentActivity.server";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";

export const dynamic = "force-dynamic";

const DATABASE_BATCH_SIZE = 100;

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}

export async function GET(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看未活跃学生名单。" }, { status: 403 });
  }

  try {
    const db = createServiceSupabase();
    const visibleStudentIds = await listVisibleStudentIds(db, {
      userId: auth.userId,
      role: auth.role
    });
    const { inactiveStudentIds, lastActivityByStudent } =
      await loadInactiveStudentsWithLastActivity(db, visibleStudentIds, new Date());

    const ranked = [...inactiveStudentIds].sort((left, right) => {
      const leftActivity = lastActivityByStudent.get(left);
      const rightActivity = lastActivityByStudent.get(right);
      if (leftActivity === rightActivity) return left.localeCompare(right);
      if (!leftActivity) return -1;
      if (!rightActivity) return 1;
      return Date.parse(leftActivity) - Date.parse(rightActivity);
    });
    const studentNames = await loadStudentNames(db, ranked);

    return json({
      students: ranked.map((studentId) => ({
        studentId,
        studentName: studentNames.get(studentId) ?? "学生",
        lastActivityAt: lastActivityByStudent.get(studentId) ?? null
      }))
    });
  } catch (error) {
    console.error("Teacher inactive students load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "未活跃学生名单加载失败，请稍后重试。" }, { status: 500 });
  }
}

async function loadStudentNames(
  db: ReturnType<typeof createServiceSupabase>,
  studentIds: string[]
) {
  const names = new Map<string, string>();
  for (let index = 0; index < studentIds.length; index += DATABASE_BATCH_SIZE) {
    const batch = studentIds.slice(index, index + DATABASE_BATCH_SIZE);
    const { data, error } = await db
      .from("profiles")
      .select("id,email,full_name")
      .in("id", batch);
    if (error) throw new Error(error.message);
    for (const profile of (data ?? []) as ProfileRow[]) {
      names.set(
        String(profile.id),
        getPreferredUserDisplayName({
          email: profile.email,
          profileFullName: profile.full_name
        })
      );
    }
  }
  return names;
}
