import {
  buildReadingSessionGroups,
  shuffleWrongQuestionTargets,
  wrongQuestionPracticeCount,
  nextWrongQuestionHistoryAmount,
  type WrongQuestionSessionGroup
} from "../wrongQuestionBank.ts";
import { buildReadingWrongbookSessionSteps } from "./wrongbookSession.ts";
import type { ReadingAnswerState } from "./practiceState.ts";
import { STUDENT_ROUTES } from "../studentNavigation.ts";

export const READING_QUESTION_CATEGORIES = [
  "事实信息题", "否定信息题", "主旨题", "词汇题", "选句题",
  "句子简化题", "指代题", "推断题", "修辞目的题", "句子插入题"
] as const;
export type ReadingQuestionCategory = typeof READING_QUESTION_CATEGORIES[number];
export const CATEGORY_SESSION_TABLE = "reading_question_category_sessions";
export const CATEGORY_ANSWER_TABLE = "reading_question_category_session_answers";
export const CATEGORY_ROUTE = STUDENT_ROUTES.questionCategoryPractice;
export const CATEGORY_API = "/api/reading/question-category";

export type CategoryAnswer = {
  answerId: string;
  questionId: string;
  logicalItemId: string;
  answerKind: "option" | "insertion_anchor" | "sentence_selection";
  studentAnswer: string | null;
  isCorrect: boolean;
  questionTimeSeconds: number;
};
export type CategoryGroupProgress = {
  /** Active progress is a replaceable saved snapshot, NOT final submission. */
  correctPoints: number;
  totalPoints: number;
  elapsedSeconds: number;
  submittedAt: string;
  revision?: number;
};
export type CategorySession = {
  sessionId: string;
  questionCategory: ReadingQuestionCategory;
  amount: 5 | 10 | 15 | 20;
  groups: WrongQuestionSessionGroup[];
  progress: Record<string, CategoryGroupProgress>;
  status: "active" | "completed";
  elapsedSeconds: number;
  totalPoints: number;
  correctPoints: number;
  createdAt: string;
  completedAt: string | null;
  draft?: { logicalItemId?: string; workspace?: CategoryDraft; workspaces?: Record<string, CategoryDraft> };
};
export type CategorySessionPayload = { session: CategorySession; answers: CategoryAnswer[] };
export type CategoryHistoryRow = {
  session_id: string; question_category: ReadingQuestionCategory; amount: number; status: string;
  completed_at: string; elapsed_seconds: number; total_points: number; correct_points: number;
};
export type CategorySubmitPayload = CategorySessionPayload & {
  alreadySubmitted: boolean;
  completedNow: boolean;
  group: CategoryGroupProgress;
};
export type CategoryDraft = {
  answers: ReadingAnswerState;
  questionTimes: Record<string, number>;
  currentIndex: number;
  elapsedSeconds: number;
  revision?: number;
};

export function isReadingQuestionCategory(value: unknown): value is ReadingQuestionCategory {
  return typeof value === "string" && (READING_QUESTION_CATEGORIES as readonly string[]).includes(value);
}
export function categorySessionTitle(category: string) {
  return `题型分类练习·${category}`;
}
export function categoryPracticeHref(category: string, amount: number, sessionId?: string) {
  const params = new URLSearchParams({ questionCategory: category, amount: String(amount) });
  if (sessionId) params.set("session", sessionId);
  return `${CATEGORY_ROUTE}/practice?${params}`;
}
export function categoryResultHref(sessionId: string) {
  return `${CATEGORY_ROUTE}/sessions/${encodeURIComponent(sessionId)}`;
}

export function categoryWorkspace(session: CategorySession, itemId: string) {
  return session.draft?.workspaces?.[itemId]
    ?? (session.draft?.logicalItemId === itemId ? session.draft.workspace : undefined);
}

/** Snapshot seconds per source, including unsaved revisits. Seed the runner
 * once on resume; saved seconds must not be added again when a source hydrates. */
export function categorySourceElapsedSeconds(session: CategorySession) {
  return Object.fromEntries(session.groups.map((group) => [group.logicalItemId, Math.max(
    session.progress[group.logicalItemId]?.elapsedSeconds ?? 0,
    categoryWorkspace(session, group.logicalItemId)?.elapsedSeconds ?? 0
  )]));
}
export function categoryRetakeHref(session: Pick<CategorySession, "questionCategory" | "amount">) {
  return categoryPracticeHref(session.questionCategory, nextWrongQuestionHistoryAmount(session.amount));
}

/** Server-only callers supply the identity pool. No passage/options are needed. */
export function drawCategoryManifest(input: {
  questionCategory: ReadingQuestionCategory;
  amount: number;
  rows: Array<{ question_id: string; logical_item_id: string; question_order: number }>;
  titles: Map<string, string>;
}) {
  const draw = shuffleWrongQuestionTargets(input.rows)
    .slice(0, wrongQuestionPracticeCount(input.amount, input.rows.length));
  return {
    kind: "question_category",
    version: 1,
    category: input.questionCategory,
    groups: buildReadingSessionGroups({
      targets: draw.map((row) => ({ logicalItemId: row.logical_item_id, questionId: row.question_id, slotId: null })),
      questionOrderById: new Map(draw.map((row) => [row.question_id, row.question_order])),
      titles: input.titles
    })
  };
}

/** All result positions come from the frozen manifest, never from row arrival order. */
export function categoryResultAnswers(session: CategorySession, answers: CategoryAnswer[]) {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  return buildReadingWrongbookSessionSteps(session.groups).map((step) => {
    const answer = byQuestion.get(step.questionId);
    if (!answer || answer.logicalItemId !== step.group.logicalItemId) {
      throw new Error("CATEGORY_RESULT_TARGET_MISSING");
    }
    return {
      ...answer,
      isAnswered: Boolean(answer.studentAnswer?.trim()),
      order: step.globalIndex + 1,
      reviewIndex: step.globalIndex,
      groupIndex: step.groupIndex
    };
  });
}

export function categoryAnswerRows(answers: CategoryAnswer[]) {
  return answers.map((answer) => ({
    attempt_answer_id: answer.answerId,
    question_id: answer.questionId,
    slot_id: null,
    answer_kind: answer.answerKind,
    student_answer: answer.studentAnswer,
    is_correct: answer.isCorrect,
    question_time_seconds: answer.questionTimeSeconds
  }));
}
