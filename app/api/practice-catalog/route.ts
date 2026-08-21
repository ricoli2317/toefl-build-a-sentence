import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  getLogicalPracticeItems,
  isLogicalPracticeTaskType,
  parseLogicalPracticePage
} from "@/lib/practiceLogicalCatalog";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/practice-catalog");
  const respond = (data: unknown, init?: ResponseInit) => json(data, init, timing);
  try {
    const params = new URL(request.url).searchParams;
    const taskType = params.get("taskType");
    const page = parseLogicalPracticePage(params.get("page"));
    if (!isLogicalPracticeTaskType(taskType)) {
      return respond({ error: "Invalid practice task type." }, { status: 400 });
    }
    if (page === null) {
      return respond({ error: "page must be a positive integer." }, { status: 400 });
    }

    const auth = await timing.measure("auth", "require_student", () =>
      requireUserWithRole(bearerToken(request), "student")
    );
    if (auth.error || !auth.userId) {
      return respond({ error: auth.error ?? "Unauthorized" }, { status: 401 });
    }

    const catalog = await getLogicalPracticeItems({
      supabase: createServiceSupabase(),
      studentId: auth.userId,
      taskType,
      page,
      timing
    });
    return respond(catalog);
  } catch (error) {
    console.error("[practice-catalog] logical_list_failed", error);
    return respond({ error: "Could not load the logical practice catalog." }, { status: 500 });
  }
}

function json(
  data: unknown,
  init: ResponseInit | undefined,
  timing: ReturnType<typeof createStudentPerformanceTrace>
) {
  return NextResponse.json(data, {
    ...init,
    headers: timing.finishHeaders({ ...init?.headers, "Cache-Control": "no-store" })
  });
}
