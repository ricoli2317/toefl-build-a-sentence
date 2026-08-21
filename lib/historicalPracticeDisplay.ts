import type { SupabaseClient } from "@supabase/supabase-js";
import type { PracticeTaskType } from "./practiceImporter/types.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import type { StudentPerformanceTrace } from "./studentPerformance.server.ts";

export type HistoricalPracticeItemRow = {
  item_id: string;
  task_type: PracticeTaskType;
  display_number: string | null;
  display_title: string | null;
  is_active: boolean;
};

export type HistoricalPracticeSourceRow = {
  source_id: string;
  item_id: string;
  task_type: PracticeTaskType;
  source_set_id: string | null;
  source_question_id: string | null;
};

export type HistoricalPracticeDisplayWarning = {
  code:
    | "AMBIGUOUS_HISTORICAL_SOURCE"
    | "HISTORICAL_ITEM_MISSING"
    | "HISTORICAL_DISPLAY_NUMBER_MISSING"
    | "HISTORICAL_SOURCE_NOT_MAPPED";
  taskType: "build_sentence" | "email" | "academic_discussion";
  rawSetId: string | null;
  rawQuestionId: string | null;
  itemId: string | null;
  message: string;
};

export type HistoricalPracticeDisplay = {
  itemId: string | null;
  taskType: "build_sentence" | "email" | "academic_discussion";
  displayNumber: string | null;
  displayTitle: string | null;
  displayName: string;
  logicalDisplayName: string | null;
  rawSetId: string | null;
  rawQuestionId: string | null;
  isActive: boolean | null;
  resolution: "logical" | "virtual" | "assignment" | "fallback";
  warning: HistoricalPracticeDisplayWarning | null;
};

export type HistoricalWritingDisplayInput = {
  assignmentId: string | null;
  assignmentDisplayName?: string | null;
  fallbackDisplayName: string;
  questionSource?: "question_bank" | "custom" | null;
  rawQuestionId: string;
  taskType: "email" | "academic_discussion";
};

export type HistoricalPracticeDisplayResolver = {
  resolveBuildSentence(input: {
    fallbackDisplayName: string;
    rawSetId: string;
  }): HistoricalPracticeDisplay;
  resolveWritingAttempt(input: HistoricalWritingDisplayInput): HistoricalPracticeDisplay;
};

