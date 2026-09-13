import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { mapWithConcurrency } from "@/lib/mapWithConcurrency";
import {
  loadStudentReadingPractice,
  StudentReadingLoadError
} from "@/lib/reading/studentPractice";
import { createServiceSupabase } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireUserWithRole(bearerToken(request), "student");
  if (auth.error || !auth.userId) {
    return json({ error: "请先登录后再开始阅读练习。" }, { status: 401 });
  }
  const itemIds = Array.from(new Set(
    (new URL(request.url).searchParams.get("itemIds") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  ));
  if (
    itemIds.length === 0
    || itemIds.length > 20
    || itemIds.some((itemId) => !/^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/.test(itemId))
  ) {
    return json({ error: "无效的阅读题目批量请求。" }, { status: 400 });
  }

  try {
    const db = createServiceSupabase();
    const practices = await mapWithConcurrency(itemIds, 3, (itemId) =>
      loadStudentReadingPractice(db, itemId)
    );
    return json({ practices });
  } catch (error) {
    if (error instanceof StudentReadingLoadError) {
      console.error("Student Reading batch practice load failed", {
        detail: error.message,
        status: error.status
      });
      return json({ error: error.publicMessage }, { status: error.status });
    }
    console.error("Student Reading batch practice load failed", { error });
    return json({ error: "阅读练习加载失败，请稍后重试。" }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}
