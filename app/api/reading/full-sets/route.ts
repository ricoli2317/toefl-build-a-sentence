import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { loadReadingFullSetCatalogPage } from "@/lib/reading/fullSets.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "student");
  if (auth.error || !auth.userId) {
    return json({ error: "请先登录后再查看阅读套题。" }, { status: 401 });
  }

  const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "10");
  if (!Number.isSafeInteger(page) || page < 1 || limit !== 10) {
    return json({ error: "无效的套题分页参数。" }, { status: 400 });
  }

  try {
    return json(await loadReadingFullSetCatalogPage(createServiceSupabase(), {
      page,
      studentId: auth.userId
    }));
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
