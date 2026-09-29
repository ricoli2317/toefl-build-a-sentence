import type { SupabaseClient } from "@supabase/supabase-js";
import { compareDisplayNumbers } from "./practiceImporter/numbering.ts";
import type { PracticeTaskType } from "./practiceImporter/types.ts";
import {
  createPracticeCatalogDirectory,
  loadPracticeCatalogCategoryMetadata,
  loadPracticeCatalogDirectory,
  loadPracticeCatalogDirectoryData,
  loadPracticeCatalogOccurrences,
  loadPracticePublicUniverse,
  type FormalPracticeItemSource,
  type PracticeCatalogDirectory
} from "./practicePublicUniverse.ts";
import {
  attachLogicalPracticeStudentState,
  attachLogicalPracticeStudentStateFromRows,
  type BuildSentenceLogicalAttemptRow,
  type LogicalPracticeActions,
  type LogicalPracticeStudentState,
  type WritingLogicalAttemptRow
} from "./practiceLogicalState.ts";
import { loadStudentPracticeItemStates } from "./studentPracticeItemState.server.ts";
import type { StudentPracticeItemStateLoadResult } from "./studentPracticeItemState.server.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import type { StudentPerformanceTrace } from "./studentPerformance.server.ts";
import { countOccurrenceDates, type OccurrenceDateCount } from "./catalogOccurrenceDates.ts";

export const LOGICAL_PRACTICE_PAGE_SIZE = 10;

export type LogicalPracticeListItem = {
  item_id: string;
  task_type: PracticeTaskType;
  display_number: string;
  display_title: string | null;
  catalog_category: string | null;
  /**
   * Teacher-only searchable content. The student lightweight catalog never
   * builds this field; only the teacher question bank opts in.
   */
  search_text?: string;
  first_seen_date: string;
  latest_seen_date: string;
  occurrence_dates: string[];
  occurrence_date_counts: OccurrenceDateCount[];
  occurrence_count: number;
  canonical: {
    source_id: string;
    source_set_id: string | null;
    source_question_id: string | null;
  };
  question_count: number;
};

export type LogicalPracticePagination = {
  page: number;
  page_size: typeof LOGICAL_PRACTICE_PAGE_SIZE;
  total_items: number;
  total_pages: number;
};

export type LogicalPracticeCatalog = {
  items: LogicalPracticeListItem[];
  pagination: LogicalPracticePagination;
};

export type LogicalPracticeCatalogItemWithStudentState = LogicalPracticeListItem & {
  student_state: LogicalPracticeStudentState;
  actions: LogicalPracticeActions;
};

export type LogicalPracticeCatalogWithStudentState = {
  items: LogicalPracticeCatalogItemWithStudentState[];
  pagination: LogicalPracticePagination;
};

// The lightweight catalog never carries content. The search index is a
// separate request served by /api/practice-catalog/search-index and merged
// back on the client by item_id.
export type LogicalPracticeCatalogItemLightweight = LogicalPracticeCatalogItemWithStudentState;

export type LogicalPracticeCatalogLightweight = {
  items: LogicalPracticeCatalogItemLightweight[];
  pagination: LogicalPracticePagination;
};

export type PublicLogicalPracticeCatalogData = {
  catalog: LogicalPracticeCatalog;
  sources: FormalPracticeItemSource[];
};

export type LogicalPracticeStudentAttempts = {
  buildSentenceAttempts?: BuildSentenceLogicalAttemptRow[];
  writingAttempts?: WritingLogicalAttemptRow[];
};

export type PracticeItemOccurrenceRow = {
  occurrence_id?: string;
  source_id: string;
  occurred_on: string;
};

export function logicalPracticeItemTitle(
  item: Pick<LogicalPracticeListItem, "task_type" | "display_number" | "display_title">
) {
  if (item.task_type === "build_sentence") return `套题${item.display_number}`;
  return `题目${item.display_number}${item.display_title ? ` ${item.display_title}` : ""}`;
}

