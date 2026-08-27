import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";

export const dynamic = "force-dynamic";
const response = (data: unknown, init?: ResponseInit) => NextResponse.json(data, { ...init, headers: { ...init?.headers, "Cache-Control": "no-store" } });

export async function GET(request: Request, { params }: { params: { teacherId: string } }) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error) return response({ message: "仅管理员可以查看教师详情。" }, { status: 403 });
  const db = createServiceSupabase();
  const [teacher, students] = await Promise.all([
    db.from("profiles").select("id,email,full_name,student_account_limit")
      .eq("id", params.teacherId).eq("role", "teacher").eq("is_active", true).maybeSingle(),
    readAllSupabaseRows<{ id: string; email: string | null; full_name: string | null }>((from, to) => db.from("profiles")
      .select("id,email,full_name").eq("role", "student").eq("is_active", true)
      .eq("owner_id", params.teacherId).order("full_name", { ascending: true, nullsFirst: false }).range(from, to))
  ]);
  if (teacher.error || students.error) return response({ message: teacher.error?.message ?? students.error?.message }, { status: 500 });
  if (!teacher.data) return response({ message: "未找到教师账号。" }, { status: 404 });
  return response({ teacher: {
    id: teacher.data.id,
    email: teacher.data.email ?? "",
    displayName: getPreferredUserDisplayName({ email: teacher.data.email, profileFullName: teacher.data.full_name }),
    studentAccountLimit: teacher.data.student_account_limit,
    studentCount: students.data?.length ?? 0,
    students: (students.data ?? []).map((student) => ({
      id: student.id,
      email: student.email ?? "",
      displayName: getPreferredUserDisplayName({ email: student.email, profileFullName: student.full_name })
    }))
  } });
}

export async function PATCH(request: Request, { params }: { params: { teacherId: string } }) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error) return response({ message: "仅管理员可以调整额度。" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const limit = Number(body.studentAccountLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) return response({ message: "额度必须是正整数。" }, { status: 400 });
  const { data, error } = await createServiceSupabase().from("profiles")
    .update({ student_account_limit: limit }).eq("id", params.teacherId)
    .eq("role", "teacher").eq("is_active", true).select("id").maybeSingle();
  if (error) return response({ message: error.message }, { status: 500 });
  if (!data) return response({ message: "未找到教师账号。" }, { status: 404 });
  return response({ studentAccountLimit: limit });
}
