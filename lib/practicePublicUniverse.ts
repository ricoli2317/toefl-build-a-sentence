import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import type { PracticeTaskType } from "./practiceImporter/types.ts";
import type { StudentPerformanceTrace } from "./studentPerformance.server.ts";
import {
  resolveWritingAssignmentQuestionIsolation,
  type WritingAssignmentPracticeResolution
} from "./writingAssignments.ts";

const PUBLIC_PRACTICE_TASK_TYPES = new Set<PracticeTaskType>([
  "build_sentence",
  "email",
  "academic_discussion"
]);

type PracticeItemRow = {
  item_id: string;
  task_type: PracticeTaskType;
  display_number: string | null;
  display_title: string | null;
  first_seen_date: string;
  is_active: boolean;
};

type PracticeItemSourceRow = {
  source_id: string;
  item_id: string;
  task_type: PracticeTaskType;
  source_set_id: string | null;
  source_question_id: string | null;
  is_canonical: boolean;
};

export type FormalPracticeItemSource = {
  sourceId: string;
  itemId: string;
  taskType: PracticeTaskType;
  sourceSetId: string | null;
  sourceQuestionId: string | null;
  isCanonical: boolean;
};

type PracticeItemQuestionMapRow = {
  source_id: string;
  source_question_id: string;
  source_question_order: number;
  logical_question_order: number;
};

type BuildSentenceRawQuestionRow = {
  question_id: string;
  set_id: string;
  question_order: number;
};

type WritingRawQuestionRow = {
  question_id: string;
};

export type PracticePublicUniverseSnapshot = {
  items: PracticeItemRow[];
  sources: PracticeItemSourceRow[];
  questionMaps: PracticeItemQuestionMapRow[];
  buildSentenceQuestions: BuildSentenceRawQuestionRow[];
  emailQuestions: WritingRawQuestionRow[];
  academicDiscussionQuestions: WritingRawQuestionRow[];
};

export type HistoricalPracticeItem = {
  itemId: string;
  taskType: PracticeTaskType;
  displayNumber: string | null;
  displayTitle: string | null;
  firstSeenDate: string;
  isActive: boolean;
};

export type PublicBuildSentenceQuestion = {
  questionId: string;
  sourceQuestionOrder: number;
  logicalQuestionOrder: number;
};

export type PublicCanonicalPracticeSource = HistoricalPracticeItem & {
  displayNumber: string;
  sourceId: string;
  sourceSetId: string | null;
  sourceQuestionId: string | null;
  canonicalQuestions: PublicBuildSentenceQuestion[] | null;
};

export type PracticePublicUniverseWarning = {
  code:
    | "NO_FORMAL_SOURCE"
    | "CANONICAL_SOURCE_COUNT"
    | "VIRTUAL_BAS_SOURCE"
    | "CANONICAL_RAW_SOURCE_MISSING"
    | "INVALID_BAS_QUESTION_COUNT"
    | "INVALID_BAS_QUESTION_MAP";
  itemId: string;
  taskType: PracticeTaskType;
  sourceId: string | null;
  message: string;
};

export type FreePracticeWritingAttemptInput = {
  assignment_id: string | null;
  task_type: "email" | "academic_discussion";
  question_id: string;
};

export type PracticePublicUniverse = {
  warnings: PracticePublicUniverseWarning[];
  publicItems: PublicCanonicalPracticeSource[];
  isPublicPracticeItem(itemId: string): boolean;
  getPublicCanonicalSource(itemId: string): PublicCanonicalPracticeSource | null;
  getFormalSourcesForPracticeItem(itemId: string): FormalPracticeItemSource[];
  resolveSourceToPracticeItemId(sourceId: string): string | null;
  resolveActivePublicRawQuestionToPracticeItem(
    taskType: "email" | "academic_discussion",
    questionId: string
  ): PublicCanonicalPracticeSource | null;
  resolveHistoricalPracticeItem(itemId: string): HistoricalPracticeItem | null;
  resolveHistoricalRawQuestionToPracticeItem(
    taskType: "email" | "academic_discussion",
    questionId: string
  ): HistoricalPracticeItem | null;
  isFreePracticeWritingAttempt(attempt: FreePracticeWritingAttemptInput): boolean;
  resolveWritingAssignment(input: {
    questionSource: "question_bank" | "custom";
    taskType: "email" | "academic_discussion";
    questionId: string | null;
  }): WritingAssignmentPracticeResolution;
};

