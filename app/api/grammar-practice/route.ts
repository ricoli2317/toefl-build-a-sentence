import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken, isUserRole, roleCanAccess } from "@/lib/auth";
import {
  getGrammarTagSummaries,
  grammarPracticeModePolicy,
  normalizeGrammarPracticeMode,
  type GrammarTagSummary
} from "@/lib/grammarPractice";
import {
  loadGrammarQuestionPool,
  selectGrammarPracticeQuestions,
  toPublicGrammarQuestion
} from "@/lib/grammarPractice.server";
import { loadPracticeEntitlementEnforcementEnabled } from "@/lib/practiceEntitlements.server";
import { createSupabaseFetch } from "@/lib/supabase/fetch";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function jsonError(message: string, status = 500) {
  return json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return jsonError("Missing Supabase environment variables.");
    }
    if (!token) return jsonError("Missing access token", 401);

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { fetch: createSupabaseFetch(), headers: { Authorization: `Bearer ${token}` } }
    });
    const {
      data: { user },
      error: userError
    } = await authClient.auth.getUser(token);
    if (userError || !user) {
      return jsonError(userError?.message ?? "Invalid session", 401);
    }

    const { data: profile, error: profileError } = await authClient
      .from("profiles")
      .select("role,is_active")
      .eq("id", user.id)
      .single();
    if (profileError || profile?.is_active === false || !isUserRole(profile?.role) || !roleCanAccess(profile.role, "student")) {
      return jsonError(profileError?.message ?? "Unauthorized", 401);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        fetch: createSupabaseFetch(),
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });

    const url = new URL(request.url);
    const selectedTag = url.searchParams.get("tag")?.trim() ?? "";
    // Loading the tag list is a preview and never changes any entitlement.
    // The mode gate below applies only to an actual tagged question request.
    const mode = normalizeGrammarPracticeMode(url.searchParams.get("mode"));
    if (selectedTag) {
      let enforcementEnabled = false;
      if (profile.role === "student") {
        try {
          enforcementEnabled = await loadPracticeEntitlementEnforcementEnabled(db);
        } catch (error) {
          console.error("[grammar-practice] entitlement_switch_read_failed", {
            message: error instanceof Error ? error.message : String(error)
          });
          return jsonError("练习权限状态加载失败，请稍后重试。", 503);
        }
      }
      const policy = grammarPracticeModePolicy({
        role: profile.role,
        enforcementEnabled,
        mode
      });
      if (!policy.allowed) {
        return jsonError(policy.message ?? "当前练习模式不可用。", 403);
      }
    }

    const questions = await loadGrammarQuestionPool(db);
    if (!selectedTag) {
      const tags: GrammarTagSummary[] = getGrammarTagSummaries(questions);
      return json({ tags });
    }

    const selectedQuestions = selectGrammarPracticeQuestions(
      questions,
      selectedTag,
      mode
    );

    return json({
      count: selectedQuestions.length,
      questions: selectedQuestions.map(toPublicGrammarQuestion),
      tag: selectedTag
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load grammar practice.");
  }
}
