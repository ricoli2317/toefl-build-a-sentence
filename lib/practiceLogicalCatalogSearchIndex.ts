import type { PracticeTaskType } from "./practiceImporter/types.ts";

export type LogicalPracticeCatalogSearchIndexEntry = {
  item_id: string;
  search_text: string;
};

export type LogicalPracticeCatalogSearchIndexPayload = {
  taskType: PracticeTaskType;
  items: LogicalPracticeCatalogSearchIndexEntry[];
};

export function logicalPracticeCatalogSearchTextMap(
  payload: LogicalPracticeCatalogSearchIndexPayload | null
) {
  return new Map(
    (payload?.items ?? []).map((item) => [item.item_id, item.search_text])
  );
}

export async function loadLogicalPracticeCatalogSearchIndex(
  taskType: PracticeTaskType,
  session: { accessToken: string }
): Promise<LogicalPracticeCatalogSearchIndexPayload> {
  const response = await fetch(
    `/api/practice-catalog/search-index?taskType=${encodeURIComponent(taskType)}`,
    {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session.accessToken}` }
    }
  );
  const payload = await response.json().catch(() => ({})) as
    LogicalPracticeCatalogSearchIndexPayload & { error?: string };
  if (!response.ok || payload.error || !Array.isArray(payload.items)) {
    throw new Error(payload.error ?? "搜索数据加载失败。");
  }
  return payload;
}