export function buildLogicalPracticeCatalog(input: {
  universe: PracticeCatalogDirectory;
  occurrences: PracticeItemOccurrenceRow[];
  taskType: PracticeTaskType;
  page: number;
  paginate?: boolean;
  /** Teacher question bank only: attach full searchable content text. */
  includeSearchText?: boolean;
}): LogicalPracticeCatalog {
  if (!Number.isSafeInteger(input.page) || input.page < 1) {
    throw new Error("Logical practice catalog page must be a positive integer.");
  }

  const occurrenceDatesByItem = new Map<string, string[]>();
  const occurrenceCountByItem = new Map<string, number>();
  for (const occurrence of input.occurrences) {
    const itemId = input.universe.resolveSourceToPracticeItemId(occurrence.source_id);
    if (!itemId) continue;
    const dates = occurrenceDatesByItem.get(itemId) ?? [];
    dates.push(occurrence.occurred_on);
    occurrenceDatesByItem.set(itemId, dates);
    occurrenceCountByItem.set(itemId, (occurrenceCountByItem.get(itemId) ?? 0) + 1);
  }

  const allItems = input.universe.publicItems
    .filter((item) => item.taskType === input.taskType)
    .map((item): LogicalPracticeListItem => {
      const occurrenceDateCounts = countOccurrenceDates(occurrenceDatesByItem.get(item.itemId) ?? []);
      const occurrenceDates = occurrenceDateCounts.map(({ date }) => date);
      return {
        item_id: item.itemId,
        task_type: item.taskType,
        display_number: item.displayNumber,
        display_title: item.displayTitle,
        catalog_category: item.catalogCategory,
        ...(input.includeSearchText ? { search_text: item.catalogSearchText } : {}),
        first_seen_date: item.firstSeenDate,
        latest_seen_date: occurrenceDates[0] ?? item.firstSeenDate,
        occurrence_dates: occurrenceDates,
        occurrence_date_counts: occurrenceDateCounts,
        occurrence_count: occurrenceCountByItem.get(item.itemId) ?? 0,
        canonical: {
          source_id: item.sourceId,
          source_set_id: item.sourceSetId,
          source_question_id: item.sourceQuestionId
        },
        question_count: item.taskType === "build_sentence" ? 10 : 1
      };
    })
    .sort(compareLogicalPracticeItems);

  const totalItems = allItems.length;
  const totalPages = Math.ceil(totalItems / LOGICAL_PRACTICE_PAGE_SIZE);
  const from = (input.page - 1) * LOGICAL_PRACTICE_PAGE_SIZE;
  return {
    items: input.paginate === false
      ? allItems
      : allItems.slice(from, from + LOGICAL_PRACTICE_PAGE_SIZE),
    pagination: {
      page: input.page,
      page_size: LOGICAL_PRACTICE_PAGE_SIZE,
      total_items: totalItems,
      total_pages: totalPages
    }
  };
}

type LogicalPracticeInputBase = {
  supabase: SupabaseClient;
  studentId: string;
  taskType: PracticeTaskType;
  timing?: StudentPerformanceTrace;
  loadPublicCatalog?: () => Promise<PublicLogicalPracticeCatalogData>;
};

type LogicalPracticeLoadInput = Omit<LogicalPracticeInputBase, "studentId"> & {
  /** Pre-started load, for example started before the auth gate resolved. */
  publicCatalogPromise?: Promise<PublicLogicalPracticeCatalogData>;
  /** Pre-started sparse state load, for example started before the auth gate resolved. */
  studentStatePromise?: Promise<StudentPracticeItemStateLoadResult>;
  /** Required unless both pre-started promises are supplied. */
  studentId?: string;
};

/**
 * One student first-screen catalog request: cached public practice catalog +
 * one sparse indexed student-state query, merged server-side.
 *
 * The loads may already be in flight (`publicCatalogPromise` /
 * `studentStatePromise`): the route starts them in parallel with the database
 * profile authorization and only calls this after the profile gate passes.
 */
