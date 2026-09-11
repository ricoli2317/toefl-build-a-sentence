import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { buildReadingFullSetCatalog } from "@/lib/reading/fullSets";
import { loadReadingFullSets } from "@/lib/reading/fullSets.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "student");
  if (auth.error || !auth.userId) {
    return json({ error: "请先登录后再查看阅读套题。" }, { status: 401 });
  }

  try {
    const [fullSets, attemptsResult] = await Promise.all([
      loadReadingFullSets(createServiceSupabase()),
      createServiceSupabase().from("reading_full_set_attempts")
        .select("attempt_id,full_set_id,status,completed_at,created_at")
        .eq("student_id", auth.userId)
    ]);
    if (attemptsResult.error) throw new Error(attemptsResult.error.message);
    return json({ fullSets: buildReadingFullSetCatalog(fullSets, attemptsResult.data ?? []) });
  } catch (error) {
    console.error("Reading Full Set catalog load failed", { error });
    return json({ error: "阅读套题列表加载失败，请稍后重试。" }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
