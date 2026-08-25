import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "../supabasePagination.ts";
import { generateAcademicDiscussionTitle } from "./adTitle.ts";
import { generateLogicalWritingTitle } from "./logicalTitle.ts";
import {
  classifyAcademicDiscussion,
  classifyBuildSentence,
  classifyEmail
} from "./classification.ts";
import {
  mapMergedBuildSentenceQuestions,
  mapNewBuildSentenceQuestions
} from "./buildSentenceMap.ts";
import {
  academicDiscussionFingerprint,
  buildSentenceSetFingerprint,
  emailFingerprint
} from "./normalization.ts";
import type {
  AcademicDiscussionIdentityInput,
  BuildSentenceMapRow,
  BuildSentenceQuestionInput,
  ClassificationResult,
  EmailIdentityInput,
  LogicalCandidate,
  NumberingReconciliationItem,
  PracticeOccurrence,
  PracticeTaskType
} from "./types.ts";

export const PRACTICE_IMPORT_NORMALIZATION_VERSION = 3;

type SourceRow = {
  source_id: string;
  item_id: string;
  task_type: PracticeTaskType;
  source_set_id: string | null;
  source_question_id: string | null;
  is_canonical: boolean;
};

type MapRow = {
  source_id: string;
  source_question_id: string;
  logical_question_order: number;
};

type FinalizeResult = {
  item_id: string;
  source_id: string;
  created_item: boolean;
  created_source: boolean;
  occurrences_inserted: number;
  first_seen_before: string;
  first_seen_after: string;
};

export type LogicalImportOutcome = {
  classification: ClassificationResult["classification"] | "ALREADY_SYNCED";
  createdItem: boolean;
  createdSource: boolean;
  occurrenceInsertedCount: number;
  reviewCreated: boolean;
  itemId: string | null;
  numberingReconciliation: NumberingReconciliationItem | null;
};

export type BuildSentenceCatalog = {
  candidates: Array<
    LogicalCandidate<BuildSentenceQuestionInput[]> & {
      logicalOrderByQuestionId: Map<string, number>;
    }
  >;
  sourceIdentities: Set<string>;
};

export type WritingCatalog<T> = {
  candidates: Array<LogicalCandidate<T>>;
  sourceIdentities: Set<string>;
};

export async function loadBuildSentenceCatalog(supabase: SupabaseClient): Promise<BuildSentenceCatalog> {
  const [sources, questions, maps] = await Promise.all([
    readRows<SourceRow>(supabase, "practice_item_sources", "source_id,item_id,task_type,source_set_id,source_question_id,is_canonical", "build_sentence"),
    readRows<Record<string, unknown>>(supabase, "questions", "question_id,set_id,question_order,sentence_template,blank_count,correct_order_text,options_text,distractors_text,final_sentence"),
    readRows<MapRow>(supabase, "practice_item_question_map", "source_id,source_question_id,logical_question_order")
  ]);
  const questionsBySet = groupBuildSentenceQuestions(questions);
  const mapsBySource = new Map<string, Map<string, number>>();
  for (const row of maps) {
    const current = mapsBySource.get(row.source_id) ?? new Map<string, number>();
    current.set(row.source_question_id, Number(row.logical_question_order));
    mapsBySource.set(row.source_id, current);
  }

  const candidates = sources
    .filter((source) => source.is_canonical && source.source_set_id)
    .map((source) => ({
      itemId: source.item_id,
      content: questionsBySet.get(String(source.source_set_id)) ?? [],
      logicalOrderByQuestionId: mapsBySource.get(source.source_id) ?? new Map<string, number>()
    }))
    .filter(({ content, logicalOrderByQuestionId }) => content.length === 10 && logicalOrderByQuestionId.size === 10);

  return {
    candidates,
    sourceIdentities: new Set(
      sources.flatMap((source) => (source.source_set_id ? [source.source_set_id] : []))
    )
  };
}

