export type OccurrenceDateCount = {
  date: string;
  count: number;
};

export function countOccurrenceDates(dates: string[]): OccurrenceDateCount[] {
  const counts = new Map<string, number>();
  for (const date of dates) counts.set(date, (counts.get(date) ?? 0) + 1);
  return Array.from(counts, ([date, count]) => ({ date, count }))
    .sort((left, right) => right.date.localeCompare(left.date));
}

export function formatOccurrenceDates(dates?: string[] | OccurrenceDateCount[]) {
  return (dates ?? []).map((entry) => {
    const date = typeof entry === "string" ? entry : entry.date;
    const count = typeof entry === "string" ? 1 : entry.count;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const formatted = match ? `${match[1].slice(-2)}${match[2]}${match[3]}` : date;
    return count > 1 ? `${formatted}(${count})` : formatted;
  }).join("、");
}