export function createPracticePublicUniverse(
  snapshot: PracticePublicUniverseSnapshot
): PracticePublicUniverse {
  const itemsById = new Map(snapshot.items.map((item) => [item.item_id, item]));
  const sourcesByItem = groupBy(snapshot.sources, (source) => source.item_id);
  const mapsBySource = groupBy(snapshot.questionMaps, (row) => row.source_id);
  const buildSentenceQuestionsBySet = groupBy(
    snapshot.buildSentenceQuestions,
    (question) => String(question.set_id)
  );
  const emailQuestionIds = new Set(snapshot.emailQuestions.map((row) => row.question_id));
  const academicDiscussionQuestionIds = new Set(
    snapshot.academicDiscussionQuestions.map((row) => row.question_id)
  );
  const historicalItems = new Map(
    snapshot.items.map((item) => [item.item_id, historicalItem(item)])
  );
  const historicalWritingItemByRawQuestion = new Map<string, HistoricalPracticeItem>();
  const practiceItemIdBySource = new Map<string, string>();
  const formalSourcesByItem = new Map<string, FormalPracticeItemSource[]>();
  for (const source of snapshot.sources) {
    const item = itemsById.get(source.item_id);
    if (!item || item.task_type !== source.task_type || !isFormalSource(source)) continue;
    practiceItemIdBySource.set(source.source_id, item.item_id);
    formalSourcesByItem.set(item.item_id, [
      ...(formalSourcesByItem.get(item.item_id) ?? []),
      {
        sourceId: source.source_id,
        itemId: source.item_id,
        taskType: source.task_type,
        sourceSetId: source.source_set_id,
        sourceQuestionId: source.source_question_id,
        isCanonical: source.is_canonical
      }
    ]);
    if (!isWritingTaskType(source.task_type) || !source.source_question_id) continue;
    historicalWritingItemByRawQuestion.set(
      writingRawKey(source.task_type, source.source_question_id),
      historicalItem(item)
    );
  }

  const warnings: PracticePublicUniverseWarning[] = [];
  const publicItems: PublicCanonicalPracticeSource[] = [];
  const publicById = new Map<string, PublicCanonicalPracticeSource>();

  for (const item of snapshot.items) {
    if (
      !PUBLIC_PRACTICE_TASK_TYPES.has(item.task_type) ||
      !item.is_active ||
      !item.display_number?.trim()
    ) {
      continue;
    }

    const formalSources = (sourcesByItem.get(item.item_id) ?? []).filter(
      (source) => source.task_type === item.task_type && isFormalSource(source)
    );
    if (formalSources.length === 0) {
      warnings.push(warning(item, "NO_FORMAL_SOURCE", null, "Active item has no formal source."));
      continue;
    }
    const canonicalSources = formalSources.filter((source) => source.is_canonical);
    if (canonicalSources.length !== 1) {
      warnings.push(
        warning(
          item,
          "CANONICAL_SOURCE_COUNT",
          null,
          `Active item has ${canonicalSources.length} canonical sources; expected exactly one.`
        )
      );
      continue;
    }

    const canonical = canonicalSources[0];
    let canonicalQuestions: PublicBuildSentenceQuestion[] | null = null;
    if (item.task_type === "build_sentence") {
      const setId = canonical.source_set_id!;
      if (isVirtualBuildSentenceSetId(setId)) {
        warnings.push(
          warning(item, "VIRTUAL_BAS_SOURCE", canonical.source_id, "Virtual BAS sets are not public logical items.")
        );
        continue;
      }
      const rawQuestions = buildSentenceQuestionsBySet.get(setId) ?? [];
      if (rawQuestions.length === 0) {
        warnings.push(
          warning(item, "CANONICAL_RAW_SOURCE_MISSING", canonical.source_id, "Canonical BAS raw set is missing.")
        );
        continue;
      }
      if (rawQuestions.length !== 10) {
        warnings.push(
          warning(item, "INVALID_BAS_QUESTION_COUNT", canonical.source_id, "Canonical BAS set must contain exactly 10 questions.")
        );
        continue;
      }
      const questionMaps = mapsBySource.get(canonical.source_id) ?? [];
      const rawQuestionIds = new Set(rawQuestions.map((question) => question.question_id));
      const mappedQuestionIds = new Set(questionMaps.map((row) => row.source_question_id));
      const logicalOrders = new Set(questionMaps.map((row) => Number(row.logical_question_order)));
      if (
        questionMaps.length !== 10 ||
        mappedQuestionIds.size !== 10 ||
        logicalOrders.size !== 10 ||
        !Array.from({ length: 10 }, (_, index) => index + 1).every((order) =>
          logicalOrders.has(order)
        ) ||
        questionMaps.some((row) => !rawQuestionIds.has(row.source_question_id))
      ) {
        warnings.push(
          warning(item, "INVALID_BAS_QUESTION_MAP", canonical.source_id, "Canonical BAS source must have a complete logical Q1-Q10 map.")
        );
        continue;
      }
      canonicalQuestions = questionMaps
        .map((row) => ({
          questionId: row.source_question_id,
          sourceQuestionOrder: Number(row.source_question_order),
          logicalQuestionOrder: Number(row.logical_question_order)
        }))
        .sort((left, right) => left.logicalQuestionOrder - right.logicalQuestionOrder);
    } else {
      const rawQuestionId = canonical.source_question_id!;
      const rawExists = item.task_type === "email"
        ? emailQuestionIds.has(rawQuestionId)
        : academicDiscussionQuestionIds.has(rawQuestionId);
      if (!rawExists) {
        warnings.push(
          warning(item, "CANONICAL_RAW_SOURCE_MISSING", canonical.source_id, "Canonical writing raw question is missing.")
        );
        continue;
      }
    }

    const publicItem: PublicCanonicalPracticeSource = {
      ...historicalItem(item),
      displayNumber: item.display_number,
      sourceId: canonical.source_id,
      sourceSetId: canonical.source_set_id,
      sourceQuestionId: canonical.source_question_id,
      canonicalQuestions
    };
    publicItems.push(publicItem);
    publicById.set(item.item_id, publicItem);
  }

  const resolveActivePublicRawQuestionToPracticeItem = (
    taskType: "email" | "academic_discussion",
    questionId: string
  ) => {
    const rawExists = taskType === "email"
      ? emailQuestionIds.has(questionId)
      : academicDiscussionQuestionIds.has(questionId);
    if (!rawExists) return null;
    const historical = historicalWritingItemByRawQuestion.get(writingRawKey(taskType, questionId));
    return historical ? publicById.get(historical.itemId) ?? null : null;
  };

  return {
    warnings,
    publicItems,
    isPublicPracticeItem: (itemId) => publicById.has(itemId),
    getPublicCanonicalSource: (itemId) => publicById.get(itemId) ?? null,
    getFormalSourcesForPracticeItem: (itemId) => [
      ...(formalSourcesByItem.get(itemId) ?? [])
    ],
    resolveSourceToPracticeItemId: (sourceId) => practiceItemIdBySource.get(sourceId) ?? null,
    resolveActivePublicRawQuestionToPracticeItem,
    resolveHistoricalPracticeItem: (itemId) => historicalItems.get(itemId) ?? null,
    resolveHistoricalRawQuestionToPracticeItem: (taskType, questionId) =>
      historicalWritingItemByRawQuestion.get(writingRawKey(taskType, questionId)) ?? null,
    isFreePracticeWritingAttempt(attempt) {
      return (
        attempt.assignment_id === null &&
        Boolean(resolveActivePublicRawQuestionToPracticeItem(attempt.task_type, attempt.question_id))
      );
    },
    resolveWritingAssignment(input) {
      const historicalItem = input.questionSource === "question_bank" && input.questionId
        ? historicalWritingItemByRawQuestion.get(writingRawKey(input.taskType, input.questionId)) ?? null
        : null;
      const publicItem = input.questionSource === "question_bank" && input.questionId
        ? resolveActivePublicRawQuestionToPracticeItem(input.taskType, input.questionId)
        : null;
      return resolveWritingAssignmentQuestionIsolation({
        questionSource: input.questionSource,
        questionId: input.questionId,
        resolvedHistoricalPracticeItemId: historicalItem?.itemId ?? null,
        resolvedPublicPracticeItemId: publicItem?.itemId ?? null
      });
    }
  };
}

