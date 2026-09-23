export type ReadingLengthFilter = "all" | "short" | "long";

export function filterReadingCatalogByLength<T extends { questionCount: number }>(
  items: T[],
  length: ReadingLengthFilter
) {
  if (length === "short") return items.filter((item) => item.questionCount === 2);
  if (length === "long") return items.filter((item) => item.questionCount === 3);
  return items;
}
