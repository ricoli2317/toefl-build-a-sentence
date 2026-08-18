export type NumberedPracticeItem = {
  itemId?: string;
  displayNumber: string;
  firstSeenDate: string;
};

export type UnnumberedPracticeItem = {
  firstSeenDate: string;
  stableKey: string;
};

export type ParsedDisplayNumber = {
  base: number;
  suffix: string;
  suffixRank: number;
};

export type NumberReconciliationChange = {
  itemId: string;
  oldDisplayNumber: string;
  newDisplayNumber: string;
  reason: "earlier_duplicate_occurrence" | "historical_new_item_insert" | "local_resequence";
};

export function parseDisplayNumber(displayNumber: string): ParsedDisplayNumber {
  const match = displayNumber.match(/^([0-9]{3,})([A-Z]*)$/);
  if (!match) throw new Error(`Invalid display_number: ${displayNumber}`);
  return {
    base: Number(match[1]),
    suffix: match[2],
    suffixRank: suffixRank(match[2])
  };
}

export function suffixRank(suffix: string) {
  let rank = 0;
  for (const character of suffix) {
    if (character < "A" || character > "Z") throw new Error(`Invalid suffix: ${suffix}`);
    rank = rank * 26 + character.charCodeAt(0) - 64;
  }
  return rank;
}

export function compareDisplayNumbers(left: string, right: string) {
  const a = parseDisplayNumber(left);
  const b = parseDisplayNumber(right);
  return a.base - b.base || a.suffixRank - b.suffixRank;
}

export function excelSuffix(index: number) {
  if (!Number.isInteger(index) || index < 1) throw new Error("suffix index must be positive");
  let value = index;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

export function allocateDisplayNumbers(
  existing: NumberedPracticeItem[],
  incoming: UnnumberedPracticeItem[],
  retiredNumbers: Iterable<string> = []
) {
  const state = [...existing];
  const retired = new Set(retiredNumbers);
  const ordered = [...incoming].sort(
    (left, right) =>
      compareText(left.firstSeenDate, right.firstSeenDate) || compareText(left.stableKey, right.stableKey)
  );
  const allocations = new Map<string, string>();

  for (const item of ordered) {
    const displayNumber = allocateOne(state, item.firstSeenDate, retired);
    state.push({ displayNumber, firstSeenDate: item.firstSeenDate });
    allocations.set(item.stableKey, displayNumber);
  }
  return allocations;
}

export function reconcileDisplayNumbers(
  items: Array<Required<NumberedPracticeItem>>,
  affected: Map<
    string,
    "earlier_duplicate_occurrence" | "historical_new_item_insert"
  >,
  retiredNumbers: Iterable<string> = []
) {
  const currentByNumber = new Set(items.map(({ displayNumber }) => displayNumber));
  const blocked = new Set(
    Array.from(retiredNumbers).filter((displayNumber) => !currentByNumber.has(displayNumber))
  );
  const ordered = [...items].sort(compareChronology);
  const moving = ordered.filter((item) => {
    if (!affected.has(item.itemId)) return false;
    return (
      ordered.some(
        (candidate) =>
          candidate.firstSeenDate < item.firstSeenDate &&
          compareDisplayNumbers(candidate.displayNumber, item.displayNumber) >= 0
      ) ||
      ordered.some(
        (candidate) =>
          candidate.firstSeenDate > item.firstSeenDate &&
          compareDisplayNumbers(candidate.displayNumber, item.displayNumber) <= 0
      )
    );
  });
  if (moving.length === 0) return [];

  const movingIds = new Set(moving.map(({ itemId }) => itemId));
  const targetBaseByItem = new Map<string, number>();
  for (const item of moving) {
    const anchor = ordered
      .filter(
        (candidate) =>
          !movingIds.has(candidate.itemId) &&
          parseDisplayNumber(candidate.displayNumber).suffixRank === 0 &&
          compareChronology(candidate, item) < 0
      )
      .at(-1);
    targetBaseByItem.set(item.itemId, anchor ? parseDisplayNumber(anchor.displayNumber).base : 0);
  }

  const plans = new Map<string, string>();
  const targetBases = Array.from(new Set(targetBaseByItem.values())).sort((a, b) => a - b);
  for (const base of targetBases) {
    const members = [
      ...items.filter((item) => {
        const parsed = parseDisplayNumber(item.displayNumber);
        return parsed.base === base && parsed.suffixRank > 0 && !movingIds.has(item.itemId);
      }),
      ...moving.filter((item) => targetBaseByItem.get(item.itemId) === base)
    ].sort(compareChronology);
    let previousRank = 0;
    for (const item of members) {
      const current = parseDisplayNumber(item.displayNumber);
      let rank = movingIds.has(item.itemId)
        ? previousRank + 1
        : Math.max(previousRank + 1, current.suffixRank);
      let candidate = formatDisplayNumber(base, rank);
      while (blocked.has(candidate)) {
        rank += 1;
        candidate = formatDisplayNumber(base, rank);
      }
      plans.set(item.itemId, candidate);
      previousRank = rank;
    }
  }

  return items.flatMap((item): NumberReconciliationChange[] => {
    const next = plans.get(item.itemId);
    if (!next || next === item.displayNumber) return [];
    return [
      {
        itemId: item.itemId,
        oldDisplayNumber: item.displayNumber,
        newDisplayNumber: next,
        reason: affected.get(item.itemId) ?? "local_resequence"
      }
    ];
  });
}

function allocateOne(
  existing: NumberedPracticeItem[],
  date: string,
  retiredNumbers: Set<string>
) {
  if (existing.length === 0) {
    let base = 1;
    let candidate = formatDisplayNumber(base, 0);
    while (retiredNumbers.has(candidate)) {
      base += 1;
      candidate = formatDisplayNumber(base, 0);
    }
    return candidate;
  }
  const latestDate = existing.reduce(
    (latest, item) => (item.firstSeenDate > latest ? item.firstSeenDate : latest),
    existing[0].firstSeenDate
  );
  const baseValues = existing.map((item) => parseDisplayNumber(item.displayNumber).base);
  const occupied = new Set(existing.map((item) => item.displayNumber));

  if (date >= latestDate) {
    let base = Math.max(0, ...baseValues) + 1;
    let candidate = formatDisplayNumber(base, 0);
    while (occupied.has(candidate) || retiredNumbers.has(candidate)) {
      base += 1;
      candidate = formatDisplayNumber(base, 0);
    }
    return candidate;
  }

  const anchor = Math.max(
    0,
    ...existing
      .filter(
        (item) =>
          item.firstSeenDate <= date && parseDisplayNumber(item.displayNumber).suffixRank === 0
      )
      .map((item) => parseDisplayNumber(item.displayNumber).base)
  );
  for (let index = 1; ; index += 1) {
    const candidate = formatDisplayNumber(anchor, index);
    if (!occupied.has(candidate) && !retiredNumbers.has(candidate)) return candidate;
  }
}

function formatDisplayNumber(base: number, rank: number) {
  return `${String(base).padStart(3, "0")}${rank > 0 ? excelSuffix(rank) : ""}`;
}

function compareChronology(
  left: Required<NumberedPracticeItem>,
  right: Required<NumberedPracticeItem>
) {
  return (
    compareText(left.firstSeenDate, right.firstSeenDate) ||
    compareDisplayNumbers(left.displayNumber, right.displayNumber) ||
    compareText(left.itemId, right.itemId)
  );
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
