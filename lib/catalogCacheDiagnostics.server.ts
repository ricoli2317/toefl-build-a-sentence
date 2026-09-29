/**
 * Catalog cache rebuild diagnostics.
 *
 * `logCatalogCacheRebuild` is only called from inside the `unstable_cache`
 * callbacks in `practiceCatalogCache.server.ts` and
 * `reading/catalogCache.server.ts`, so it fires exactly when Next.js actually
 * rebuilds an entry and stays silent on cache hits.
 *
 * The fields are instance-level (region + per-module instance id) so duplicate
 * or delayed rebuilds across server instances can be told apart. Nothing here
 * touches cache keys, tags, TTLs, or the database.
 */
export const catalogCacheInstanceId = crypto.randomUUID();

export type CatalogCacheKind =
  | "practice_catalog"
  | "practice_search_index"
  | "reading_catalog"
  | "reading_search_index"
  | "reading_full_set_catalog";

export type CatalogCacheRebuildLogInput = {
  cacheKind: CatalogCacheKind;
  taskType: string;
  revision: number;
};

export function logCatalogCacheRebuild(input: CatalogCacheRebuildLogInput) {
  console.info(
    "[catalog-cache]",
    JSON.stringify({
      cacheKind: input.cacheKind,
      event: "rebuild",
      instanceId: catalogCacheInstanceId,
      revision: input.revision,
      taskType: input.taskType,
      timestamp: new Date().toISOString(),
      vercelRegion: process.env.VERCEL_REGION ?? null
    })
  );
}