export async function loadEmailCatalog(supabase: SupabaseClient): Promise<WritingCatalog<EmailIdentityInput>> {
  const [sources, questions] = await Promise.all([
    readRows<SourceRow>(supabase, "practice_item_sources", "source_id,item_id,task_type,source_set_id,source_question_id,is_canonical", "email"),
    readRows<Record<string, unknown>>(supabase, "email_questions", "question_id,scenario,task_instruction,requirement_1,requirement_2,requirement_3,recipient")
  ]);
  const byId = new Map(questions.map((row) => [String(row.question_id), emailInput(row)]));
  return writingCatalog(sources, byId);
}

export async function loadAcademicDiscussionCatalog(
  supabase: SupabaseClient
): Promise<WritingCatalog<AcademicDiscussionIdentityInput>> {
  const [sources, questions] = await Promise.all([
    readRows<SourceRow>(supabase, "practice_item_sources", "source_id,item_id,task_type,source_set_id,source_question_id,is_canonical", "academic_discussion"),
    readRows<Record<string, unknown>>(supabase, "academic_discussion_questions", "question_id,professor_prompt,student_1_response,student_2_response")
  ]);
  const byId = new Map(
    questions.map((row) => [String(row.question_id), academicDiscussionInput(row)])
  );
  return writingCatalog(sources, byId);
}

export async function syncBuildSentenceLogicalSource(input: {
  catalog: BuildSentenceCatalog;
  occurrences: PracticeOccurrence[];
  questions: BuildSentenceQuestionInput[];
  setId: string;
  supabase: SupabaseClient;
}) {
  const fingerprint = buildSentenceSetFingerprint(input.questions);
  const alreadySynced = input.catalog.sourceIdentities.has(input.setId);
  let classification = alreadySynced
    ? ({ classification: "AUTO_MERGE", candidateItemId: null, similaritySummary: { alreadySynced: true } } satisfies ClassificationResult)
    : classifyBuildSentence(input.questions, input.catalog.candidates);
  let questionMap: BuildSentenceMapRow[];

  if (alreadySynced) {
    questionMap = mapNewBuildSentenceQuestions(input.questions);
  } else if (classification.classification === "AUTO_MERGE") {
    const candidate = input.catalog.candidates.find(
      ({ itemId }) => itemId === classification.candidateItemId
    );
    if (!candidate) throw new Error("BAS exact candidate is unavailable");
    try {
      questionMap = mapMergedBuildSentenceQuestions(
        input.questions,
        candidate.content,
        candidate.logicalOrderByQuestionId
      );
    } catch (error) {
      classification = {
        classification: "NEEDS_REVIEW",
        candidateItemId: candidate.itemId,
        similaritySummary: {
          ...classification.similaritySummary,
          reason: error instanceof Error ? error.message : "BAS mapping is ambiguous"
        }
      };
      questionMap = [];
    }
  } else {
    questionMap = classification.classification === "NEW_ITEM"
      ? mapNewBuildSentenceQuestions(input.questions)
      : [];
  }

  if (classification.classification === "NEEDS_REVIEW") {
    const reviewCreated = await queueReview(input.supabase, {
      taskType: "build_sentence",
      sourceSetId: input.setId,
      sourceQuestionId: null,
      classification,
      fingerprint,
      normalizationVersion: PRACTICE_IMPORT_NORMALIZATION_VERSION,
      occurrences: input.occurrences
    });
    return pendingOutcome(reviewCreated);
  }

  const finalized = await finalize(input.supabase, {
    taskType: "build_sentence",
    classification: classification.classification,
    sourceSetId: input.setId,
    sourceQuestionId: null,
    candidateItemId: classification.candidateItemId,
    fingerprint,
    normalizationVersion: PRACTICE_IMPORT_NORMALIZATION_VERSION,
    firstSeenDate: firstOccurrenceDate(input.occurrences),
    displayTitle: null,
    occurrences: input.occurrences,
    questionMap
  });
  input.catalog.sourceIdentities.add(input.setId);
  if (finalized.created_item) {
    input.catalog.candidates.push({
      itemId: finalized.item_id,
      content: input.questions,
      logicalOrderByQuestionId: new Map(
        questionMap.map((row) => [row.sourceQuestionId, row.logicalQuestionOrder])
      )
    });
  }
  return finalizedOutcome(finalized, alreadySynced ? "ALREADY_SYNCED" : classification.classification);
}