export async function getLogicalPracticeItems(
  input: LogicalPracticeInputBase
): Promise<LogicalPracticeCatalogWithStudentState>;
export async function getLogicalPracticeItems(
  input: LogicalPracticeLoadInput
): Promise<LogicalPracticeCatalogWithStudentState>;
export async function getLogicalPracticeItems(
  input: LogicalPracticeLoadInput
): Promise<LogicalPracticeCatalogWithStudentState> {
  const publicCatalogPromise = input.publicCatalogPromise ?? (input.timing
    ? input.timing.phase("public_catalog", () => loadStartedPublicCatalog(input))
    : loadStartedPublicCatalog(input));
  const staticStudentId = input.studentId;
  const studentStatePromise = input.studentStatePromise ?? (staticStudentId
    ? loadStartedStudentState({
        supabase: input.supabase,
        studentId: staticStudentId,
        taskType: input.taskType,
        timing: input.timing
      })
    : undefined);
  if (!studentStatePromise) {
    throw new Error("getLogicalPracticeItems requires studentId or a pre-started student state load.");
  }

  const [publicCatalog, stateResult] = await Promise.all([
    publicCatalogPromise,
    studentStatePromise
  ]);
  const { catalog, sources } = publicCatalog;

  if (stateResult.available) {
    const buildMergedResult = () => ({
      ...catalog,
      items: attachLogicalPracticeStudentStateFromRows({
        items: catalog.items,
        states: stateResult.rows
      })
    });
    return input.timing
      ? input.timing.phaseSync("merge", buildMergedResult)
      : buildMergedResult();
  }

  // Transitional fallback while the state migration is rolling out: rebuild
  // the same state from the student's attempt history exactly as before.
  const attemptRows = await loadLogicalPracticeStudentAttempts({
    supabase: input.supabase,
    studentId: input.studentId ?? "",
    taskType: input.taskType,
    timing: input.timing
  });
  const buildLegacyResult = () => ({
    ...catalog,
    items: attachLogicalPracticeStudentState({
      items: catalog.items,
      sources,
      ...attemptRows
    })
  });
  return input.timing
    ? input.timing.phaseSync("merge", buildLegacyResult)
    : buildLegacyResult();
}

function loadStartedPublicCatalog(
  input: Omit<LogicalPracticeInputBase, "studentId">
) {
  return (input.loadPublicCatalog ?? (() =>
    loadPublicLogicalPracticeCatalog({
      supabase: input.supabase,
      taskType: input.taskType,
      timing: input.timing
    })))();
}

function loadStartedStudentState(input: { studentId: string } & Pick<
  LogicalPracticeInputBase,
  "supabase" | "taskType" | "timing"
>) {
  // Sparse state read: one indexed query for `student_id + task_type`,
  // with no full attempt-history scan.
  return loadStudentPracticeItemStates(input.supabase, {
    studentId: input.studentId,
    taskType: input.taskType,
    timing: input.timing
  });
}

export async function loadPublicLogicalPracticeCatalog(input: {
  supabase: SupabaseClient;
  taskType: PracticeTaskType;
  timing?: StudentPerformanceTrace;
}): Promise<PublicLogicalPracticeCatalogData> {
  const data = await loadPracticeCatalogDirectoryData(
    input.supabase,
    input.taskType,
    input.timing
  );
  const [occurrences, categoryBySourceId] = await Promise.all([
    loadPracticeCatalogOccurrences(input.supabase, data.formalSourceIds, input.timing),
    loadPracticeCatalogCategoryMetadata(
      input.supabase,
      input.taskType,
      data.canonicalSources,
      input.timing
    )
  ]);
  const directory = createPracticeCatalogDirectory(data.items, data.sources, categoryBySourceId);
  const buildCatalog = () =>
    buildLogicalPracticeCatalog({
      universe: directory,
      occurrences,
      taskType: input.taskType,
      page: 1,
      paginate: false
    });
  const catalog = input.timing
    ? input.timing.measureSync("processing", "build_logical_catalog_page", buildCatalog)
    : buildCatalog();
  return {
    catalog,
    sources: catalog.items.flatMap((item) =>
      directory.getFormalSourcesForPracticeItem(item.item_id)
    )
  };
}

export async function getLogicalPracticeCatalog(input: {
  supabase: SupabaseClient;
  taskType: PracticeTaskType;
  page: number;
  useTaskScopedUniverse?: boolean;
}): Promise<LogicalPracticeCatalog> {
  return (await loadLogicalPracticeCatalog(input)).catalog;
}

