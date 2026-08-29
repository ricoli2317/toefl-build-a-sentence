import type { ReadingModule } from "./types.ts";
import { READING_PRODUCT_NAMES } from "./product.ts";
import { assertCanonicalRdlTitle } from "./rdlTitles.ts";

export type ReadingCatalogItemRow = {
  logical_item_id: string;
  module: ReadingModule;
  title: string | null;
  first_seen_date: string;
  first_seen_source_label: string;
  first_seen_source_order: number;
  question_count: number;
  scored_item_count: number;
  reading_source_occurrences?: Array<{ occurrence_date: string }>;
};

export type ReadingCatalogIdentityRow = Pick<
  ReadingCatalogItemRow,
  "logical_item_id" | "first_seen_date" | "first_seen_source_label" | "first_seen_source_order"
>;

export type ReadingCatalogAttemptRow = {
  attempt_id: string;
  logical_item_id: string;
  task_type: ReadingModule;
  status: "draft" | "submitted";
  elapsed_seconds: number;
  correct_points: number;
  total_points: number;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ReadingCatalogStatus = "unstarted" | "in_progress" | "completed";

export type ReadingCatalogItem = {
  itemId: string;
  taskType: ReadingModule;
  displayNumber: string;
  title: string;
  firstSeenDate: string;
  occurrenceDates: string[];
  questionCount: number;
  scoringPointCount: number;
  status: ReadingCatalogStatus;
  draftAttemptId: string | null;
  latestSubmittedAttempt: null | {
    attemptId: string;
    correctPoints: number;
    totalPoints: number;
    accuracy: number;
    elapsedSeconds: number;
    submittedAt: string;
  };
};

export type ReadingCatalogPayload = {
  taskType: ReadingModule;
  taskName: string;
  items: ReadingCatalogItem[];
};

const naturalSourceLabel = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base"
});

export function compareReadingCatalogIdentityOrder(
  left: ReadingCatalogIdentityRow,
  right: ReadingCatalogIdentityRow
) {
  return left.first_seen_date.localeCompare(right.first_seen_date)
    || naturalSourceLabel.compare(left.first_seen_source_label, right.first_seen_source_label)
    || left.first_seen_source_order - right.first_seen_source_order
    || left.logical_item_id.localeCompare(right.logical_item_id);
}

export function readingCatalogDisplayNumber(
  items: ReadingCatalogIdentityRow[],
  itemId: string
) {
  const index = [...items]
    .sort(compareReadingCatalogIdentityOrder)
    .findIndex((item) => item.logical_item_id === itemId);
  return index < 0 ? null : String(index + 1).padStart(3, "0");
}

export function buildReadingCatalogPayload(input: {
  taskType: ReadingModule;
  items: ReadingCatalogItemRow[];
  attempts: ReadingCatalogAttemptRow[];
}): ReadingCatalogPayload {
  const rankedItems = input.items
    .filter((item) => item.module === input.taskType)
    .sort(compareReadingCatalogIdentityOrder);
  const rankByItemId = new Map(
    rankedItems.map((item, index) => [item.logical_item_id, String(index + 1).padStart(3, "0")])
  );
  const attemptsByItemId = new Map<string, ReadingCatalogAttemptRow[]>();
  for (const attempt of input.attempts) {
    if (attempt.task_type !== input.taskType) continue;
    const attempts = attemptsByItemId.get(attempt.logical_item_id) ?? [];
    attempts.push(attempt);
    attemptsByItemId.set(attempt.logical_item_id, attempts);
  }

  return {
    taskType: input.taskType,
    taskName: READING_PRODUCT_NAMES[input.taskType],
    // The display rank is historical, while the directory itself is latest-first.
    items: [...rankedItems].reverse().map((item) => {
      const attempts = attemptsByItemId.get(item.logical_item_id) ?? [];
      const draft = latestAttempt(attempts.filter((attempt) => attempt.status === "draft"));
      const submitted = latestAttempt(
        attempts.filter((attempt): attempt is ReadingCatalogAttemptRow & { submitted_at: string } =>
          attempt.status === "submitted" && Boolean(attempt.submitted_at)
        )
      );
      const totalPoints = submitted ? Math.max(0, submitted.total_points) : 0;
      const title = item.module === "rdl"
        ? assertCanonicalRdlTitle(item.title ?? "", `RDL catalog title for ${item.logical_item_id}`)
        : item.title?.trim() || READING_PRODUCT_NAMES[item.module];
      return {
        itemId: item.logical_item_id,
        taskType: item.module,
        displayNumber: rankByItemId.get(item.logical_item_id)!,
        title,
        firstSeenDate: item.first_seen_date,
        occurrenceDates: readingOccurrenceDates(item),
        questionCount: item.question_count,
        scoringPointCount: item.scored_item_count,
        status: draft ? "in_progress" : submitted ? "completed" : "unstarted",
        draftAttemptId: draft?.attempt_id ?? null,
        latestSubmittedAttempt: submitted
          ? {
              attemptId: submitted.attempt_id,
              correctPoints: submitted.correct_points,
              totalPoints,
              accuracy: totalPoints > 0 ? submitted.correct_points / totalPoints : 0,
              elapsedSeconds: submitted.elapsed_seconds,
              submittedAt: submitted.submitted_at
            }
          : null
      };
    })
  };
}

function readingOccurrenceDates(item: ReadingCatalogItemRow) {
  const dates = item.reading_source_occurrences?.map((occurrence) => occurrence.occurrence_date)
    ?? [item.first_seen_date];
  return Array.from(new Set(dates)).sort((left, right) => right.localeCompare(left));
}

function latestAttempt<T extends ReadingCatalogAttemptRow>(attempts: T[]): T | null {
  return [...attempts].sort((left, right) =>
    attemptTimestamp(right).localeCompare(attemptTimestamp(left))
    || right.attempt_id.localeCompare(left.attempt_id)
  )[0] ?? null;
}

function attemptTimestamp(attempt: ReadingCatalogAttemptRow) {
  return attempt.submitted_at ?? attempt.updated_at ?? attempt.created_at;
}

export function isReadingModule(value: unknown): value is ReadingModule {
  return value === "ctw" || value === "rdl" || value === "rap";
}
