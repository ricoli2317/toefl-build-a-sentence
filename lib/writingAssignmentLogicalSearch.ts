import type { WritingQuestion, WritingTaskType } from "./writing.ts";
import { compareDisplayNumbers } from "./practiceImporter/numbering.ts";

export type WritingSearchPracticeItem = {
  item_id: string;
  task_type: WritingTaskType;
  display_number: string;
  display_title: string | null;
  first_seen_date: string;
  is_active: boolean;
};

export type WritingSearchPracticeSource = {
  item_id: string;
  task_type: WritingTaskType;
  source_question_id: string | null;
  is_canonical: boolean;
};

export type LogicalWritingQuestionSearchResult = WritingQuestion & {
  logical_item_id: string;
  logical_display_number: string;
  logical_display_title: string | null;
  logical_display_name: string;
  logical_first_seen_date: string;
};

export function matchedLogicalWritingItemIds(input: {
  matchedRawQuestionIds: string[];
  sources: WritingSearchPracticeSource[];
  taskType: WritingTaskType;
}) {
  const matched = new Set(input.matchedRawQuestionIds);
  return new Set(
    input.sources.flatMap((source) =>
      source.task_type === input.taskType &&
      source.source_question_id &&
      matched.has(source.source_question_id)
        ? [source.item_id]
        : []
    )
  );
}

export function buildLogicalWritingQuestionSearchResults(input: {
  canonicalQuestions: WritingQuestion[];
  items: WritingSearchPracticeItem[];
  matchedItemIds: Set<string>;
  sources: WritingSearchPracticeSource[];
  taskType: WritingTaskType;
}) {
  const questionById = new Map(
    input.canonicalQuestions.map((question) => [question.question_id, question])
  );
  const canonicalQuestionIdByItem = new Map<string, string>();
  for (const source of input.sources) {
    if (
      source.task_type === input.taskType &&
      source.is_canonical &&
      source.source_question_id
    ) {
      canonicalQuestionIdByItem.set(source.item_id, source.source_question_id);
    }
  }

  return input.items
    .flatMap((item): LogicalWritingQuestionSearchResult[] => {
      if (
        item.task_type !== input.taskType ||
        !item.is_active ||
        !input.matchedItemIds.has(item.item_id) ||
        !item.display_number.trim()
      ) {
        return [];
      }
      const canonicalQuestionId = canonicalQuestionIdByItem.get(item.item_id);
      const question = canonicalQuestionId
        ? questionById.get(canonicalQuestionId)
        : undefined;
      if (!question) return [];
      const displayTitle = item.display_title?.trim() || null;
      return [{
        ...question,
        logical_item_id: item.item_id,
        logical_display_number: item.display_number,
        logical_display_title: displayTitle,
        logical_display_name: `题目${item.display_number}${displayTitle ? ` ${displayTitle}` : ""}`,
        logical_first_seen_date: item.first_seen_date
      }];
    })
    .sort(
      (left, right) =>
        right.logical_first_seen_date.localeCompare(left.logical_first_seen_date) ||
        compareDisplayNumbers(
          right.logical_display_number,
          left.logical_display_number
        ) ||
        left.logical_item_id.localeCompare(right.logical_item_id)
    );
}
