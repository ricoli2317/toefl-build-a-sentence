import type { ReadingModule } from "./types.ts";
import { READING_PRODUCT_NAMES } from "./product.ts";
import { assertCanonicalRdlTitle } from "./rdlTitles.ts";
import { assertCanonicalCtwTitle } from "./ctwTitles.ts";
import { countOccurrenceDates, type OccurrenceDateCount } from "../catalogOccurrenceDates.ts";
import type { StudentPracticeItemStateRow } from "../studentPracticeItemState.ts";

export type ReadingCatalogItemRow = {
  logical_item_id: string;
  module: ReadingModule;
  title: string | null;
  first_seen_date: string;
  first_seen_source_label: string;
  first_seen_source_order: number;
  question_count: number;
  scored_item_count: number;
  catalog_category?: string | null;
  catalog_search_text?: string | null;
  reading_source_occurrences?: Array<{ occurrence_id?: string; occurrence_date: string }>;
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
  latestSeenDate: string;
  occurrenceDates: string[];
  occurrenceDateCounts: OccurrenceDateCount[];
  occurrenceCount: number;
  category: string;
  searchText: string;
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

/**
 * The cached public payload: directory fields plus occurrence dates only. It
 * never carries attempt state or `catalog_search_text`; both are merged from
 * separate cached/sparse sources.
 */
export type ReadingCatalogPublicItem = Omit<
  ReadingCatalogItem,
  "status" | "draftAttemptId" | "latestSubmittedAttempt"
>;

export type ReadingCatalogPublicPayload = {
  taskType: ReadingModule;
  taskName: string;
  items: ReadingCatalogPublicItem[];
};

export type ReadingCatalogPayload = {
  taskType: ReadingModule;
  taskName: string;
  items: ReadingCatalogItem[];
};

export function readingCatalogTitleParts(
  item: Pick<ReadingCatalogItem, "taskType" | "displayNumber" | "title">
) {
  return {
    prefix: `题目${item.displayNumber}`,
    suffix: item.title
  };
}

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
  return readingCatalogDisplayNumbers(items).get(itemId) ?? null;
}

export function readingCatalogDisplayNumbers(items: ReadingCatalogIdentityRow[]) {
  return new Map(
    [...items]
      .sort(compareReadingCatalogIdentityOrder)
      .map((item, index) => [item.logical_item_id, String(index + 1).padStart(3, "0")])
  );
}

export function buildReadingCatalogPublicPayload(input: {
  taskType: ReadingModule;
  items: ReadingCatalogItemRow[];
}): ReadingCatalogPublicPayload {
  const rankedItems = input.items
    .filter((item) => item.module === input.taskType)
    .sort(compareReadingCatalogIdentityOrder);
  const rankByItemId = new Map(
    rankedItems.map((item, index) => [item.logical_item_id, String(index + 1).padStart(3, "0")])
  );

  return {
    taskType: input.taskType,
    taskName: READING_PRODUCT_NAMES[input.taskType],
    // The display rank is historical, while the directory itself is latest-first.
    items: [...rankedItems].reverse().map((item) => {
      const occurrenceDateCounts = countOccurrenceDates(
        item.reading_source_occurrences?.map((occurrence) => occurrence.occurrence_date)
          ?? [item.first_seen_date]
      );
      const occurrenceDates = occurrenceDateCounts.map(({ date }) => date);
      const title = item.module === "ctw"
        ? assertCanonicalCtwTitle(item.title ?? "", `CTW catalog title for ${item.logical_item_id}`)
        : item.module === "rdl"
          ? assertCanonicalRdlTitle(item.title ?? "", `RDL catalog title for ${item.logical_item_id}`)
          : item.title?.trim() || READING_PRODUCT_NAMES[item.module];
      return {
        itemId: item.logical_item_id,
        taskType: item.module,
        displayNumber: rankByItemId.get(item.logical_item_id)!,
        title,
        firstSeenDate: item.first_seen_date,
        latestSeenDate: occurrenceDates[0] ?? item.first_seen_date,
        occurrenceDates,
        occurrenceDateCounts,
        occurrenceCount: item.reading_source_occurrences?.length ?? 0,
        category: item.catalog_category?.trim() ?? "",
        // Content search text is served by the separate search index route.
        searchText: "",
        questionCount: item.question_count,
        scoringPointCount: item.scored_item_count
      };
    })
  };
}

export function attachReadingCatalogStudentStates(
  publicPayload: ReadingCatalogPublicPayload,
  states: StudentPracticeItemStateRow[]
): ReadingCatalogPayload {
  const stateByItemId = new Map<string, StudentPracticeItemStateRow>();
  for (const state of states) {
    if (state.task_type !== "ctw" && state.task_type !== "rdl" && state.task_type !== "rap") {
      continue;
    }
    stateByItemId.set(state.item_id, state);
  }

  return {
    ...publicPayload,
    items: publicPayload.items.map((item) => {
      const state = stateByItemId.get(item.itemId) ?? null;
      const status: ReadingCatalogStatus = state?.status === "in_progress" || state?.status === "completed"
        ? state.status
        : "unstarted";
      const draftAttemptId = status === "in_progress" ? state?.resume_attempt_id ?? null : null;
      const completedAttemptId = status === "unstarted"
        ? null
        : state?.latest_completed_attempt_id ?? null;
      const result = state?.latest_result ?? null;
      const totalPoints = completedAttemptId ? Math.max(0, Number(result?.totalPoints ?? 0)) : 0;
      const correctPoints = completedAttemptId ? Math.max(0, Number(result?.correctPoints ?? 0)) : 0;
      return {
        ...item,
        status,
        draftAttemptId,
        latestSubmittedAttempt: completedAttemptId
          ? {
              attemptId: completedAttemptId,
              correctPoints,
              totalPoints,
              accuracy: totalPoints > 0 ? correctPoints / totalPoints : 0,
              elapsedSeconds: Math.max(0, Number(result?.elapsedSeconds ?? 0)),
              submittedAt: state?.last_completed_at ?? ""
            }
          : null
      };
    })
  };
}

/**
 * Legacy builder used by the transitional fallback while the sparse state
 * migration is rolling out. It rebuilds the same payload from attempt rows.
 */
export function buildReadingCatalogPayload(input: {
  taskType: ReadingModule;
  items: ReadingCatalogItemRow[];
  attempts: ReadingCatalogAttemptRow[];
}): ReadingCatalogPayload {
  const publicPayload = buildReadingCatalogPublicPayload(input);
  const attemptsByItemId = new Map<string, ReadingCatalogAttemptRow[]>();
  for (const attempt of input.attempts) {
    if (attempt.task_type !== input.taskType) continue;
    const attempts = attemptsByItemId.get(attempt.logical_item_id) ?? [];
    attempts.push(attempt);
    attemptsByItemId.set(attempt.logical_item_id, attempts);
  }

  return {
    ...publicPayload,
    items: publicPayload.items.map((item) => {
      const attempts = attemptsByItemId.get(item.itemId) ?? [];
      const draft = latestAttempt(attempts.filter((attempt) => attempt.status === "draft"));
      const submitted = latestAttempt(
        attempts.filter((attempt): attempt is ReadingCatalogAttemptRow & { submitted_at: string } =>
          attempt.status === "submitted" && Boolean(attempt.submitted_at)
        )
      );
      const totalPoints = submitted ? Math.max(0, submitted.total_points) : 0;
      return {
        ...item,
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
