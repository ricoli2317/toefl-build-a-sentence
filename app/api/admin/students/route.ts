import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";

type StudentRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  is_active: boolean | null;
  created_at: string | null;
};

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(bearerToken(request));
    if (auth.error || !auth.userId) {
      return NextResponse.json(
        { error: "无权访问平台学生列表。" },
        { status: 403 }
      );
    }

    const supabase = createServiceSupabase();
    const result = await readAllSupabaseRows<StudentRow>((from, to) =>
      supabase
        .from("profiles")
        .select("id,email,full_name,is_active,created_at")
        .eq("role", "student")
        .order("full_name", { ascending: true, nullsFirst: false })
        .order("email", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;

    return NextResponse.json({
      students: (result.data ?? []).map((student) => ({
        id: student.id,
        email: student.email ?? "",
        displayName: getPreferredUserDisplayName({
          email: student.email,
          profileFullName: student.full_name
        }),
        isActive: student.is_active !== false,
        createdAt: student.created_at
      }))
    });
  } catch (error) {
    console.error("[admin-students] list_failed", error);
    return NextResponse.json(
      { error: "学生列表加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}