export function createHistoricalPracticeDisplayResolver(input: {
  items: HistoricalPracticeItemRow[];
  sources: HistoricalPracticeSourceRow[];
}): HistoricalPracticeDisplayResolver {
  const itemById = new Map(input.items.map((item) => [String(item.item_id), item]));
  const basSourcesByRawSet = groupSources(
    input.sources.filter(
      (source) => source.task_type === "build_sentence" && Boolean(source.source_set_id)
    ),
    (source) => String(source.source_set_id)
  );
  const writingSourcesByRawQuestion = groupSources(
    input.sources.filter(
      (source) => isWritingTaskType(source.task_type) && Boolean(source.source_question_id)
    ),
    (source) => `${source.task_type}:${String(source.source_question_id)}`
  );

  function resolveBuildSentence({
    fallbackDisplayName,
    rawSetId
  }: {
    fallbackDisplayName: string;
    rawSetId: string;
  }): HistoricalPracticeDisplay {
    if (isVirtualBuildSentenceSet(rawSetId)) {
      return fallbackDisplay({
        displayName: fallbackDisplayName,
        rawQuestionId: null,
        rawSetId,
        resolution: "virtual",
        taskType: "build_sentence",
        warning: null
      });
    }
    return resolveLogical({
      fallbackDisplayName,
      rawQuestionId: null,
      rawSetId,
      sources: basSourcesByRawSet.get(rawSetId) ?? [],
      taskType: "build_sentence"
    });
  }

  function resolveWritingAttempt(
    writingInput: HistoricalWritingDisplayInput
  ): HistoricalPracticeDisplay {
    const assignmentDisplayName =
      writingInput.assignmentDisplayName?.trim() || writingInput.fallbackDisplayName;
    if (writingInput.assignmentId) {
      if (writingInput.questionSource === "custom") {
        return fallbackDisplay({
          displayName: assignmentDisplayName,
          rawQuestionId: writingInput.rawQuestionId,
          rawSetId: null,
          resolution: "assignment",
          taskType: writingInput.taskType,
          warning: null
        });
      }
      const auxiliary = resolveWritingLogical(writingInput);
      return {
        ...auxiliary,
        displayName:
          auxiliary.resolution === "logical"
            ? auxiliary.displayName
            : assignmentDisplayName,
        logicalDisplayName:
          auxiliary.resolution === "logical" ? auxiliary.displayName : null,
        resolution: "assignment",
        warning: auxiliary.warning
      };
    }
    return resolveWritingLogical(writingInput);
  }

  function resolveWritingLogical(
    writingInput: HistoricalWritingDisplayInput
  ): HistoricalPracticeDisplay {
    return resolveLogical({
      fallbackDisplayName: writingInput.fallbackDisplayName,
      rawQuestionId: writingInput.rawQuestionId,
      rawSetId: null,
      sources:
        writingSourcesByRawQuestion.get(
          `${writingInput.taskType}:${writingInput.rawQuestionId}`
        ) ?? [],
      taskType: writingInput.taskType
    });
  }

  function resolveLogical(input: {
    fallbackDisplayName: string;
    rawQuestionId: string | null;
    rawSetId: string | null;
    sources: HistoricalPracticeSourceRow[];
    taskType: "build_sentence" | "email" | "academic_discussion";
  }): HistoricalPracticeDisplay {
    if (input.sources.length === 0) {
      return fallbackWithWarning(input, {
        code: "HISTORICAL_SOURCE_NOT_MAPPED",
        itemId: null,
        message: "Historical raw source has no practice_item_sources mapping."
      });
    }
    const itemIds = Array.from(new Set(input.sources.map((source) => String(source.item_id))));
    if (itemIds.length !== 1) {
      return fallbackWithWarning(input, {
        code: "AMBIGUOUS_HISTORICAL_SOURCE",
        itemId: null,
        message: `Historical raw source maps to ${itemIds.length} practice items.`
      });
    }
    const itemId = itemIds[0];
    const item = itemById.get(itemId);
    if (!item || item.task_type !== input.taskType) {
      return fallbackWithWarning(input, {
        code: "HISTORICAL_ITEM_MISSING",
        itemId,
        message: "Historical source maps to a missing or task-mismatched practice item."
      });
    }
    const displayNumber = item.display_number?.trim() ?? "";
    if (!displayNumber) {
      return fallbackWithWarning(input, {
        code: "HISTORICAL_DISPLAY_NUMBER_MISSING",
        itemId,
        message: "Historical practice item has no display_number."
      });
    }
    const displayTitle = item.display_title?.trim() || null;
    const displayName = input.taskType === "build_sentence"
      ? `套题${displayNumber}`
      : `题目${displayNumber}${displayTitle ? ` ${displayTitle}` : ""}`;
    return {
      itemId,
      taskType: input.taskType,
      displayNumber,
      displayTitle,
      displayName,
      logicalDisplayName: displayName,
      rawSetId: input.rawSetId,
      rawQuestionId: input.rawQuestionId,
      isActive: Boolean(item.is_active),
      resolution: "logical",
      warning: null
    };
  }

  return { resolveBuildSentence, resolveWritingAttempt };
}

export async function loadHistoricalPracticeDisplayResolver(
  supabase: SupabaseClient,
  timing?: StudentPerformanceTrace
): Promise<HistoricalPracticeDisplayResolver> {
  const [itemsResult, sourcesResult] = await Promise.all([
    measureDatabase(timing, "historical_practice_items", () =>
      readAllSupabaseRows<HistoricalPracticeItemRow>((from, to) =>
        supabase
          .from("practice_items")
          .select("item_id,task_type,display_number,display_title,is_active")
          .in("task_type", ["build_sentence", "email", "academic_discussion"])
          .order("item_id", { ascending: true })
          .range(from, to)
      )
    ),
    measureDatabase(timing, "historical_practice_item_sources", () =>
      readAllSupabaseRows<HistoricalPracticeSourceRow>((from, to) =>
        supabase
          .from("practice_item_sources")
          .select("source_id,item_id,task_type,source_set_id,source_question_id")
          .in("task_type", ["build_sentence", "email", "academic_discussion"])
          .order("source_id", { ascending: true })
          .range(from, to)
      )
    )
  ]);
  if (itemsResult.error || sourcesResult.error) {
    const message = itemsResult.error?.message ?? sourcesResult.error?.message ?? "unknown error";
    throw new Error(`Failed to load historical practice display mappings: ${message}`);
  }
  const buildResolver = () => createHistoricalPracticeDisplayResolver({
      items: itemsResult.data ?? [],
      sources: sourcesResult.data ?? []
    });
  return timing
    ? timing.measureSync("processing", "build_historical_display_resolver", buildResolver)
    : buildResolver();
}

