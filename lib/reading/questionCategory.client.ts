import type { StudentCacheSession } from "../../components/StudentDataCache";
import { CATEGORY_API, type CategorySessionPayload } from "./questionCategory.ts";

export const categorySessionCacheKey = (id: string) => `reading:category-session:${id}`;
export const categoryPracticeCacheKey = (id: string) => `reading:category-content:${id}`;
export const categoryGroupUrl = (id: string, itemId: string) =>
  `${CATEGORY_API}/sessions/${encodeURIComponent(id)}/groups/${encodeURIComponent(itemId)}`;

export async function categoryFetch<T>(url: string, auth: StudentCacheSession, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : method, cache: "no-store",
    headers: { Authorization: `Bearer ${auth.accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error ?? "阅读练习加载失败，请稍后重试。");
  return payload;
}
export function loadCategorySession(id: string, auth: StudentCacheSession) {
  return categoryFetch<CategorySessionPayload>(`${CATEGORY_API}/sessions/${encodeURIComponent(id)}`, auth);
}
