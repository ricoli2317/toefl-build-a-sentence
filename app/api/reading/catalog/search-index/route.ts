import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { isReadingModule } from "@/lib/reading/catalog";
import { loadCachedPublicReadingCatalogSearchIndex } from "@/lib/reading/catalogCache.server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "student");
  if (auth.error || !auth.userId || !token) {
    return json({ error: "请先登录后再查看阅读练习。" }, { status: 401 });
  }
  const taskType = new URL(request.url).searchParams.get("taskType");
  if (!isReadingModule(taskType)) {
    return json({ error: "请选择有效的阅读练习类型。" }, { status: 400 });
  }

  try {
    // Separate loader/cache/revision from the lightweight catalog: this is the
    // only Reading catalog path allowed to read `catalog_search_text`.
    const payload = await loadCachedPublicReadingCatalogSearchIndex(taskType);
    return json(payload);
  } catch (error) {
    console.error("Reading catalog search index load failed", { error });
    return json({ error: "搜索数据加载失败，请稍后重试。" }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
