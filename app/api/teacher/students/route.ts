import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createTeacherStudentAccount } from "@/lib/teacherStudentAccount.server";

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error || !auth.userId || !auth.role) {
      return jsonError(auth.error ?? "Unauthorized", 401);
    }
    if (auth.role === "admin") {
      return NextResponse.json({ quota: { limited: false, count: null, limit: null, remaining: null } });
    }
    const supabase = createServiceSupabase();
    const [{ data: profile, error: profileError }, { count, error: countError }] = await Promise.all([
      supabase.from("profiles").select("student_account_limit").eq("id", auth.userId).single(),
      supabase.from("profiles").select("id", { count: "exact", head: true })
        .eq("role", "student").eq("is_active", true).eq("owner_id", auth.userId)
    ]);
    if (profileError || countError) throw profileError ?? countError;
    const limit = Number(profile?.student_account_limit ?? 20);
    const current = count ?? 0;
    return NextResponse.json({
      quota: { limited: true, count: current, limit, remaining: Math.max(0, limit - current) }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load quota.");
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error || !auth.userId || !auth.role) {
      return jsonError(auth.error ?? "Unauthorized", 401);
    }

    const body = (await request.json()) as {
      account?: string;
      password?: string;
      studentName?: string;
      domains?: unknown;
      confirmDuplicateName?: boolean;
    };

    const supabase = createServiceSupabase();
    const result = await createTeacherStudentAccount(supabase, {
      actorId: auth.userId,
      actorRole: auth.role === "admin" ? "admin" : "teacher",
      account: body.account ?? "",
      password: body.password ?? "",
      studentName: body.studentName ?? "",
      domains: body.domains,
      confirmDuplicateName: body.confirmDuplicateName === true
    });

    if (!result.ok) {
      return NextResponse.json(
        { code: result.code, error: result.error, candidates: result.candidates },
        { status: result.status }
      );
    }

    return NextResponse.json({ student: result.student });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create student.");
  }
}
