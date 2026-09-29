import { unstable_cache } from "next/cache";
import { catalogCacheTag, loadCatalogRevision } from "@/lib/catalogRevision.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  buildReadingCatalogPublicPayload,
  type ReadingCatalogItemRow,
  type ReadingCatalogPublicPayload
} from "@/lib/reading/catalog";
import type {
  ReadingCatalogSearchIndexPayload
} from "@/lib/reading/catalogSearchIndex";
import { buildReadingFullSetPublicCatalog, type ReadingFullSetPublicCatalogItem } from "@/lib/reading/fullSets";
import { loadReadingFullSetDefinitions } from "@/lib/reading/fullSets.server";
import type { ReadingModule } from "@/lib/reading/types";

export const READING_CATALOG_CACHE_VERSION = 1;

export function readingCatalogCacheTag(taskType: ReadingModule) {
  return catalogCacheTag({
    prefix: "reading-catalog",
    taskType,
    version: READING_CATALOG_CACHE_VERSION
  });
}

export function readingCatalogSearchIndexCacheTag(taskType: ReadingModule) {
  return catalogCacheTag({
    prefix: "reading-catalog-search-index",
    taskType,
    version: READING_CATALOG_CACHE_VERSION
  });
}

export function readingFullSetCatalogCacheTag() {
  return catalogCacheTag({
    prefix: "reading-full-set-catalog",
    taskType: "full_set",
    version: READING_CATALOG_CACHE_VERSION
  });
}

/**
 * The revision argument is part of the cache key only; database triggers bump
 * the revision for the affected task type, including direct SQL writes.
 */
function createReadingCatalogLoader(taskType: ReadingModule) {
  return unstable_cache(
    async (revision: number): Promise<ReadingCatalogPublicPayload> => {
      void revision;
      return loadPublicReadingCatalog(taskType);
    },
    ["public-reading-catalog", String(READING_CATALOG_CACHE_VERSION), taskType],
    {
      revalidate: 60 * 60,
      tags: [readingCatalogCacheTag(taskType)]
    }
  );
}

function createReadingSearchIndexLoader(taskType: ReadingModule) {
  return unstable_cache(
    async (revision: number): Promise<ReadingCatalogSearchIndexPayload> => {
      void revision;
      return loadPublicReadingCatalogSearchIndex(taskType);
    },
    ["public-reading-catalog-search-index", String(READING_CATALOG_CACHE_VERSION), taskType],
    {
      revalidate: 60 * 60,
      tags: [readingCatalogSearchIndexCacheTag(taskType)]
    }
  );
}

function createReadingFullSetCatalogLoader() {
  return unstable_cache(
    async (revision: number): Promise<ReadingFullSetPublicCatalogItem[]> => {
      void revision;
      return buildReadingFullSetPublicCatalog(await loadReadingFullSetDefinitions(createServiceSupabase()));
    },
    ["public-reading-full-set-catalog", String(READING_CATALOG_CACHE_VERSION)],
    {
      revalidate: 60 * 60,
      tags: [readingFullSetCatalogCacheTag()]
    }
  );
}

const readingCatalogLoaders: Record<ReadingModule, (revision: number) => Promise<ReadingCatalogPublicPayload>> = {
  ctw: createReadingCatalogLoader("ctw"),
  rdl: createReadingCatalogLoader("rdl"),
  rap: createReadingCatalogLoader("rap")
};

const readingSearchIndexLoaders: Record<ReadingModule, (revision: number) => Promise<ReadingCatalogSearchIndexPayload>> = {
  ctw: createReadingSearchIndexLoader("ctw"),
  rdl: createReadingSearchIndexLoader("rdl"),
  rap: createReadingSearchIndexLoader("rap")
};

const readingFullSetCatalogLoader = createReadingFullSetCatalogLoader();

export async function loadCachedPublicReadingCatalog(taskType: ReadingModule) {
  const revision = await loadCatalogRevision({
    taskType,
    cacheKind: "lightweight_catalog"
  });
  return readingCatalogLoaders[taskType](revision);
}

export async function loadCachedPublicReadingCatalogSearchIndex(taskType: ReadingModule) {
  const revision = await loadCatalogRevision({
    taskType,
    cacheKind: "search_index"
  });
  return readingSearchIndexLoaders[taskType](revision);
}

export async function loadCachedPublicReadingFullSetCatalog() {
  const revision = await loadCatalogRevision({
    taskType: "full_set",
    cacheKind: "lightweight_catalog"
  });
  return readingFullSetCatalogLoader(revision);
}

/** Lightweight directory read: never selects `catalog_search_text`. */
export async function loadPublicReadingCatalog(
  taskType: ReadingModule
): Promise<ReadingCatalogPublicPayload> {
  const db = createServiceSupabase();
  const result = await readAllSupabaseRows<ReadingCatalogItemRow>((from, to) =>
    db
      .from("reading_logical_items")
      .select(
        "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count,catalog_category,reading_source_occurrences(occurrence_id,occurrence_date)"
      )
      .eq("module", taskType)
      .range(from, to)
  );
  if (result.error) {
    throw new Error(`Failed to load ${taskType} reading catalog: ${result.error.message}`);
  }
  return buildReadingCatalogPublicPayload({
    taskType,
    items: result.data ?? []
  });
}

/** Independent search index read: the only catalog path allowed to touch search text. */
export async function loadPublicReadingCatalogSearchIndex(
  taskType: ReadingModule
): Promise<ReadingCatalogSearchIndexPayload> {
  const db = createServiceSupabase();
  const readSearchText = (from: number, to: number) =>
    db
      .from("reading_logical_items")
      .select("logical_item_id,catalog_search_text")
      .eq("module", taskType)
      .range(from, to);
  let result = await readAllSupabaseRows<{ logical_item_id: string; catalog_search_text?: string | null }>(readSearchText);
  if (result.error?.message.includes("catalog_search_text") && result.error.message.includes("does not exist")) {
    // The search-text backfill migration may not be applied yet; the index
    // stays empty instead of failing the search.
    result = await readAllSupabaseRows<{ logical_item_id: string }>((from, to) =>
      db
        .from("reading_logical_items")
        .select("logical_item_id")
        .eq("module", taskType)
        .range(from, to)
    );
  }
  if (result.error) {
    throw new Error(`Failed to load ${taskType} reading search index: ${result.error.message}`);
  }
  return {
    taskType,
    items: (result.data ?? []).map((row) => ({
      logical_item_id: row.logical_item_id,
      catalog_search_text: "catalog_search_text" in row ? row.catalog_search_text ?? "" : ""
    }))
  };
}