export async function loadPracticePublicUniverse(
  supabase: SupabaseClient,
  timing?: StudentPerformanceTrace
): Promise<PracticePublicUniverse> {
  const [items, sources, questionMaps, buildSentenceQuestions, emailQuestions, academicQuestions] =
    await Promise.all([
      measureDatabase(timing, "practice_items", () =>
        readRows<PracticeItemRow>(
          supabase,
          "practice_items",
          "item_id,task_type,display_number,display_title,first_seen_date,is_active",
          "item_id"
        )
      ),
      measureDatabase(timing, "practice_item_sources", () =>
        readRows<PracticeItemSourceRow>(
          supabase,
          "practice_item_sources",
          "source_id,item_id,task_type,source_set_id,source_question_id,is_canonical",
          "source_id"
        )
      ),
      measureDatabase(timing, "practice_item_question_map", () =>
        readRows<PracticeItemQuestionMapRow>(
          supabase,
          "practice_item_question_map",
          "source_id,source_question_id,source_question_order,logical_question_order",
          "map_id"
        )
      ),
      measureDatabase(timing, "questions_public_universe", () =>
        readRows<BuildSentenceRawQuestionRow>(
          supabase,
          "questions",
          "question_id,set_id,question_order",
          "question_id"
        )
      ),
      measureDatabase(timing, "email_questions_public_universe", () =>
        readRows<WritingRawQuestionRow>(supabase, "email_questions", "question_id", "question_id")
      ),
      measureDatabase(timing, "academic_discussion_questions_public_universe", () =>
        readRows<WritingRawQuestionRow>(
          supabase,
          "academic_discussion_questions",
          "question_id",
          "question_id"
        )
      ),
    ]);
  const universe = timing
    ? timing.measureSync("processing", "build_practice_public_universe", () =>
        createPracticePublicUniverse({
          items,
          sources,
          questionMaps,
          buildSentenceQuestions,
          emailQuestions,
          academicDiscussionQuestions: academicQuestions
        })
      )
    : createPracticePublicUniverse({
        items,
        sources,
        questionMaps,
        buildSentenceQuestions,
        emailQuestions,
        academicDiscussionQuestions: academicQuestions
      });
  for (const warning of universe.warnings) {
    console.warn("[practice-public-universe] excluded_invalid_item", warning);
  }
  return universe;
}

