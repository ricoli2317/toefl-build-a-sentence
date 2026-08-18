import { isVirtualPracticeSetId } from "./studentNavigation.ts";

export type TeacherLogicalPracticeItemRow = {
  item_id: string;
  task_type: string;
  display_number: string | null;
  first_seen_date: string;
  is_active: boolean;
};

export type TeacherLogicalPracticeSourceRow = {
  source_id: string;
  item_id: string;
  task_type: string;
  source_set_id: string | null;
  is_canonical: boolean;
};

export type TeacherLogicalPracticeOccurrenceRow = {
  source_id: string;
  occurred_on: string;
};

export type TeacherLogicalPracticeAttemptRow = {
  attempt_id: string;
  student_id: string;
  set_id: string;
  correct_count: number | null;
  total_questions: number | null;
};

export type TeacherLogicalPracticeQuestionRow = {
  question_id: string;
  set_id: string;
};

export type TeacherLogicalSetSummary = {
  itemId: string;
  displayNumber: string;
  setTitle: string;
  firstSeenDate: string;
  occurrenceDates: string[];
  sourceSetIds: string[];
  questionCount: number;
  totalAttemptCount: number;
  completedStudentCount: number;
  correctCount: number;
  totalQuestions: number;
  averageAccuracy: number;
  isActive: boolean;
};

export function buildTeacherLogicalSetSummaries(input: {
  items: TeacherLogicalPracticeItemRow[];
  sources: TeacherLogicalPracticeSourceRow[];
  occurrences: TeacherLogicalPracticeOccurrenceRow[];
  attempts: TeacherLogicalPracticeAttemptRow[];
  questions: TeacherLogicalPracticeQuestionRow[];
}): TeacherLogicalSetSummary[] {
  const basItems = new Map(
    input.items
      .filter((item) => item.task_type === "build_sentence")
      .map((item) => [item.item_id, item])
  );
  const sourcesByItem = new Map<string, TeacherLogicalPracticeSourceRow[]>();
  const itemIdBySetId = new Map<string, string>();
  const itemIdBySourceId = new Map<string, string>();

  for (const source of input.sources) {
    const setId = source.source_set_id?.trim() ?? "";
    if (
      source.task_type !== "build_sentence" ||
      !basItems.has(source.item_id) ||
      !setId ||
      isVirtualPracticeSetId(setId)
    ) {
      continue;
    }
    sourcesByItem.set(source.item_id, [
      ...(sourcesByItem.get(source.item_id) ?? []),
      { ...source, source_set_id: setId }
    ]);
    itemIdBySetId.set(setId, source.item_id);
    itemIdBySourceId.set(source.source_id, source.item_id);
  }

  const occurrenceDatesByItem = new Map<string, Set<string>>();
  for (const occurrence of input.occurrences) {
    const itemId = itemIdBySourceId.get(occurrence.source_id);
    if (!itemId || !occurrence.occurred_on) continue;
    const dates = occurrenceDatesByItem.get(itemId) ?? new Set<string>();
    dates.add(occurrence.occurred_on);
    occurrenceDatesByItem.set(itemId, dates);
  }

  const questionIdsBySet = new Map<string, Set<string>>();
  for (const question of input.questions) {
    if (!itemIdBySetId.has(question.set_id)) continue;
    const ids = questionIdsBySet.get(question.set_id) ?? new Set<string>();
    ids.add(question.question_id);
    questionIdsBySet.set(question.set_id, ids);
  }

  const attemptStatsByItem = new Map<string, {
    attemptCount: number;
    correctCount: number;
    studentIds: Set<string>;
    totalQuestions: number;
  }>();
  for (const attempt of input.attempts) {
    if (isVirtualPracticeSetId(attempt.set_id)) continue;
    const itemId = itemIdBySetId.get(attempt.set_id);
    if (!itemId) continue;
    const stats = attemptStatsByItem.get(itemId) ?? {
      attemptCount: 0,
      correctCount: 0,
      studentIds: new Set<string>(),
      totalQuestions: 0
    };
    stats.attemptCount += 1;
    stats.correctCount += attempt.correct_count ?? 0;
    stats.totalQuestions += attempt.total_questions ?? 0;
    if (attempt.student_id) stats.studentIds.add(attempt.student_id);
    attemptStatsByItem.set(itemId, stats);
  }

  return Array.from(basItems.values())
    .flatMap((item): TeacherLogicalSetSummary[] => {
      const sources = sourcesByItem.get(item.item_id) ?? [];
      if (sources.length === 0) return [];
      const sourceSetIds = Array.from(new Set(
        sources.flatMap((source) => source.source_set_id ? [source.source_set_id] : [])
      )).sort((left, right) => left.localeCompare(right));
      const stats = attemptStatsByItem.get(item.item_id);
      const questionCount = sourceSetIds.reduce(
        (maximum, setId) => Math.max(maximum, questionIdsBySet.get(setId)?.size ?? 0),
        0
      );
      const displayNumber = item.display_number?.trim() ?? "";
      const correctCount = stats?.correctCount ?? 0;
      const totalQuestions = stats?.totalQuestions ?? 0;

      return [{
        itemId: item.item_id,
        displayNumber,
        setTitle: displayNumber ? `套题${displayNumber}` : "未编号套题",
        firstSeenDate: item.first_seen_date,
        occurrenceDates: Array.from(occurrenceDatesByItem.get(item.item_id) ?? [])
          .sort((left, right) => right.localeCompare(left)),
        sourceSetIds,
        questionCount,
        totalAttemptCount: stats?.attemptCount ?? 0,
        completedStudentCount: stats?.studentIds.size ?? 0,
        correctCount,
        totalQuestions,
        averageAccuracy: totalQuestions === 0 ? 0 : correctCount / totalQuestions,
        isActive: item.is_active
      }];
    })
    .sort(compareTeacherLogicalSetSummaries);
}

export function compareTeacherLogicalSetSummaries(
  left: Pick<TeacherLogicalSetSummary, "firstSeenDate" | "itemId">,
  right: Pick<TeacherLogicalSetSummary, "firstSeenDate" | "itemId">
) {
  return right.firstSeenDate.localeCompare(left.firstSeenDate) ||
    left.itemId.localeCompare(right.itemId);
}
