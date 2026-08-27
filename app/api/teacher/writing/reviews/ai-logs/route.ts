import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import {
  projectWritingReviewAiLog,
  WRITING_REVIEW_AI_LOG_SAFE_COLUMNS
} from "@/lib/writingReviewAiLogProjection";
import { listVisibleStudentIds } from "@/lib/accountAccess";

export const dynamic = "force-dynamic";

const LOG_COLUMNS = WRITING_REVIEW_AI_LOG_SAFE_COLUMNS.join(",");

type AttemptRow = { attempt_id: string; user_id: string };
type ProfileRow = { id: string; email: string | null; full_name: string | null };

export async function GET(request: Request) {
  const auth = await requireUserWithRole(bearerToken(request), "teacher");
  if (auth.error || !auth.userId || !auth.role) {
    return response(
      { code: "UNAUTHORIZED", message: auth.error ?? "Unauthorized" },
      auth.error === "Unauthorized" ? 403 : 401
    );
  }

  const url = new URL(request.url);
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const pageSize = Math.min(
    positiveInteger(url.searchParams.get("page_size"), 25),
    100
  );
  const from = (page - 1) * pageSize;
  const supabase = createServiceSupabase();
  const visibleStudentIds = await listVisibleStudentIds(supabase, { userId: auth.userId, role: auth.role });
  if (visibleStudentIds.length === 0) return response({ logs: [], pagination: { page, page_size: pageSize, total: 0, total_pages: 0 } });
  const { data: visibleAttempts, error: visibleAttemptsError } = await supabase
    .from("writing_attempts").select("attempt_id").in("user_id", visibleStudentIds);
  if (visibleAttemptsError) return response({ code: "WRITING_AI_LOGS_LOAD_FAILED", message: "无法加载 AI 调用日志。" }, 500);
  const visibleAttemptIds = (visibleAttempts ?? []).map((attempt) => String(attempt.attempt_id));
  if (visibleAttemptIds.length === 0) return response({ logs: [], pagination: { page, page_size: pageSize, total: 0, total_pages: 0 } });
  let query = supabase
    .from("writing_review_ai_logs")
    .select(LOG_COLUMNS, { count: "exact" })
    .in("attempt_id", visibleAttemptIds);
  for (const field of [
    "attempt_id", "status", "pipeline_stage", "error_type", "error_code",
    "operation", "task_type", "model", "prompt_version"
  ] as const) {
    const value = url.searchParams.get(field)?.trim();
    if (value) query = query.eq(field, value);
  }
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error) {
    return response(
      { code: "WRITING_AI_LOGS_LOAD_FAILED", message: "无法加载 AI 调用日志。" },
      500
    );
  }

  const logs = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const attemptIds = unique(
    logs.map((log) => String(log.attempt_id)).filter(Boolean)
  );
  const { data: attempts } = attemptIds.length
    ? await supabase
        .from("writing_attempts")
        .select("attempt_id,user_id")
        .in("attempt_id", attemptIds)
    : { data: [] as AttemptRow[] };
  const attemptRows = (attempts ?? []) as AttemptRow[];
  const userIds = unique(attemptRows.map((attempt) => String(attempt.user_id)));
  const { data: profiles } = userIds.length
    ? await supabase
        .from("profiles")
        .select("id,email,full_name")
        .in("id", userIds)
    : { data: [] as ProfileRow[] };
  const attemptById = new Map(
    attemptRows.map((attempt) => [String(attempt.attempt_id), attempt])
  );
  const profileById = new Map(
    ((profiles ?? []) as ProfileRow[]).map((profile) => [String(profile.id), profile])
  );

  return response({
    logs: logs.map((log) => {
      const attempt = attemptById.get(String(log.attempt_id));
      const profile = attempt
        ? profileById.get(String(attempt.user_id))
        : undefined;
      return {
        ...projectWritingReviewAiLog(log),
        student_name: profile
          ? getPreferredUserDisplayName({
              email: profile.email,
              profileFullName: profile.full_name
            })
          : null
      };
    }),
    pagination: {
      page,
      page_size: pageSize,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / pageSize)
    }
  });
}

function positiveInteger(value: string | null, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function response(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}
