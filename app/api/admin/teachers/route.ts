import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";

export const dynamic = "force-dynamic";

type TeacherRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  student_account_limit: number;
};
type StudentOwnerRow = { owner_id: string | null };

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, { ...init, headers: { ...init?.headers, "Cache-Control": "no-store" } });
}

async function authorize(request: Request) {
  return requireAdmin(bearerToken(request));
}

export async function GET(request: Request) {
  const auth = await authorize(request);
  if (auth.error) return json({ message: "仅管理员可以查看教师账号。" }, { status: 403 });
  try {
    const db = createServiceSupabase();
    const [teachers, owners] = await Promise.all([
      readAllSupabaseRows<TeacherRow>((from, to) => db.from("profiles")
        .select("id,email,full_name,student_account_limit")
        .eq("role", "teacher").eq("is_active", true)
        .order("full_name", { ascending: true, nullsFirst: false }).range(from, to)),
      readAllSupabaseRows<StudentOwnerRow>((from, to) => db.from("profiles")
        .select("owner_id").eq("role", "student").eq("is_active", true)
        .order("id", { ascending: true }).range(from, to))
    ]);
    if (teachers.error || owners.error) throw teachers.error ?? owners.error;
    const counts = new Map<string, number>();
    for (const row of owners.data ?? []) {
      if (row.owner_id) counts.set(row.owner_id, (counts.get(row.owner_id) ?? 0) + 1);
    }
    return json({ teachers: (teachers.data ?? []).map((teacher) => ({
      id: teacher.id,
      email: teacher.email ?? "",
      displayName: teacher.full_name?.trim() || teacher.email || "教师",
      studentCount: counts.get(teacher.id) ?? 0,
      studentAccountLimit: teacher.student_account_limit
    })) });
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "教师列表加载失败。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authorize(request);
  if (auth.error) return json({ message: "仅管理员可以创建教师账号。" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const limit = Number(body.studentAccountLimit ?? 20);
  if (!fullName || !email || password.length < 6 || !validLimit(limit)) {
    return json({ message: "请填写教师姓名、有效账号、至少 6 位密码和正整数额度。" }, { status: 400 });
  }
  const db = createServiceSupabase();
  const { data, error } = await db.auth.admin.createUser({
    email, password, email_confirm: true,
    // The DB trigger always creates a least-privilege student first. This protected
    // endpoint promotes it to teacher immediately after Auth creation.
    user_metadata: { full_name: fullName, display_name: fullName, name: fullName, role: "student", owner_id: auth.userId }
  });
  if (error || !data.user) return json({ message: error?.message ?? "教师账号创建失败。" }, { status: 409 });
  const { error: profileError } = await db.from("profiles").upsert({
    id: data.user.id, email, full_name: fullName, role: "teacher",
    owner_id: null, student_account_limit: limit, is_active: true
  }, { onConflict: "id" });
  if (profileError) {
    await db.auth.admin.deleteUser(data.user.id);
    return json({ message: "教师资料保存失败，账号创建已撤销。" }, { status: 500 });
  }
  return json({ teacher: { id: data.user.id, email, displayName: fullName, studentAccountLimit: limit } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const auth = await authorize(request);
  if (auth.error) return json({ message: "仅管理员可以统一调整额度。" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const limit = Number(body.studentAccountLimit);
  if (!validLimit(limit)) return json({ message: "额度必须是正整数。" }, { status: 400 });
  const db = createServiceSupabase();
  const { data, error } = await db.from("profiles")
    .update({ student_account_limit: limit })
    .eq("role", "teacher").eq("is_active", true)
    .select("id");
  if (error) return json({ message: error.message }, { status: 500 });
  return json({ updatedCount: data?.length ?? 0, studentAccountLimit: limit });
}

function validLimit(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 100000;
}
