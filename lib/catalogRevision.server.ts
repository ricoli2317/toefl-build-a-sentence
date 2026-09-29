import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceSupabase } from "./supabase/server.ts";
import { isCatalogRevisionUnavailableError } from "./studentPracticeItemState.ts";
import type { StudentPracticeItemTaskType } from "./studentPracticeItemState.ts";

/**
 * Public catalog cache revisions.
 *
 * The `catalog_revisions` table is bumped by database triggers on every content
 * source (importer, Supabase SQL editor, Admin API, ...). The application reads
 * the current revision before every cached build and includes it in the cache
 * key, so a plain `insert into practice_item_occurrences ...` is visible on the
 * next catalog read without any Next.js `revalidateTag` involvement.
 */
export type CatalogCacheKind = "lightweight_catalog" | "search_index";

export async function loadCatalogRevision(input: {
  taskType: StudentPracticeItemTaskType;
  cacheKind: CatalogCacheKind;
  supabase?: SupabaseClient;
}): Promise<number> {
  const supabase = input.supabase ?? createServiceSupabase();
  const result = await supabase
    .from("catalog_revisions")
    .select("revision")
    .eq("task_type", input.taskType)
    .eq("cache_kind", input.cacheKind)
    .maybeSingle();

  if (result.error) {
    if (isCatalogRevisionUnavailableError(result.error)) return 0;
    // Serving the catalog matters more than failing on a revision read; the
    // versioned cache simply keeps its current entry until the read recovers.
    console.warn("[catalog-revision] read_failed", {
      taskType: input.taskType,
      cacheKind: input.cacheKind,
      error: result.error.message
    });
    return 0;
  }

  const revision = Number(result.data?.revision ?? 0);
  return Number.isFinite(revision) && revision >= 0 ? revision : 0;
}

export function catalogCacheTag(input: {
  prefix: string;
  taskType: StudentPracticeItemTaskType;
  version: number;
}) {
  return `${input.prefix}:${input.taskType}:v${input.version}`;
}
