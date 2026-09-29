import { revalidateTag, unstable_cache } from "next/cache";
import { catalogCacheTag, loadCatalogRevision } from "@/lib/catalogRevision.server";
import { logCatalogCacheRebuild } from "@/lib/catalogCacheDiagnostics.server";
import {
  loadPublicLogicalPracticeCatalog,
  type PublicLogicalPracticeCatalogData
} from "@/lib/practiceLogicalCatalog";
import {
  loadPublicLogicalPracticeCatalogSearchIndex,
  type LogicalPracticeCatalogSearchIndex
} from "@/lib/practiceCatalogSearchIndex.server";
import type { PracticeTaskType } from "@/lib/practiceImporter/types";
import { createServiceSupabase } from "@/lib/supabase/server";

export const PRACTICE_CATALOG_CACHE_VERSION = 4;

export function practiceCatalogCacheTag(taskType: PracticeTaskType) {
  return catalogCacheTag({
    prefix: "practice-catalog",
    taskType,
    version: PRACTICE_CATALOG_CACHE_VERSION
  });
}

export function practiceCatalogSearchIndexCacheTag(taskType: PracticeTaskType) {
  return catalogCacheTag({
    prefix: "practice-catalog-search-index",
    taskType,
    version: PRACTICE_CATALOG_CACHE_VERSION
  });
}

/**
 * The revision argument is part of the cache key only: database triggers bump
 * the `lightweight_catalog` revision for this task type, so a direct SQL write
 * produces a new key on the next read without a Next.js `revalidateTag`.
 */
function createCatalogLoader(taskType: PracticeTaskType) {
  return unstable_cache(
    async (revision: number): Promise<PublicLogicalPracticeCatalogData> => {
      void revision;
      // Diagnostics only: this callback runs on an actual rebuild, never on a
      // cache hit, so the log stays silent for cached responses.
      logCatalogCacheRebuild({
        cacheKind: "practice_catalog",
        taskType,
        revision
      });
      return loadPublicLogicalPracticeCatalog({
        supabase: createServiceSupabase(),
        taskType
      });
    },
    ["public-logical-practice-catalog", String(PRACTICE_CATALOG_CACHE_VERSION), taskType],
    {
      revalidate: 60 * 60,
      tags: [practiceCatalogCacheTag(taskType)]
    }
  );
}

function createSearchIndexLoader(taskType: PracticeTaskType) {
  return unstable_cache(
    async (revision: number): Promise<LogicalPracticeCatalogSearchIndex> => {
      void revision;
      // Diagnostics only: fires on an actual search-index rebuild.
      logCatalogCacheRebuild({
        cacheKind: "practice_search_index",
        taskType,
        revision
      });
      return loadPublicLogicalPracticeCatalogSearchIndex({
        supabase: createServiceSupabase(),
        taskType
      });
    },
    ["public-logical-practice-search-index", String(PRACTICE_CATALOG_CACHE_VERSION), taskType],
    {
      revalidate: 60 * 60,
      tags: [practiceCatalogSearchIndexCacheTag(taskType)]
    }
  );
}

const catalogLoaders: Record<PracticeTaskType, (revision: number) => Promise<PublicLogicalPracticeCatalogData>> = {
  build_sentence: createCatalogLoader("build_sentence"),
  email: createCatalogLoader("email"),
  academic_discussion: createCatalogLoader("academic_discussion")
};

const searchIndexLoaders: Record<PracticeTaskType, (revision: number) => Promise<LogicalPracticeCatalogSearchIndex>> = {
  build_sentence: createSearchIndexLoader("build_sentence"),
  email: createSearchIndexLoader("email"),
  academic_discussion: createSearchIndexLoader("academic_discussion")
};

export async function loadCachedPublicPracticeCatalog(taskType: PracticeTaskType) {
  const revision = await loadCatalogRevision({
    taskType,
    cacheKind: "lightweight_catalog"
  });
  return catalogLoaders[taskType](revision);
}

export async function loadCachedPublicPracticeCatalogSearchIndex(taskType: PracticeTaskType) {
  const revision = await loadCatalogRevision({
    taskType,
    cacheKind: "search_index"
  });
  return searchIndexLoaders[taskType](revision);
}

export function revalidatePracticeCatalog(taskType: PracticeTaskType) {
  revalidateTag(practiceCatalogCacheTag(taskType));
  revalidateTag(practiceCatalogSearchIndexCacheTag(taskType));
}
