import type { SupabaseClient } from "@supabase/supabase-js";
import { compareDisplayNumbers } from "./practiceImporter/numbering.ts";
import type { PracticeTaskType } from "./practiceImporter/types.ts";
import {
  loadPracticeCatalogDirectory,
  loadPracticePublicUniverse,
  type FormalPracticeItemSource,
  type PracticeCatalogDirectory
} from "./practicePublicUniverse.ts";
import {
  attachLogicalPracticeStudentState,
  type BuildSentenceLogicalAttemptRow,
  type LogicalPracticeActions,
  type LogicalPracticeStudentState,
  type WritingLogicalAttemptRow
} from "./practiceLogicalState.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import type { StudentPerformanceTrace } from "./studentPerformance.server.ts";

export const LOGICAL_PRACTICE_PAGE_SIZE = 10;

export type LogicalPracticeListItem = {
  item_id: string;
  task_type: PracticeTaskType;
  display_number: string;
  display_title: string | null;
  first_seen_date: string;
  occurrence_dates: string[];
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

export type PublicLogicalPracticeCatalogData = {
  catalog: LogicalPracticeCatalog;
  sources: FormalPracticeItemSource[];
};

export type LogicalPracticeStudentAttempts = {
  buildSentenceAttempts?: BuildSentenceLogicalAttemptRow[];
  writingAttempts?: WritingLogicalAttemptRow[];
};

export type PracticeItemOccurrenceRow = {
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
}): LogicalPracticeCatalog {
  if (!Number.isSafeInteger(input.page) || input.page < 1) {
    throw new Error("Logical practice catalog page must be a positive integer.");
  }

  const occurrenceDatesByItem = new Map<string, Set<string>>();
  for (const occurrence of input.occurrences) {
    const itemId = input.universe.resolveSourceToPracticeItemId(occurrence.source_id);
    if (!itemId) continue;
    const dates = occurrenceDatesByItem.get(itemId) ?? new Set<string>();
    dates.add(occurrence.occurred_on);
    occurrenceDatesByItem.set(itemId, dates);
  }

  const allItems = input.universe.publicItems
    .filter((item) => item.taskType === input.taskType)
    .map((item): LogicalPracticeListItem => ({
      item_id: item.itemId,
      task_type: item.taskType,
      display_number: item.displayNumber,
      display_title: item.displayTitle,
      first_seen_date: item.firstSeenDate,
      occurrence_dates: Array.from(occurrenceDatesByItem.get(item.itemId) ?? [])
        .sort((left, right) => right.localeCompare(left)),
      canonical: {
        source_id: item.sourceId,
        source_set_id: item.sourceSetId,
        source_question_id: item.sourceQuestionId
      },
      question_count: item.taskType === "build_sentence" ? 10 : 1
    }))
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

export async function getLogicalPracticeItems(input: {
  supabase: SupabaseClient;
  studentId: string;
  taskType: PracticeTaskType;
  timing?: StudentPerformanceTrace;
  loadPublicCatalog?: () => Promise<PublicLogicalPracticeCatalogData>;
}): Promise<LogicalPracticeCatalogWithStudentState> {
  const loadPublic = input.loadPublicCatalog ?? (() =>
    loadPublicLogicalPracticeCatalog({
      supabase: input.supabase,
      taskType: input.taskType,
      timing: input.timing
    }));
  const publicCatalogPromise = input.timing
    ? input.timing.measure("cache", "public_practice_catalog", loadPublic)
    : loadPublic();
  const [publicCatalog, attemptRows] = await Promise.all([
    publicCatalogPromise,
    loadLogicalPracticeStudentAttempts({
      supabase: input.supabase,
      studentId: input.studentId,
      taskType: input.taskType,
      timing: input.timing
    })
  ]);
  const { catalog, sources } = publicCatalog;
  const buildResult = () => {
    const items = attachLogicalPracticeStudentState({
      items: catalog.items,
      sources,
      ...attemptRows
    });
    return {
      ...catalog,
      items
    };
  };
  return input.timing
    ? input.timing.measureSync("processing", "attach_student_catalog_state", buildResult)
    : buildResult();
}

export async function loadPublicLogicalPracticeCatalog(input: {
  supabase: SupabaseClient;
  taskType: PracticeTaskType;
  timing?: StudentPerformanceTrace;
}): Promise<PublicLogicalPracticeCatalogData> {
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
          .select("source_id,occurred_on")
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
      page: input.page
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
      paginate: false
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
