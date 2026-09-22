import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { validateStudentBindingInput } from "@/lib/studentBindings";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, {
  ...init,
  headers: { ...init?.headers, "Cache-Control": "no-store" }
});

type ProfileRow = { id: string; email: string | null; full_name: string | null };
type BindingRow = { binding_id: string; teacher_id: string; student_id: string; domain: string };

function authorName(row: ProfileRow) {
  return getPreferredUserDisplayName({ email: row.email, profileFullName: row.full_name }) || "";
}

export async function GET(request: Request) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error) return json({ message: "仅管理员可以查看教师绑定。" }, { status: 403 });
  try {
    const db = createServiceSupabase();
    const [students, teachers, bindings] = await Promise.all([
      readAllSupabaseRows<ProfileRow>((from, to) => db.from("profiles")
        .select("id,email,full_name").eq("role", "student").eq("is_active", true)
        .order("full_name", { ascending: true, nullsFirst: false }).range(from, to)),
      readAllSupabaseRows<ProfileRow>((from, to) => db.from("profiles")
        .select("id,email,full_name").eq("role", "teacher").eq("is_active", true)
        .order("full_name", { ascending: true, nullsFirst: false }).range(from, to)),
      readAllSupabaseRows<BindingRow>((from, to) => db.from("teacher_student_bindings")
        .select("binding_id,teacher_id,student_id,domain")
        .order("created_at", { ascending: true }).range(from, to))
    ]);
    if (students.error || teachers.error || bindings.error) {
      throw students.error ?? teachers.error ?? bindings.error;
    }

    const studentMap = new Map((students.data ?? []).map((row) => [row.id, row]));
    const teacherMap = new Map((teachers.data ?? []).map((row) => [row.id, row]));

    return json({
      students: (students.data ?? []).map((row) => ({
        id: row.id,
        displayName: authorName(row),
        email: row.email ?? ""
      })),
      teachers: (teachers.data ?? []).map((row) => ({
        id: row.id,
        displayName: authorName(row),
        email: row.email ?? ""
      })),
      bindings: (bindings.data ?? []).map((row) => {
        const student = studentMap.get(row.student_id);
        const teacher = teacherMap.get(row.teacher_id);
        return {
          bindingId: row.binding_id,
          domain: row.domain,
          teacherId: row.teacher_id,
          teacherName: teacher ? authorName(teacher) : "",
          teacherEmail: teacher?.email ?? "",
          studentId: row.student_id,
          studentName: student ? authorName(student) : "",
          studentEmail: student?.email ?? ""
        };
      })
    });
  } catch (error) {
    return json({ message: error instanceof Error ? error.message : "绑定数据加载失败。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error) return json({ message: "仅管理员可以新增教师绑定。" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const checked = validateStudentBindingInput({
    teacherId: typeof body.teacherId === "string" ? body.teacherId : "",
    studentId: typeof body.studentId === "string" ? body.studentId : "",
    domain: typeof body.domain === "string" ? body.domain : ""
  });
  if (!checked.ok) return json({ message: checked.error }, { status: 400 });

  const db = createServiceSupabase();
  const [teacher, student] = await Promise.all([
    db.from("profiles").select("id")
      .eq("id", body.teacherId).eq("role", "teacher").eq("is_active", true).maybeSingle(),
    db.from("profiles").select("id")
      .eq("id", body.studentId).eq("role", "student").eq("is_active", true).maybeSingle()
  ]);
  if (teacher.error || student.error) return json({ message: teacher.error?.message ?? student.error?.message }, { status: 500 });
  if (!teacher.data) return json({ message: "未找到有效的教师账号。" }, { status: 404 });
  if (!student.data) return json({ message: "未找到有效的学生账号。" }, { status: 404 });

  const { data: existing, error: existingError } = await db.from("teacher_student_bindings")
    .select("binding_id")
    .eq("teacher_id", body.teacherId).eq("student_id", body.studentId).eq("domain", checked.domain)
    .maybeSingle();
  if (existingError) return json({ message: existingError.message }, { status: 500 });
  if (existing) return json({ message: "该绑定已存在，无需重复添加。" }, { status: 409 });

  const { data, error } = await db.from("teacher_student_bindings")
    .insert({ teacher_id: body.teacherId, student_id: body.studentId, domain: checked.domain })
    .select("binding_id,domain")
    .single();
  if (error) {
    if (/duplicate key|unique|23505/.test(error.message)) {
      return json({ message: "该绑定已存在，无需重复添加。" }, { status: 409 });
    }
    return json({ message: error.message }, { status: 500 });
  }
  return json({ binding: { bindingId: data.binding_id, domain: data.domain } }, { status: 201 });
}