export async function syncEmailLogicalSource(input: {
  catalog: WritingCatalog<EmailIdentityInput>;
  content: EmailIdentityInput;
  occurrences: PracticeOccurrence[];
  questionId: string;
  setId: string;
  subject: string;
  supabase: SupabaseClient;
  titleGenerator?: (subject: string) => Promise<string>;
}) {
  const fingerprint = emailFingerprint(input.content);
  const alreadySynced = input.catalog.sourceIdentities.has(input.questionId);
  const classification = alreadySynced
    ? ({ classification: "AUTO_MERGE", candidateItemId: null, similaritySummary: { alreadySynced: true } } satisfies ClassificationResult)
    : classifyEmail(input.content, input.catalog.candidates);
  const displayTitle =
    classification.classification === "NEW_ITEM"
      ? await (input.titleGenerator ?? ((subject) => generateLogicalWritingTitle(subject, "email")))(input.subject)
      : null;
  return syncWritingSource({
    ...input,
    alreadySynced,
    classification,
    displayTitle,
    fingerprint,
    normalizationVersion: PRACTICE_IMPORT_NORMALIZATION_VERSION,
    taskType: "email"
  });
}

export async function syncAcademicDiscussionLogicalSource(input: {
  catalog: WritingCatalog<AcademicDiscussionIdentityInput>;
  content: AcademicDiscussionIdentityInput;
  occurrences: PracticeOccurrence[];
  professorPrompt: string;
  questionId: string;
  setId: string;
  supabase: SupabaseClient;
  titleGenerator?: (prompt: string) => Promise<string>;
}) {
  const fingerprint = academicDiscussionFingerprint(input.content);
  const alreadySynced = input.catalog.sourceIdentities.has(input.questionId);
  const classification = alreadySynced
    ? ({ classification: "AUTO_MERGE", candidateItemId: null, similaritySummary: { alreadySynced: true } } satisfies ClassificationResult)
    : classifyAcademicDiscussion(input.content, input.catalog.candidates);
  const displayTitle =
    classification.classification === "NEW_ITEM"
      ? await (input.titleGenerator ?? generateAcademicDiscussionTitle)(input.professorPrompt)
      : null;
  return syncWritingSource({
    ...input,
    alreadySynced,
    classification,
    displayTitle,
    fingerprint,
    normalizationVersion: PRACTICE_IMPORT_NORMALIZATION_VERSION,
    taskType: "academic_discussion"
  });
}

export async function reconcilePracticeItemNumbers(
  supabase: SupabaseClient,
  taskType: PracticeTaskType,
  items: NumberingReconciliationItem[]
) {
  const deduplicated = new Map<string, NumberingReconciliationItem>();
  for (const item of items) {
    const current = deduplicated.get(item.itemId);
    if (!current || item.reason === "earlier_duplicate_occurrence") {
      deduplicated.set(item.itemId, item);
    }
  }
  if (deduplicated.size === 0) return 0;

  const { data, error } = await supabase.rpc("reconcile_practice_item_numbers_v2", {
    p_task_type: taskType,
    p_affected_items: Array.from(deduplicated.values()).map((item) => ({
      item_id: item.itemId,
      reason: item.reason
    }))
  });
  if (error) throw Object.assign(error, { operation: "reconcile logical practice numbers" });
  return Number((data as { changes?: number } | null)?.changes) || 0;
}

