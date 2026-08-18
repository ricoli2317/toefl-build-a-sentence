import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  getLogicalPracticeItems,
  isLogicalPracticeTaskType,
  parseLogicalPracticePage
} from "@/lib/practiceLogicalCatalog";
import { createServiceSupabase } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const taskType = params.get("taskType");
    const page = parseLogicalPracticePage(params.get("page"));
    if (!isLogicalPracticeTaskType(taskType)) {
      return json({ error: "Invalid practice task type." }, { status: 400 });
    }
    if (page === null) {
      return json({ error: "page must be a positive integer." }, { status: 400 });
    }

    const auth = await requireUserWithRole(bearerToken(request), "student");
    if (auth.error || !auth.userId) {
      return json({ error: auth.error ?? "Unauthorized" }, { status: 401 });
    }

    const catalog = await getLogicalPracticeItems({
      supabase: createServiceSupabase(),
      studentId: auth.userId,
      taskType,
      page
    });
    return json(catalog);
  } catch (error) {
    console.error("[practice-catalog] logical_list_failed", error);
    return json({ error: "Could not load the logical practice catalog." }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}
