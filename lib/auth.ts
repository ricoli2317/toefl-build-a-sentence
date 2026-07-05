import { createAnonSupabase, createServiceSupabase } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types";

export async function requireUserWithRole(token: string | null, role: UserRole) {
  if (!token) {
    return { error: "Missing access token", userId: null };
  }

  const anon = createAnonSupabase();
  const {
    data: { user },
    error: userError
  } = await anon.auth.getUser(token);

  if (userError || !user) {
    return { error: "Invalid session", userId: null };
  }

  const service = createServiceSupabase();
  const { data: profile, error: profileError } = await service
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileError || profile?.role !== role) {
    return { error: "Unauthorized", userId: null };
  }

  return { error: null, userId: user.id };
}

export function bearerToken(request: Request) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}
