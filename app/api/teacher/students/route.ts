import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error || !auth.userId) {
      return jsonError(auth.error ?? "Unauthorized", 401);
    }

    const body = (await request.json()) as {
      email?: string;
      password?: string;
      studentName?: string;
    };
    const email = body.email?.trim().toLocaleLowerCase();
    const password = body.password ?? "";
    const studentName = body.studentName?.trim();

    if (!email || !password || !studentName) {
      return jsonError("Email, password, and student name are required.", 400);
    }

    if (password.length < 6) {
      return jsonError("Password must be at least 6 characters.", 400);
    }

    const supabase = createServiceSupabase();
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: studentName,
        full_name: studentName,
        name: studentName
      }
    });

    if (error || !data.user) {
      return jsonError(error?.message ?? "Failed to create student.", 500);
    }

    const { error: profileError } = await supabase.from("profiles").upsert(
      {
        id: data.user.id,
        email,
        full_name: studentName,
        role: "student"
      },
      { onConflict: "id" }
    );

    if (profileError) {
      return jsonError(`Student auth user created, but profile save failed: ${profileError.message}`);
    }

    return NextResponse.json({
      student: {
        id: data.user.id,
        email,
        displayName: getPreferredUserDisplayName({
          email,
          metadata: data.user.user_metadata
        })
      }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not create student.");
  }
}
