import {
  compareReadingCatalogIdentityOrder,
  type ReadingCatalogItemRow
} from "./catalog.ts";
import { READING_PRODUCT_NAMES } from "./product.ts";
import type { ReadingModule } from "./types.ts";

export type ReadingStatsProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

export type ReadingStatsAttemptRow = {
  attempt_id: string;
  student_id: string;
  logical_item_id: string;
  task_type: ReadingModule;
  status: "draft" | "submitted";
  elapsed_seconds: number;
  total_points: number;
  correct_points: number;
  submitted_at: string | null;
};

export type ReadingStatsAnswerRow = {
  attempt_id: string;
  logical_item_id: string;
  question_id: string;
  slot_id: string | null;
  answer_kind: "ctw_slot" | "option" | "insertion_anchor" | "sentence_selection";
  is_correct: boolean;
};

export type ReadingStatsQuestionRow = {
  question_id: string;
  logical_item_id: string;
  question_order: number;
  module: ReadingModule;
  question_type: string;
};

export type ReadingStatsSlotRow = {
  question_id: string;
  slot_id: string;
  slot_order: number;
};

export type ReadingTaskPerformance = {
  completedAttempts: number;
  correctPoints: number;
  totalPoints: number;
  accuracy: number;
  totalPracticeSeconds: number;
};

export type TeacherReadingStatsPayload = {
  overview: {
    completedAttempts: number;
    studentCount: number;
    accuracy: number;
    totalPracticeSeconds: number;
  };
  students: Array<{
    studentId: string;
    displayName: string;
    account: string;
    completedAttempts: number;
    accuracy: number;
    totalPracticeSeconds: number;
    byTask: Record<ReadingModule, ReadingTaskPerformance>;
  }>;
  items: Array<{
    itemId: string;
    taskType: ReadingModule;
    taskName: string;
    displayName: string;
    attemptCount: number;
    studentCount: number;
    averageAccuracy: number;
    averageTimeSeconds: number;
  }>;
  questions: Array<{
    pointId: string;
    itemId: string;
    taskType: ReadingModule;
    taskName: string;
    itemDisplayName: string;
    typeName: string;
    displayName: string;
    attemptCount: number;
    correctCount: number;
    accuracy: number;
  }>;
};

const TASKS: ReadingModule[] = ["ctw", "rdl", "rap"];

export function buildTeacherReadingStats(input: {
  profiles: ReadingStatsProfileRow[];
  items: ReadingCatalogItemRow[];
  attempts: ReadingStatsAttemptRow[];
  answers: ReadingStatsAnswerRow[];
  questions: ReadingStatsQuestionRow[];
  slots: ReadingStatsSlotRow[];
}): TeacherReadingStatsPayload {
  const attempts = input.attempts.filter(
    (attempt): attempt is ReadingStatsAttemptRow & { submitted_at: string } =>
      attempt.status === "submitted" && Boolean(attempt.submitted_at)
  );
  const attemptById = new Map(attempts.map((attempt) => [attempt.attempt_id, attempt]));
  const answers = input.answers.filter((answer) => attemptById.has(answer.attempt_id));
  const ranks = buildDisplayRanks(input.items);
  const itemById = new Map(input.items.map((item) => [item.logical_item_id, item]));
  const questionById = new Map(input.questions.map((question) => [question.question_id, question]));
  const slotById = new Map(input.slots.map((slot) => [`${slot.question_id}:${slot.slot_id}`, slot]));

  const overviewPoints = sumPoints(attempts);
  const practicingStudentIds = new Set(attempts.map((attempt) => attempt.student_id));

  return {
    overview: {
      completedAttempts: attempts.length,
      studentCount: practicingStudentIds.size,
      accuracy: ratio(overviewPoints.correct, overviewPoints.total),
      totalPracticeSeconds: attempts.reduce((sum, attempt) => sum + safeNumber(attempt.elapsed_seconds), 0)
    },
    students: input.profiles.map((profile) => {
      const studentAttempts = attempts.filter((attempt) => attempt.student_id === profile.id);
      const points = sumPoints(studentAttempts);
      return {
        studentId: profile.id,
        displayName: profile.full_name?.trim() || profile.email?.trim() || "学生",
        account: profile.email?.trim() || "—",
        completedAttempts: studentAttempts.length,
        accuracy: ratio(points.correct, points.total),
        totalPracticeSeconds: studentAttempts.reduce((sum, attempt) => sum + safeNumber(attempt.elapsed_seconds), 0),
        byTask: Object.fromEntries(TASKS.map((taskType) => [
          taskType,
          taskPerformance(studentAttempts.filter((attempt) => attempt.task_type === taskType))
        ])) as Record<ReadingModule, ReadingTaskPerformance>
      };
    }).sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN") || left.studentId.localeCompare(right.studentId)),
    items: input.items.map((item) => {
      const itemAttempts = attempts.filter((attempt) => attempt.logical_item_id === item.logical_item_id);
      return {
        itemId: item.logical_item_id,
        taskType: item.module,
        taskName: READING_PRODUCT_NAMES[item.module],
        displayName: readingItemDisplayName(item, ranks),
        attemptCount: itemAttempts.length,
        studentCount: new Set(itemAttempts.map((attempt) => attempt.student_id)).size,
        averageAccuracy: average(itemAttempts.map(attemptAccuracy)),
        averageTimeSeconds: average(itemAttempts.map((attempt) => safeNumber(attempt.elapsed_seconds)))
      };
    }).sort((left, right) =>
      TASKS.indexOf(left.taskType) - TASKS.indexOf(right.taskType)
      || left.displayName.localeCompare(right.displayName, "zh-CN", { numeric: true })
    ),
    questions: buildQuestionStats({
      answers,
      itemById,
      questionById,
      ranks,
      slotById
    })
  };
}

