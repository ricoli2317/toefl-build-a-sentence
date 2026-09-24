import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { isReadingModule } from "@/lib/reading/catalog";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type ReadingCatalogSearchIndexRow = {
  logical_item_id: string;
  catalog_search_text?: string | null;
};

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

  const db = createServiceSupabase();
  let result = await readAllSupabaseRows<ReadingCatalogSearchIndexRow>((from, to) =>
    db.from("reading_logical_items")
      .select("logical_item_id,catalog_search_text")
      .eq("module", taskType)
      .range(from, to)
  );
  if (result.error?.message.includes("catalog_search_text") && result.error.message.includes("does not exist")) {
    result = await readAllSupabaseRows<ReadingCatalogSearchIndexRow>((from, to) =>
      db.from("reading_logical_items")
        .select("logical_item_id")
        .eq("module", taskType)
        .range(from, to)
    );
  }
  if (result.error) {
    console.error("Reading catalog search index load failed", {
      itemError: result.error.message
    });
    return json({ error: "搜索数据加载失败，请稍后重试。" }, { status: 500 });
  }

  return json({
    taskType,
    items: (result.data ?? []).map((row) => ({
      logical_item_id: row.logical_item_id,
      catalog_search_text: row.catalog_search_text ?? ""
    }))
  });
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