export async function loadPracticePublicUniverseForTaskType(
  supabase: SupabaseClient,
  taskType: PracticeTaskType,
  timing?: StudentPerformanceTrace
): Promise<PracticePublicUniverse> {
  const [items, allTaskSources] = await Promise.all([
    measureDatabase(timing, "practice_items", async () => {
      const result = await readAllSupabaseRows<PracticeItemRow>((from, to) =>
        supabase
          .from("practice_items")
          .select("item_id,task_type,display_number,display_title,first_seen_date,is_active")
          .eq("task_type", taskType)
          .eq("is_active", true)
          .order("item_id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
            data: PracticeItemRow[] | null;
            error: { message: string } | null;
          }>
      );
      if (result.error) {
        throw new Error(
          `Failed to load practice_items for ${taskType} catalog: ${result.error.message}`
        );
      }
      return result.data ?? [];
    }),
    measureDatabase(timing, "practice_item_sources", async () => {
      const result = await readAllSupabaseRows<PracticeItemSourceRow>((from, to) =>
        supabase
          .from("practice_item_sources")
          .select("source_id,item_id,task_type,source_set_id,source_question_id,is_canonical")
          .eq("task_type", taskType)
          .order("source_id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
            data: PracticeItemSourceRow[] | null;
            error: { message: string } | null;
          }>
      );
      if (result.error) {
        throw new Error(
          `Failed to load practice_item_sources for ${taskType} catalog: ${result.error.message}`
        );
      }
      return result.data ?? [];
    })
  ]);

  const activeItemIds = new Set(items.map((item) => item.item_id));
  const sources = allTaskSources.filter((source) => activeItemIds.has(source.item_id));
  const formalSources = sources.filter(isFormalSource);
  const canonicalSources = formalSources.filter((source) => source.is_canonical);

  let questionMaps: PracticeItemQuestionMapRow[] = [];
  let buildSentenceQuestions: BuildSentenceRawQuestionRow[] = [];
  let emailQuestions: WritingRawQuestionRow[] = [];
  let academicDiscussionQuestions: WritingRawQuestionRow[] = [];

  if (taskType === "build_sentence") {
    const canonicalSourceIds = distinct(canonicalSources.map((source) => source.source_id));
    const canonicalSetIds = distinct(
      canonicalSources.flatMap((source) =>
        source.source_set_id && !isVirtualBuildSentenceSetId(source.source_set_id)
          ? [source.source_set_id]
          : []
      )
    );
    [questionMaps, buildSentenceQuestions] = await Promise.all([
      measureDatabase(timing, "practice_item_question_map", () =>
        readRowsInBatches<PracticeItemQuestionMapRow>(
          canonicalSourceIds,
          (batch, from, to) =>
            supabase
              .from("practice_item_question_map")
              .select("source_id,source_question_id,source_question_order,logical_question_order")
              .in("source_id", batch)
              .order("map_id", { ascending: true })
              .range(from, to) as unknown as PromiseLike<{
                data: PracticeItemQuestionMapRow[] | null;
                error: { message: string } | null;
              }>,
          "practice_item_question_map"
        )
      ),
      measureDatabase(timing, "questions_public_universe", () =>
        readRowsInBatches<BuildSentenceRawQuestionRow>(
          canonicalSetIds,
          (batch, from, to) =>
            supabase
              .from("questions")
              .select("question_id,set_id,question_order")
              .in("set_id", batch)
              .order("question_id", { ascending: true })
              .range(from, to) as unknown as PromiseLike<{
                data: BuildSentenceRawQuestionRow[] | null;
                error: { message: string } | null;
              }>,
          "questions"
        )
      )
    ]);
  } else {
    const canonicalQuestionIds = distinct(
      canonicalSources.flatMap((source) =>
        source.source_question_id ? [source.source_question_id] : []
      )
    );
    const rows = await measureDatabase(
      timing,
      taskType === "email"
        ? "email_questions_public_universe"
        : "academic_discussion_questions_public_universe",
      () =>
        readRowsInBatches<WritingRawQuestionRow>(
          canonicalQuestionIds,
          (batch, from, to) =>
            supabase
              .from(
                taskType === "email"
                  ? "email_questions"
                  : "academic_discussion_questions"
              )
              .select("question_id")
              .in("question_id", batch)
              .order("question_id", { ascending: true })
              .range(from, to) as unknown as PromiseLike<{
                data: WritingRawQuestionRow[] | null;
                error: { message: string } | null;
              }>,
          taskType === "email" ? "email_questions" : "academic_discussion_questions"
        )
    );
    if (taskType === "email") emailQuestions = rows;
    else academicDiscussionQuestions = rows;
  }

  const buildUniverse = () =>
    createPracticePublicUniverse({
      items,
      sources,
      questionMaps,
      buildSentenceQuestions,
      emailQuestions,
      academicDiscussionQuestions
    });
  const universe = timing
    ? timing.measureSync("processing", "build_practice_public_universe", buildUniverse)
    : buildUniverse();
  for (const warning of universe.warnings) {
    console.warn("[practice-public-universe] excluded_invalid_item", warning);
  }
  return universe;
}

