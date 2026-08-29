import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  loadStudentReadingPractice,
  StudentReadingLoadError
} from "@/lib/reading/studentPractice";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function GET(
  request: Request,
  { params }: { params: { itemId: string } }
) {
  const auth = await requireUserWithRole(bearerToken(request), "student");
  if (auth.error || !auth.userId) {
    return json({ error: "请先登录后再开始阅读练习。" }, { status: 401 });
  }

  try {
    const practice = await loadStudentReadingPractice(
      createServiceSupabase(),
      params.itemId
    );
    return json({ practice });
  } catch (error) {
    if (error instanceof StudentReadingLoadError) {
      console.error("Student Reading practice load failed", {
        detail: error.message,
        itemId: params.itemId,
        status: error.status
      });
      return json({ error: error.publicMessage }, { status: error.status });
    }
    console.error("Student Reading practice load failed", { error, itemId: params.itemId });
    return json({ error: "阅读练习加载失败，请稍后重试。" }, { status: 500 });
  }
}