async function syncWritingSource<T>(input: {
  alreadySynced: boolean;
  catalog: WritingCatalog<T>;
  classification: ClassificationResult;
  content: T;
  displayTitle: string | null;
  fingerprint: string;
  normalizationVersion: number;
  occurrences: PracticeOccurrence[];
  questionId: string;
  setId: string;
  supabase: SupabaseClient;
  taskType: "email" | "academic_discussion";
}) {
  if (input.classification.classification === "NEEDS_REVIEW") {
    const reviewCreated = await queueReview(input.supabase, {
      taskType: input.taskType,
      sourceSetId: null,
      sourceQuestionId: input.questionId,
      classification: input.classification,
      fingerprint: input.fingerprint,
      normalizationVersion: input.normalizationVersion,
      occurrences: input.occurrences
    });
    return pendingOutcome(reviewCreated);
  }

  const finalized = await finalize(input.supabase, {
    taskType: input.taskType,
    classification: input.classification.classification,
    sourceSetId: input.setId,
    sourceQuestionId: input.questionId,
    candidateItemId: input.classification.candidateItemId,
    fingerprint: input.fingerprint,
    normalizationVersion: input.normalizationVersion,
    firstSeenDate: firstOccurrenceDate(input.occurrences),
    displayTitle: input.displayTitle,
    occurrences: input.occurrences,
    questionMap: []
  });
  input.catalog.sourceIdentities.add(input.questionId);
  if (finalized.created_item) {
    input.catalog.candidates.push({ itemId: finalized.item_id, content: input.content });
  }
  return finalizedOutcome(
    finalized,
    input.alreadySynced ? "ALREADY_SYNCED" : input.classification.classification
  );
}

async function finalize(
  supabase: SupabaseClient,
  input: {
    taskType: PracticeTaskType;
    classification: "AUTO_MERGE" | "NEW_ITEM";
    sourceSetId: string | null;
    sourceQuestionId: string | null;
    candidateItemId: string | null;
    fingerprint: string;
    normalizationVersion: number;
    firstSeenDate: string;
    displayTitle: string | null;
    occurrences: PracticeOccurrence[];
    questionMap: BuildSentenceMapRow[];
  }
) {
  const { data, error } = await supabase.rpc("finalize_practice_import_v2", {
    p_task_type: input.taskType,
    p_classification: input.classification,
    p_source_set_id: input.sourceSetId,
    p_source_question_id: input.sourceQuestionId,
    p_candidate_item_id: input.candidateItemId,
    p_content_fingerprint: input.fingerprint,
    p_normalization_version: input.normalizationVersion,
    p_first_seen_date: input.firstSeenDate,
    p_display_title: input.displayTitle,
    p_occurrences: input.occurrences.map((occurrence) => ({
      occurred_on: occurrence.occurredOn,
      source_label: occurrence.sourceLabel
    })),
    p_question_map: input.questionMap.map((row) => ({
      source_question_id: row.sourceQuestionId,
      source_question_order: row.sourceQuestionOrder,
      logical_question_order: row.logicalQuestionOrder,
      question_fingerprint: row.questionFingerprint
    }))
  });
  if (error) throw Object.assign(error, { operation: "finalize logical practice import" });
  return data as FinalizeResult;
}

async function queueReview(
  supabase: SupabaseClient,
  input: {
    taskType: PracticeTaskType;
    sourceSetId: string | null;
    sourceQuestionId: string | null;
    classification: ClassificationResult;
    fingerprint: string;
    normalizationVersion: number;
    occurrences: PracticeOccurrence[];
  }
) {
  const candidateIds = Array.isArray(input.classification.similaritySummary.candidateItemIds)
    ? input.classification.similaritySummary.candidateItemIds
    : input.classification.candidateItemId
      ? [input.classification.candidateItemId]
      : [];
  const { data, error } = await supabase.rpc("queue_practice_import_review_v2", {
    p_task_type: input.taskType,
    p_source_set_id: input.sourceSetId,
    p_source_question_id: input.sourceQuestionId,
    p_candidate_item_id: input.classification.candidateItemId,
    p_candidate_item_ids: candidateIds,
    p_similarity_summary: input.classification.similaritySummary,
    p_occurrences: input.occurrences.map((occurrence) => ({
      occurred_on: occurrence.occurredOn,
      source_label: occurrence.sourceLabel
    })),
    p_content_fingerprint: input.fingerprint,
    p_normalization_version: input.normalizationVersion
  });
  if (error) throw Object.assign(error, { operation: "queue logical import review" });
  return Boolean((data as { created?: boolean } | null)?.created);
}