function measureDatabase<T>(
  timing: StudentPerformanceTrace | undefined,
  name: string,
  operation: () => Promise<T>
) {
  return timing ? timing.measure("database", name, operation) : operation();
}

export async function isPublicPracticeItem(supabase: SupabaseClient, itemId: string) {
  return (await loadPracticePublicUniverse(supabase)).isPublicPracticeItem(itemId);
}

export async function getPublicCanonicalSource(supabase: SupabaseClient, itemId: string) {
  return (await loadPracticePublicUniverse(supabase)).getPublicCanonicalSource(itemId);
}

export async function resolveRawQuestionToPracticeItem(
  supabase: SupabaseClient,
  taskType: "email" | "academic_discussion",
  questionId: string
) {
  return (await loadPracticePublicUniverse(supabase))
    .resolveActivePublicRawQuestionToPracticeItem(taskType, questionId);
}

export async function resolveHistoricalPracticeItem(
  supabase: SupabaseClient,
  itemId: string
) {
  return (await loadPracticePublicUniverse(supabase)).resolveHistoricalPracticeItem(itemId);
}

export async function resolveHistoricalRawQuestionToPracticeItem(
  supabase: SupabaseClient,
  taskType: "email" | "academic_discussion",
  questionId: string
) {
  return (await loadPracticePublicUniverse(supabase))
    .resolveHistoricalRawQuestionToPracticeItem(taskType, questionId);
}

