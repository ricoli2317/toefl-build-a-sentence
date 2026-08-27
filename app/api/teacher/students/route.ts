import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { prepareNewAccount } from "@/lib/accountIdentifier";

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
    };
    const preparedAccount = prepareNewAccount(body.account ?? "");
    const password = body.password ?? "";
    const studentName = body.studentName?.trim();

    if (!preparedAccount.ok) return jsonError(preparedAccount.error, 400);
    if (!password || !studentName) return jsonError("Account, password, and student name are required.", 400);

    if (password.length < 6) {
      return jsonError("Password must be at least 6 characters.", 400);
    }

    const supabase = createServiceSupabase();
    const { account, authEmail } = preparedAccount;
    const { data: existingProfile, error: existingProfileError } = await supabase.from("profiles")
      .select("id").ilike("email", authEmail).maybeSingle();
    if (existingProfileError) throw existingProfileError;
    if (existingProfile) return jsonError("该账号已存在。", 409);
    if (auth.role === "teacher") {
      const [{ data: profile, error: profileError }, { count, error: countError }] = await Promise.all([
        supabase.from("profiles").select("student_account_limit").eq("id", auth.userId).single(),
        supabase.from("profiles").select("id", { count: "exact", head: true })
          .eq("role", "student").eq("is_active", true).eq("owner_id", auth.userId)
      ]);
      if (profileError || countError) throw profileError ?? countError;
      if ((count ?? 0) >= Number(profile?.student_account_limit ?? 20)) {
        return jsonError("STUDENT_ACCOUNT_LIMIT_REACHED", 409);
      }
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email: authEmail,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: studentName,
        full_name: studentName,
        name: studentName,
        role: "student",
        owner_id: auth.userId
      }
    });

    if (error || !data.user) {
      const message = /already (been )?registered|already exists/i.test(error?.message ?? "")
        ? "该账号已存在。"
        : error?.message ?? "Failed to create student.";
      return jsonError(message, /already (been )?registered|already exists/i.test(error?.message ?? "") ? 409 : 500);
    }

    const { error: profileError } = await supabase.from("profiles").upsert(
      {
        id: data.user.id,
        email: authEmail,
        full_name: studentName,
        role: "student",
        owner_id: auth.userId,
        is_active: true
      },
      { onConflict: "id" }
    );

    if (profileError) {
      await supabase.auth.admin.deleteUser(data.user.id);
      return jsonError(`Student auth user created, but profile save failed: ${profileError.message}`);
    }

    return NextResponse.json({
      student: {
        id: data.user.id,
        account,
        displayName: getPreferredUserDisplayName({
          email: authEmail,
          metadata: data.user.user_metadata
        })
      }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create student.");
  }
}
