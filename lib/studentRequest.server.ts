import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bearerToken, isUserRole, roleCanAccess } from "@/lib/auth";
import { createSupabaseFetch } from "@/lib/supabase/fetch";

export type StudentApiAuth = {
  /** Service-role client used for wrong-question bank reads/writes. */
  db: SupabaseClient;
  userId: string;
};

export function studentApiJson(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

/**
 * Shared student guard for the lightweight wrong-question APIs. Falls back to
 * the caller's token when no service role is configured, matching the existing
 * route behavior.
 */
export async function requireStudentApiAuth(request: Request): Promise<{
  auth?: StudentApiAuth;
  error?: NextResponse;
}> {
  const token = bearerToken(request);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { error: studentApiJson({ error: "Missing Supabase environment variables." }, 500) };
  }
  if (!token) return { error: studentApiJson({ error: "Missing access token" }, 401) };

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      fetch: createSupabaseFetch(),
      headers: { Authorization: `Bearer ${token}` }
    }
  });
  const {
    data: { user },
    error: userError
  } = await authClient.auth.getUser(token);
  if (userError || !user) {
    return { error: studentApiJson({ error: userError?.message ?? "Invalid session" }, 401) };
  }

  const { data: profile, error: profileError } = await authClient
    .from("profiles")
    .select("role,is_active")
    .eq("id", user.id)
    .single();
  if (
    profileError
    || profile?.is_active === false
    || !isUserRole(profile?.role)
    || !roleCanAccess(profile.role, "student")
  ) {
    return { error: studentApiJson({ error: profileError?.message ?? "Unauthorized" }, 401) };
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      fetch: createSupabaseFetch(),
      headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
    }
  });
  return { auth: { db, userId: user.id } };
}
