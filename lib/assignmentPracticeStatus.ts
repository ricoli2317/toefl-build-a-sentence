import {
  assignmentCatalogEntryKey,
  type AssignmentCatalogEntry,
  type AssignmentItemType,
  type AssignmentSubject
} from "./assignmentCatalog.ts";
import type { StudentPracticeItemStateRow } from "./studentPracticeItemState.ts";

/**
 * Teacher Assignment catalog practice badges (client + server safe).
 *
 * The badge answers exactly one question: has ANY selected student / class
 * member already completed this item? It is not a progress statistic. There is
 * no count, percentage, attempt count or hover detail.
 *
 * `已练习` covers every valid completed practice record (self practice,
 * teacher-assigned work, Full Set, wrongbook corrections, repeated history).
 * A missing completed record — including a draft or unfinished attempt — never
 * produces a badge. Because the query state is explicit, a failed load is
 * reported separately and is never shown as `未练习`.
 */
export type AssignmentPracticeBadge = "practiced" | "partial";

export type AssignmentPracticeStatusEntry = {
  item_id: string;
  item_type: AssignmentItemType;
  status: AssignmentPracticeBadge;
};

export type AssignmentPracticeStatusRecord = Readonly<
  Record<string, AssignmentPracticeBadge>
>;

export type AssignmentPracticeStatusPayload = {
  subject: AssignmentSubject;
  statuses: AssignmentPracticeStatusEntry[];
};

export function assignmentPracticeStatusKey(
  itemType: AssignmentItemType,
  itemId: string
) {
  return assignmentCatalogEntryKey({ item_id: itemId, item_type: itemType });
}

export function assignmentPracticeStatusRecord(
  entries: ReadonlyArray<AssignmentPracticeStatusEntry>
): AssignmentPracticeStatusRecord {
  return Object.fromEntries(
    entries.map((entry) => [
      assignmentPracticeStatusKey(entry.item_type, entry.item_id),
      entry.status
    ])
  );
}

export function assignmentPracticeBadgeForEntry(
  entry: Pick<AssignmentCatalogEntry, "item_id" | "item_type">,
  statuses: AssignmentPracticeStatusRecord
): AssignmentPracticeBadge | null {
  return statuses[assignmentCatalogEntryKey(entry)] ?? null;
}

/**
 * One sparse practice state row counts as completed whenever a completed
 * attempt exists, even if the student later restarted and the current status
 * is `in_progress`. Draft-only rows (no completed attempt) never count.
 */
export function assignmentPracticeItemIsCompleted(
  row: Pick<StudentPracticeItemStateRow, "latest_completed_attempt_id" | "last_completed_at">
) {
  return Boolean(row.latest_completed_attempt_id || row.last_completed_at);
}

/**
 * Full Set badge from its real constituent logical reading items.
 *
 * - Any selected student completed the whole Full Set -> 已练习.
 * - Otherwise the union of every selected student's fully completed items is
 *   compared with the Full Set's own item list: none -> no badge, some ->
 *   部分练习, all -> 已练习.
 * - `completedItemIds` must contain only FULLY completed logical items. A
 *   category / wrongbook answer to one question of a multi-question reading
 *   material is not a completed item and therefore never completes the set.
 */
export function assignmentPracticeFullSetBadge(input: {
  completedFullSetIds: ReadonlySet<string>;
  completedItemIds: ReadonlySet<string>;
  constituentItemIds: readonly string[];
  fullSetId: string;
}): AssignmentPracticeBadge | null {
  if (input.completedFullSetIds.has(input.fullSetId)) return "practiced";
  const constituents = new Set(input.constituentItemIds.filter(Boolean));
  if (constituents.size === 0) return null;
  let covered = 0;
  for (const itemId of Array.from(constituents)) {
    if (input.completedItemIds.has(itemId)) covered += 1;
  }
  if (covered === 0) return null;
  return covered === constituents.size ? "practiced" : "partial";
}