async function readRows<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  taskType?: PracticeTaskType
) {
  const result = await readAllSupabaseRows<T>((from, to) => {
    const orderColumn =
      table === "practice_item_sources"
        ? "source_id"
        : table === "practice_item_question_map"
          ? "map_id"
          : "question_id";
    let query = supabase.from(table).select(columns).order(orderColumn, { ascending: true });
    if (taskType) query = query.eq("task_type", taskType);
    return query.range(from, to) as PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  });
  if (result.error) throw Object.assign(result.error, { operation: `load ${table} catalog` });
  return result.data ?? [];
}

function writingCatalog<T>(sources: SourceRow[], byId: Map<string, T>): WritingCatalog<T> {
  return {
    candidates: sources.flatMap((source) => {
      const content = source.source_question_id ? byId.get(source.source_question_id) : undefined;
      return source.is_canonical && content ? [{ itemId: source.item_id, content }] : [];
    }),
    sourceIdentities: new Set(
      sources.flatMap((source) => (source.source_question_id ? [source.source_question_id] : []))
    )
  };
}

function groupBuildSentenceQuestions(rows: Array<Record<string, unknown>>) {
  const grouped = new Map<string, BuildSentenceQuestionInput[]>();
  for (const row of rows) {
    const setId = String(row.set_id);
    grouped.set(setId, [...(grouped.get(setId) ?? []), buildSentenceInput(row)]);
  }
  return grouped;
}

export function buildSentenceInput(row: Record<string, unknown>): BuildSentenceQuestionInput {
  return {
    questionId: String(row.question_id),
    questionOrder: Number(row.question_order),
    sentenceTemplate: String(row.sentence_template),
    blankCount: Number(row.blank_count),
    correctOrderText: String(row.correct_order_text),
    optionsText: String(row.options_text),
    distractorsText: String(row.distractors_text),
    finalSentence: String(row.final_sentence)
  };
}

export function emailInput(row: Record<string, unknown>): EmailIdentityInput {
  return {
    scenario: String(row.scenario),
    taskInstruction: String(row.task_instruction),
    requirements: [
      String(row.requirement_1),
      String(row.requirement_2),
      String(row.requirement_3)
    ],
    recipient: String(row.recipient)
  };
}

export function academicDiscussionInput(
  row: Record<string, unknown>
): AcademicDiscussionIdentityInput {
  return {
    professorPrompt: String(row.professor_prompt),
    studentResponses: [String(row.student_1_response), String(row.student_2_response)]
  };
}

function firstOccurrenceDate(occurrences: PracticeOccurrence[]) {
  return occurrences.reduce(
    (earliest, occurrence) => (occurrence.occurredOn < earliest ? occurrence.occurredOn : earliest),
    occurrences[0].occurredOn
  );
}

function pendingOutcome(reviewCreated: boolean): LogicalImportOutcome {
  return {
    classification: "NEEDS_REVIEW",
    createdItem: false,
    createdSource: false,
    occurrenceInsertedCount: 0,
    reviewCreated,
    itemId: null,
    numberingReconciliation: null
  };
}

function finalizedOutcome(
  result: FinalizeResult,
  classification: LogicalImportOutcome["classification"]
): LogicalImportOutcome {
  return {
    classification,
    createdItem: result.created_item,
    createdSource: result.created_source,
    occurrenceInsertedCount: Number(result.occurrences_inserted) || 0,
    reviewCreated: false,
    itemId: result.item_id,
    numberingReconciliation: result.created_item
      ? { itemId: result.item_id, reason: "historical_new_item_insert" }
      : result.first_seen_before && result.first_seen_after < result.first_seen_before
        ? { itemId: result.item_id, reason: "earlier_duplicate_occurrence" }
        : null
  };
}