function buildQuestionStats(input: {
  answers: ReadingStatsAnswerRow[];
  itemById: Map<string, ReadingCatalogItemRow>;
  questionById: Map<string, ReadingStatsQuestionRow>;
  ranks: Map<string, string>;
  slotById: Map<string, ReadingStatsSlotRow>;
}) {
  const groups = new Map<string, ReadingStatsAnswerRow[]>();
  for (const answer of input.answers) {
    const pointId = answer.answer_kind === "ctw_slot"
      ? `${answer.question_id}:${answer.slot_id ?? ""}`
      : answer.question_id;
    const group = groups.get(pointId) ?? [];
    group.push(answer);
    groups.set(pointId, group);
  }
  return Array.from(groups, ([pointId, answers]) => {
    const representative = answers[0];
    const question = input.questionById.get(representative.question_id);
    const item = input.itemById.get(representative.logical_item_id);
    if (!question || !item) throw new Error("READING_STATS_POINT_METADATA_MISSING");
    const slot = representative.slot_id
      ? input.slotById.get(`${representative.question_id}:${representative.slot_id}`)
      : null;
    const correctCount = answers.filter((answer) => answer.is_correct).length;
    return {
      pointId,
      itemId: item.logical_item_id,
      taskType: item.module,
      taskName: READING_PRODUCT_NAMES[item.module],
      itemDisplayName: readingItemDisplayName(item, input.ranks),
      typeName: naturalQuestionType(question.question_type),
      displayName: slot ? `第 ${slot.slot_order} 题` : `第 ${question.question_order} 题`,
      attemptCount: answers.length,
      correctCount,
      accuracy: ratio(correctCount, answers.length)
    };
  }).sort((left, right) =>
    TASKS.indexOf(left.taskType) - TASKS.indexOf(right.taskType)
    || left.itemDisplayName.localeCompare(right.itemDisplayName, "zh-CN", { numeric: true })
    || left.displayName.localeCompare(right.displayName, "zh-CN", { numeric: true })
    || left.pointId.localeCompare(right.pointId)
  );
}

function buildDisplayRanks(items: ReadingCatalogItemRow[]) {
  const ranks = new Map<string, string>();
  for (const taskType of TASKS) {
    items.filter((item) => item.module === taskType)
      .sort(compareReadingCatalogIdentityOrder)
      .forEach((item, index) => ranks.set(item.logical_item_id, String(index + 1).padStart(3, "0")));
  }
  return ranks;
}

function readingItemDisplayName(item: ReadingCatalogItemRow, ranks: Map<string, string>) {
  const prefix = `${item.module === "ctw" ? "套题" : "题目"}${ranks.get(item.logical_item_id) ?? "—"}`;
  return item.module === "ctw" ? prefix : `${prefix} · ${item.title?.trim() || READING_PRODUCT_NAMES[item.module]}`;
}

function naturalQuestionType(questionType: string) {
  if (questionType === "rap_sentence_insertion") return "Sentence Insertion";
  if (questionType === "rap_sentence_selection") return "Sentence Selection";
  if (questionType === "rap_multiple_choice") return "Multiple Choice";
  return questionType === "ctw" ? "Complete the Words" : "Read in Daily Life";
}

function taskPerformance(attempts: ReadingStatsAttemptRow[]): ReadingTaskPerformance {
  const points = sumPoints(attempts);
  return {
    completedAttempts: attempts.length,
    correctPoints: points.correct,
    totalPoints: points.total,
    accuracy: ratio(points.correct, points.total),
    totalPracticeSeconds: attempts.reduce((sum, attempt) => sum + safeNumber(attempt.elapsed_seconds), 0)
  };
}

function sumPoints(attempts: ReadingStatsAttemptRow[]) {
  return attempts.reduce((sum, attempt) => ({
    correct: sum.correct + safeNumber(attempt.correct_points),
    total: sum.total + safeNumber(attempt.total_points)
  }), { correct: 0, total: 0 });
}

function attemptAccuracy(attempt: ReadingStatsAttemptRow) {
  return ratio(safeNumber(attempt.correct_points), safeNumber(attempt.total_points));
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ratio(correct: number, total: number) {
  return total > 0 ? correct / total : 0;
}

function safeNumber(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
