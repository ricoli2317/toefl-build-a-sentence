import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

function json(
  data: unknown,
  init: ResponseInit | undefined,
  timing: ReturnType<typeof createStudentPerformanceTrace>
) {
  return NextResponse.json(data, {
    ...init,
    headers: timing.finishHeaders(init?.headers)
  });
}

export async function GET(
  request: Request,
  { params }: { params: { setId: string } }
) {
  const timing = createStudentPerformanceTrace("/api/sets/[setId]/questions");
  const respond = (data: unknown, init?: ResponseInit) => json(data, init, timing);
  try {
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return respond(
        { error: "Missing Supabase environment variables." },
        { status: 500 }
      );
    }

    if (!token) {
      return respond({ error: "Missing access token" }, { status: 401 });
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` }
      }
    });

    const {
      data: { user },
      error: userError
    } = await timing.measure("auth", "supabase_auth_get_user", () =>
      authClient.auth.getUser(token)
    );

    if (userError || !user) {
      return respond({ error: "Invalid session" }, { status: 401 });
    }

    const { data: profile, error: profileError } = await timing.measure(
      "database",
      "profiles_role",
      () => authClient.from("profiles").select("role,is_active").eq("id", user.id).single()
    );

    if (profileError || profile?.is_active === false || !["student", "admin"].includes(profile?.role ?? "")) {
      return respond({ error: "Unauthorized" }, { status: 401 });
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const readClient = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });

    const { data, error } = await timing.measure(
      "database",
      "questions_current_practice_set",
      () =>
        readClient
          .from("questions")
          .select(
            "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text"
          )
          .eq("set_id", params.setId)
          .order("question_order", { ascending: true })
          .limit(10)
    );

    if (error) {
      return respond({ error: error.message }, { status: 500 });
    }

    const payload = timing.measureSync("processing", "build_practice_questions_payload", () => ({
      questions: data ?? []
    }));
    return respond(payload);
  } catch (error) {
    return respond(
      { error: error instanceof Error ? error.message : "Could not load questions." },
      { status: 500 }
    );
  }
}
