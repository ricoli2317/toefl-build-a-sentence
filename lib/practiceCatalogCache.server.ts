import { revalidateTag, unstable_cache } from "next/cache";
import {
  loadPublicLogicalPracticeCatalog,
  type PublicLogicalPracticeCatalogData
} from "@/lib/practiceLogicalCatalog";
import type { PracticeTaskType } from "@/lib/practiceImporter/types";
import { createServiceSupabase } from "@/lib/supabase/server";

const CACHE_VERSION = 1;

export function practiceCatalogCacheTag(taskType: PracticeTaskType) {
  return `practice-catalog:${taskType}:v${CACHE_VERSION}`;
}

function createCatalogLoader(taskType: PracticeTaskType) {
  return unstable_cache(
    async (): Promise<PublicLogicalPracticeCatalogData> =>
      loadPublicLogicalPracticeCatalog({
        supabase: createServiceSupabase(),
        taskType
      }),
    ["public-logical-practice-catalog", String(CACHE_VERSION), taskType],
    {
      revalidate: 60 * 60,
      tags: [practiceCatalogCacheTag(taskType)]
    }
  );
}

const catalogLoaders: Record<PracticeTaskType, () => Promise<PublicLogicalPracticeCatalogData>> = {
  build_sentence: createCatalogLoader("build_sentence"),
  email: createCatalogLoader("email"),
  academic_discussion: createCatalogLoader("academic_discussion")
};

export function loadCachedPublicPracticeCatalog(taskType: PracticeTaskType) {
  return catalogLoaders[taskType]();
}

export function revalidatePracticeCatalog(taskType: PracticeTaskType) {
  revalidateTag(practiceCatalogCacheTag(taskType));
}
