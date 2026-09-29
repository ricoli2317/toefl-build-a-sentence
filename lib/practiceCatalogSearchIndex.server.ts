import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createPracticeCatalogDirectory,
  loadPracticeCatalogDirectoryData,
  loadPracticeCatalogSearchMetadata
} from "./practicePublicUniverse.ts";
import type { PracticeTaskType } from "./practiceImporter/types.ts";
import type { StudentPerformanceTrace } from "./studentPerformance.server.ts";

export type LogicalPracticeCatalogSearchIndexEntry = {
  item_id: string;
  search_text: string;
};

export type LogicalPracticeCatalogSearchIndex = {
  taskType: PracticeTaskType;
  items: LogicalPracticeCatalogSearchIndexEntry[];
};

/**
 * Search-index builder. It shares only the identity directory with the
 * lightweight catalog and is the only loader allowed to read the full question
 * text fields.
 */
export async function loadPublicLogicalPracticeCatalogSearchIndex(input: {
  supabase: SupabaseClient;
  taskType: PracticeTaskType;
  timing?: StudentPerformanceTrace;
}): Promise<LogicalPracticeCatalogSearchIndex> {
  const data = await loadPracticeCatalogDirectoryData(
    input.supabase,
    input.taskType,
    input.timing
  );
  const searchMetadata = await loadPracticeCatalogSearchMetadata(
    input.supabase,
    input.taskType,
    data.canonicalSources,
    input.timing
  );
  const buildIndex = () => {
    const directory = createPracticeCatalogDirectory(
      data.items,
      data.sources,
      searchMetadata
    );
    return {
      taskType: input.taskType,
      items: directory.publicItems.map((item) => ({
        item_id: item.itemId,
        search_text: item.catalogSearchText
      }))
    };
  };
  return input.timing
    ? input.timing.measureSync("processing", "build_logical_search_index", buildIndex)
    : buildIndex();
}
