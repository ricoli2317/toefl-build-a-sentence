import {
  readingCatalogTitleParts,
  type ReadingCatalogItem
} from "./catalog.ts";

export type ReadingLengthFilter = "all" | "short" | "long";

/**
 * Discovery must never write the dynamic `题目XXX` number into the canonical
 * title. The number is rendered separately from readingCatalogTitleParts() and
 * only widens search through searchText so that queries like `题目109` keep
 * matching without polluting the title pipeline.
 */
export function readingCatalogDiscoverySearchText(
  item: Pick<ReadingCatalogItem, "taskType" | "displayNumber" | "title">,
  searchText: string
) {
  const { prefix } = readingCatalogTitleParts(item);
  const trimmedSearchText = searchText.trim();
  return trimmedSearchText ? `${prefix} ${trimmedSearchText}` : prefix;
}

export function filterReadingCatalogByLength<T extends { questionCount: number }>(
  items: T[],
  length: ReadingLengthFilter
) {
  if (length === "short") return items.filter((item) => item.questionCount === 2);
  if (length === "long") return items.filter((item) => item.questionCount === 3);
  return items;
}