function measureDatabase<T>(
  timing: StudentPerformanceTrace | undefined,
  name: string,
  operation: () => Promise<T>
) {
  return timing ? timing.measure("database", name, operation) : operation();
}

export function logHistoricalPracticeDisplayWarnings(
  displays: HistoricalPracticeDisplay[]
) {
  const emitted = new Set<string>();
  for (const display of displays) {
    if (!display.warning) continue;
    const key = JSON.stringify(display.warning);
    if (emitted.has(key)) continue;
    emitted.add(key);
    console.warn("[historical-practice-display] resolution_warning", display.warning);
  }
}

export function enrichBuildSentenceHistoricalAttempts<
  T extends { setId: string; setTitle: string }
>(attempts: T[], resolver: HistoricalPracticeDisplayResolver): T[] {
  const displays = attempts.map((attempt) =>
    resolver.resolveBuildSentence({
      fallbackDisplayName: attempt.setTitle,
      rawSetId: attempt.setId
    })
  );
  logHistoricalPracticeDisplayWarnings(displays);
  return attempts.map((attempt, index) => ({
    ...attempt,
    setTitle: displays[index].displayName
  }));
}

function fallbackWithWarning(
  input: {
    fallbackDisplayName: string;
    rawQuestionId: string | null;
    rawSetId: string | null;
    taskType: "build_sentence" | "email" | "academic_discussion";
  },
  warning: Pick<HistoricalPracticeDisplayWarning, "code" | "itemId" | "message">
) {
  const structuredWarning: HistoricalPracticeDisplayWarning = {
    ...warning,
    taskType: input.taskType,
    rawSetId: input.rawSetId,
    rawQuestionId: input.rawQuestionId
  };
  return fallbackDisplay({
    displayName: input.fallbackDisplayName,
    rawQuestionId: input.rawQuestionId,
    rawSetId: input.rawSetId,
    resolution: "fallback",
    taskType: input.taskType,
    warning: structuredWarning
  });
}

function fallbackDisplay(input: {
  displayName: string;
  rawQuestionId: string | null;
  rawSetId: string | null;
  resolution: "virtual" | "assignment" | "fallback";
  taskType: "build_sentence" | "email" | "academic_discussion";
  warning: HistoricalPracticeDisplayWarning | null;
}): HistoricalPracticeDisplay {
  return {
    itemId: null,
    taskType: input.taskType,
    displayNumber: null,
    displayTitle: null,
    displayName: input.displayName,
    logicalDisplayName: null,
    rawSetId: input.rawSetId,
    rawQuestionId: input.rawQuestionId,
    isActive: null,
    resolution: input.resolution,
    warning: input.warning
  };
}

function groupSources(
  sources: HistoricalPracticeSourceRow[],
  key: (source: HistoricalPracticeSourceRow) => string
) {
  const result = new Map<string, HistoricalPracticeSourceRow[]>();
  for (const source of sources) {
    const sourceKey = key(source);
    result.set(sourceKey, [...(result.get(sourceKey) ?? []), source]);
  }
  return result;
}

function isWritingTaskType(
  taskType: PracticeTaskType
): taskType is "email" | "academic_discussion" {
  return taskType === "email" || taskType === "academic_discussion";
}

function isVirtualBuildSentenceSet(rawSetId: string) {
  const normalized = rawSetId.trim().toLowerCase();
  return normalized.startsWith("grammar-") || normalized.startsWith("wrongbook-");
}