async function loadLogicalPracticeCatalog(input: {
  supabase: SupabaseClient;
  taskType: PracticeTaskType;
  page: number;
  timing?: StudentPerformanceTrace;
  useTaskScopedUniverse?: boolean;
}) {
  if (input.useTaskScopedUniverse) {
    return loadLogicalPracticeCatalogDirectory(input);
  }
  const [universe, occurrenceResult] = await Promise.all([
    loadPracticePublicUniverse(input.supabase, input.timing),
    measureDatabase(input.timing, "practice_item_occurrences", () =>
      readAllSupabaseRows<PracticeItemOccurrenceRow>((from, to) =>
        input.supabase
          .from("practice_item_occurrences")
          .select("occurrence_id,source_id,occurred_on")
          .order("source_id", { ascending: true })
          .order("occurred_on", { ascending: false })
          .range(from, to) as unknown as PromiseLike<{
            data: PracticeItemOccurrenceRow[] | null;
            error: { message: string } | null;
          }>
      )
    )
  ]);
  if (occurrenceResult.error) {
    throw new Error(`Failed to load practice item occurrences: ${occurrenceResult.error.message}`);
  }
  const buildCatalog = () => buildLogicalPracticeCatalog({
      universe,
      occurrences: occurrenceResult.data ?? [],
      taskType: input.taskType,
      page: input.page,
      includeSearchText: true
    });
  return {
    catalog: input.timing
      ? input.timing.measureSync("processing", "build_logical_catalog_page", buildCatalog)
      : buildCatalog(),
    paginateAfterStudentState: false,
    universe
  };
}

async function loadLogicalPracticeCatalogDirectory(input: {
  supabase: SupabaseClient;
  taskType: PracticeTaskType;
  page: number;
  timing?: StudentPerformanceTrace;
}) {
  const { directory, occurrences } = await loadPracticeCatalogDirectory(
    input.supabase,
    input.taskType,
    input.timing
  );
  const buildCatalog = () =>
    buildLogicalPracticeCatalog({
      universe: directory,
      occurrences,
      taskType: input.taskType,
      page: input.page,
      paginate: false,
      includeSearchText: true
    });
  return {
    catalog: input.timing
      ? input.timing.measureSync("processing", "build_logical_catalog_page", buildCatalog)
      : buildCatalog(),
    paginateAfterStudentState: true,
    universe: directory
  };
}

export async function loadLogicalPracticeStudentAttempts(input: {
  supabase: SupabaseClient;
  studentId: string;
  taskType: PracticeTaskType;
  timing?: StudentPerformanceTrace;
}): Promise<LogicalPracticeStudentAttempts> {
  if (input.taskType === "build_sentence") {
    const result = await measureDatabase(input.timing, "attempts_current_catalog_page", () =>
      readAllSupabaseRows<BuildSentenceLogicalAttemptRow>((from, to) =>
        input.supabase
          .from("attempts")
          .select("attempt_id,set_id,submitted_at,created_at")
          .eq("student_id", input.studentId)
          .order("submitted_at", { ascending: false, nullsFirst: false })
          .order("attempt_id", { ascending: false })
          .range(from, to) as unknown as PromiseLike<{
            data: BuildSentenceLogicalAttemptRow[] | null;
            error: { message: string } | null;
          }>
      )
    );
    if (result.error) {
      throw new Error(`Failed to load BAS logical attempts: ${result.error.message}`);
    }
    return { buildSentenceAttempts: result.data ?? [] };
  }

  const result = await measureDatabase(input.timing, "writing_attempts_current_catalog_page", () =>
    readAllSupabaseRows<WritingLogicalAttemptRow>((from, to) =>
      input.supabase
        .from("writing_attempts")
        .select(
          "attempt_id,assignment_id,task_type,question_id,status,saved_at,submitted_at,created_at,updated_at"
        )
        .eq("user_id", input.studentId)
        .eq("task_type", input.taskType)
        .is("assignment_id", null)
        .order("updated_at", { ascending: false })
        .order("attempt_id", { ascending: false })
        .range(from, to) as unknown as PromiseLike<{
          data: WritingLogicalAttemptRow[] | null;
          error: { message: string } | null;
        }>
    )
  );
  if (result.error) {
    throw new Error(`Failed to load Writing logical attempts: ${result.error.message}`);
  }
  return { writingAttempts: result.data ?? [] };
}

function measureDatabase<T>(
  timing: StudentPerformanceTrace | undefined,
  name: string,
  operation: () => Promise<T>
) {
  return timing ? timing.measure("database", name, operation) : operation();
}

export function parseLogicalPracticePage(value: string | null) {
  if (value === null || value === "") return 1;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) ? page : null;
}

export function isLogicalPracticeTaskType(value: unknown): value is PracticeTaskType {
  return value === "build_sentence" || value === "email" || value === "academic_discussion";
}

function compareLogicalPracticeItems(
  left: LogicalPracticeListItem,
  right: LogicalPracticeListItem
) {
  return (
    right.first_seen_date.localeCompare(left.first_seen_date) ||
    compareDisplayNumbers(right.display_number, left.display_number) ||
    left.item_id.localeCompare(right.item_id)
  );
}
