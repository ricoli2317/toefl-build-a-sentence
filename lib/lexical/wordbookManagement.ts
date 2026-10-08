import type { WordbookDomain } from "./wordbookList.ts";

export const WORDBOOK_BATCH_LIMIT = 50;
export type WordbookBatchDelete = { domain: WordbookDomain; entryIds: string[] };
export function parseWordbookBatchDelete(value: unknown): WordbookBatchDelete {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("无效的删除请求。");
  const input = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (Object.keys(input).some(key => !["domain", "entryIds"].includes(key))
    || !["reading", "writing"].includes(String(input.domain)) || !Array.isArray(input.entryIds)
    || input.entryIds.length < 1 || input.entryIds.length > WORDBOOK_BATCH_LIMIT
    || input.entryIds.some(id => typeof id !== "string" || !uuid.test(id))) throw new Error("无效的删除请求。");
  const entryIds = (input.entryIds as string[]).map(id => id.toLowerCase());
  if (new Set(entryIds).size !== entryIds.length) throw new Error("删除请求包含重复词条。");
  return { domain: input.domain as WordbookDomain, entryIds };
}

export function wordbookSerial(page: number, pageSize: number, index: number) {
  return (page - 1) * pageSize + index + 1;
}
export function wordbookSelectionIdentity(studentId: string | null, domain: WordbookDomain,
  filters: { page: number; sort: string; start: string; end: string }) {
  return JSON.stringify([studentId, domain, filters.page, filters.sort, filters.start, filters.end]);
}
