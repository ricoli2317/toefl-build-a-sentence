import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { findValidReadingFullSet } from "@/lib/reading/fullSets";
import { loadReadingFullSets } from "@/lib/reading/fullSets.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { fullSetId: string } }
) {
  const auth = await requireUserWithRole(bearerToken(request), "student");
  if (auth.error || !auth.userId) {
    return json({ error: "请先登录后再查看阅读套题。" }, { status: 401 });
  }

  try {
    const fullSets = await loadReadingFullSets(createServiceSupabase());
    const fullSet = findValidReadingFullSet(fullSets, params.fullSetId);
    if (!fullSet) return json({ error: "没有找到这个完整阅读套题。" }, { status: 404 });
    return json({ fullSet });
  } catch (error) {
    console.error("Reading Full Set detail load failed", {
      error,
      fullSetId: params.fullSetId
    });
    return json({ error: "阅读套题加载失败，请稍后重试。" }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
