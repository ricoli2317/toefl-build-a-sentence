import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { loadCachedPublicPracticeCatalogSearchIndex } from "@/lib/practiceCatalogCache.server";
import { isLogicalPracticeTaskType } from "@/lib/practiceLogicalCatalog";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const taskType = params.get("taskType");
    if (!isLogicalPracticeTaskType(taskType)) {
      return json({ error: "Invalid practice task type." }, { status: 400 });
    }

    const auth = await requireUserWithRole(bearerToken(request), "student");
    if (auth.error || !auth.userId) {
      return json({ error: auth.error ?? "Unauthorized" }, { status: 401 });
    }

    // Independent loader/cache/revision from the lightweight catalog: only this
    // route reads prompt / template / option / response text fields.
    const searchIndex = await loadCachedPublicPracticeCatalogSearchIndex(taskType);
    return json(searchIndex);
  } catch (error) {
    console.error("[practice-catalog] search_index_failed", error);
    return json({ error: "Could not load the logical practice search index." }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}
