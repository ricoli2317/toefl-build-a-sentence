export type CatalogSortKey = "default" | "occurrence_count" | "first_seen_date" | "latest_seen_date";
export type CatalogSortDirection = "asc" | "desc";
export type CatalogStatusFilter = "all" | "unstarted" | "in_progress" | "completed";

export type CatalogDiscoveryItem = {
  id: string;
  title: string;
  searchText: string;
  status: Exclude<CatalogStatusFilter, "all">;
  occurrenceDates: string[];
  occurrenceCount: number;
  firstSeenDate: string;
  latestSeenDate: string;
  category: string | null;
  defaultIndex: number;
};

export type CatalogDiscoveryFilters = {
  query: string;
  status: CatalogStatusFilter;
  months: string[];
  categories: string[];
  sortKey: CatalogSortKey;
  sortDirection: CatalogSortDirection;
};

export function normalizeCatalogSearchText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, " ")
    .trim();
}

export function catalogSearchMatches(content: string, query: string) {
  const normalizedQuery = normalizeCatalogSearchText(query);
  if (!normalizedQuery) return true;
  const normalizedContent = normalizeCatalogSearchText(content);
  if (normalizedContent.includes(normalizedQuery)) return true;

  const contentTokens = tokens(normalizedContent);
  const queryTokens = tokens(normalizedQuery);
  if (queryTokens.length === 0) return false;
  return queryTokens.every((queryToken) =>
    contentTokens.some((contentToken) => fuzzyTokenMatches(contentToken, queryToken))
  );
}

export function filterAndSortCatalogItems<T extends CatalogDiscoveryItem>(
  items: T[],
  filters: CatalogDiscoveryFilters
) {
  const selectedMonths = new Set(filters.months);
  const selectedCategories = new Set(filters.categories);
  const filtered = items.filter((item) => {
    if (!catalogSearchMatches(`${item.title} ${item.searchText}`, filters.query)) return false;
    if (filters.status !== "all" && item.status !== filters.status) return false;
    if (
      selectedMonths.size > 0
      && !item.occurrenceDates.some((date) => selectedMonths.has(date.slice(0, 7)))
    ) return false;
    if (selectedCategories.size > 0 && (!item.category || !selectedCategories.has(item.category))) return false;
    return true;
  });

  if (filters.sortKey === "default") {
    return filtered.sort((left, right) => left.defaultIndex - right.defaultIndex);
  }

  const direction = filters.sortDirection === "asc" ? 1 : -1;
  return filtered.sort((left, right) => {
    const comparison = filters.sortKey === "occurrence_count"
      ? left.occurrenceCount - right.occurrenceCount
      : filters.sortKey === "first_seen_date"
        ? left.firstSeenDate.localeCompare(right.firstSeenDate)
        : left.latestSeenDate.localeCompare(right.latestSeenDate);
    return comparison * direction || left.id.localeCompare(right.id);
  });
}

export function catalogMonths(items: Pick<CatalogDiscoveryItem, "occurrenceDates">[]) {
  return Array.from(new Set(items.flatMap((item) =>
    item.occurrenceDates.map((date) => date.slice(0, 7))
  ))).sort((left, right) => right.localeCompare(left));
}

function tokens(value: string) {
  return value.match(/[a-z0-9]+/g) ?? [];
}

function fuzzyTokenMatches(contentToken: string, queryToken: string) {
  if (contentToken === queryToken) return true;
  if (queryToken.length <= 3 || contentToken.length <= 3) return false;
  const threshold = queryToken.length <= 5 ? 0.7 : 0.62;
  return trigramDice(contentToken, queryToken) >= threshold;
}

function trigramDice(left: string, right: string) {
  const leftTrigrams = trigrams(left);
  const rightTrigrams = trigrams(right);
  let overlap = 0;
  const remaining = new Map<string, number>();
  for (const trigram of leftTrigrams) remaining.set(trigram, (remaining.get(trigram) ?? 0) + 1);
  for (const trigram of rightTrigrams) {
    const count = remaining.get(trigram) ?? 0;
    if (count > 0) {
      overlap += 1;
      remaining.set(trigram, count - 1);
    }
  }
  return (2 * overlap) / (leftTrigrams.length + rightTrigrams.length);
}

function trigrams(value: string) {
  const padded = `  ${value}  `;
  return Array.from({ length: Math.max(1, padded.length - 2) }, (_, index) =>
    padded.slice(index, index + 3)
  );
}
