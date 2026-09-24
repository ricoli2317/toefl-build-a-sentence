import type { ReadingModule } from "./types.ts";

export type ReadingCatalogSearchIndexEntry = {
  logical_item_id: string;
  catalog_search_text: string;
};

export type ReadingCatalogSearchIndexPayload = {
  taskType: ReadingModule;
  items: ReadingCatalogSearchIndexEntry[];
};

export function readingCatalogSearchTextMap(payload: ReadingCatalogSearchIndexPayload | null) {
  return new Map(
    (payload?.items ?? []).map((item) => [item.logical_item_id, item.catalog_search_text])
  );
}

export async function loadReadingCatalogSearchIndex(
  taskType: ReadingModule,
  session: { accessToken: string }
): Promise<ReadingCatalogSearchIndexPayload> {
  const response = await fetch(
    `/api/reading/catalog/search-index?taskType=${encodeURIComponent(taskType)}`,
    {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session.accessToken}` }
    }
  );
  const payload = await response.json().catch(() => ({})) as
    ReadingCatalogSearchIndexPayload & { error?: string };
  if (!response.ok || payload.error || !Array.isArray(payload.items)) {
    throw new Error(payload.error ?? "搜索数据加载失败。");
  }
  return payload;
}