export async function isFreePracticeWritingAttempt(
  supabase: SupabaseClient,
  attempt: FreePracticeWritingAttemptInput
) {
  return (await loadPracticePublicUniverse(supabase)).isFreePracticeWritingAttempt(attempt);
}

function isFormalSource(source: PracticeItemSourceRow) {
  return source.task_type === "build_sentence"
    ? Boolean(source.source_set_id) && source.source_question_id === null
    : isWritingTaskType(source.task_type) &&
        Boolean(source.source_question_id);
}

function isWritingTaskType(
  taskType: PracticeTaskType
): taskType is "email" | "academic_discussion" {
  return taskType === "email" || taskType === "academic_discussion";
}

function isVirtualBuildSentenceSetId(setId: string) {
  const normalized = setId.trim().toLowerCase();
  return normalized.startsWith("grammar-") || normalized.startsWith("wrongbook-");
}

function historicalItem(item: PracticeItemRow): HistoricalPracticeItem {
  return {
    itemId: item.item_id,
    taskType: item.task_type,
    displayNumber: item.display_number,
    displayTitle: item.display_title,
    firstSeenDate: item.first_seen_date,
    isActive: item.is_active
  };
}

function warning(
  item: PracticeItemRow,
  code: PracticePublicUniverseWarning["code"],
  sourceId: string | null,
  message: string
): PracticePublicUniverseWarning {
  return { code, itemId: item.item_id, taskType: item.task_type, sourceId, message };
}

function writingRawKey(taskType: "email" | "academic_discussion", questionId: string) {
  return `${taskType}:${questionId}`;
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    grouped.set(key(row), [...(grouped.get(key(row)) ?? []), row]);
  }
  return grouped;
}

async function readRows<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  orderColumn: string
): Promise<T[]> {
  const result = await readAllSupabaseRows<T>((from, to) =>
    supabase
      .from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: T[] | null;
        error: { message: string } | null;
      }>
  );
  if (result.error) {
    throw new Error(`Failed to load ${table} for public practice universe: ${result.error.message}`);
  }
  return result.data ?? [];
}

async function readRowsInBatches<T>(
  values: string[],
  readPage: (
    batch: string[],
    from: number,
    to: number
  ) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
  table: string
): Promise<T[]> {
  if (values.length === 0) return [];
  const results = await Promise.all(
    chunkValues(distinct(values)).map((batch) =>
      readAllSupabaseRows<T>((from, to) => readPage(batch, from, to))
    )
  );
  const error = results.find((result) => result.error)?.error;
  if (error) {
    throw new Error(`Failed to load ${table} for scoped public practice universe: ${error.message}`);
  }
  return results.flatMap((result) => result.data ?? []);
}

function chunkValues<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function distinct(values: string[]) {
  return Array.from(new Set(values));
}
