import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dedupeGrammarQuestions,
  getGrammarTagSummaries,
  questionHasGrammarTag,
  shuffleQuestions,
  type GrammarQuestionRow
} from "./grammarPractice.ts";
import { loadGrammarQuestionPool } from "./grammarPractice.server.ts";
import {
  categoryAssignmentConfigEqual,
  categoryAssignmentManifestFromSnapshot,
  categoryAssignmentSummary,
  isCategoryAssignmentItemType,
  validateCategoryAssignmentConfig,
  type CategoryAssignmentConfigRow,
  type CategoryAssignmentItemType,
  type CategoryAssignmentManifest,
  type BasCategoryAssignmentQuestion,
  type RapCategoryAssignmentGroup
} from "./categoryAssignment.ts";
import { READING_QUESTION_CATEGORIES } from "./reading/questionCategory.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { buildReadingSessionGroups } from "./wrongQuestionBank.ts";

export type CategoryAssignmentOption = {
  category: string;
  count: number;
};

export type PreparedCategoryAssignmentItem = {
  dueAt: string | null;
  questionId: string;
  questionSnapshot: CategoryAssignmentManifest;
  questionSource: "question_bank";
  taskType: CategoryAssignmentItemType;
};

export async function loadCategoryAssignmentOptions(
  db: SupabaseClient,
  itemType: CategoryAssignmentItemType
): Promise<CategoryAssignmentOption[]> {
  if (itemType === "bas_category") {
    const pool = await loadGrammarQuestionPool(db);
    return getGrammarTagSummaries(pool)
      .filter((row) => row.questionCount > 0)
      .map((row) => ({ category: row.tag, count: row.questionCount }));
  }
  const rows = await readAllSupabaseRows<{ question_category: string }>((from, to) =>
    db
      .from("reading_questions")
      .select("question_category")
      .eq("module", "rap")
      .order("question_id", { ascending: true })
      .range(from, to)
  );
  if (rows.error) throw new Error(rows.error.message);
  const counts = new Map<string, number>();
  for (const row of rows.data ?? []) {
    const category = String(row.question_category ?? "").trim();
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return READING_QUESTION_CATEGORIES.map((category) => ({
    category,
    count: counts.get(category) ?? 0
  }));
}

export async function prepareCategoryAssignmentItem(
  db: SupabaseClient,
  value: Record<string, unknown>,
  options: { assignmentId?: string | null } = {}
): Promise<PreparedCategoryAssignmentItem> {
  const taskType = value.itemType ?? value.taskType;
  if (!isCategoryAssignmentItemType(taskType)) {
    throw new Error("请选择有效的分类作业类型。");
  }
  const config = validateCategoryAssignmentConfig(value.categories);
  if (!config.ok) throw new Error(config.error);
  const dueAt = validCategoryAssignmentDueAt(value.dueAt);
  const requestedAssignmentId = options.assignmentId?.trim() || "";

  if (requestedAssignmentId) {
    const existing = await db
      .from("writing_assignments")
      .select("assignment_id,question_id,question_snapshot")
      .eq("assignment_id", requestedAssignmentId)
      .maybeSingle();
    if (existing.error) throw existing.error;
    const manifest = categoryAssignmentManifestFromSnapshot(existing.data?.question_snapshot);
    if (
      existing.data
      && manifest
      && manifest.item_type === taskType
      && categoryAssignmentConfigEqual(manifest.categories, config.rows)
    ) {
      const answerSnapshot = await db
        .from("category_assignment_answer_snapshots")
        .select("answers")
        .eq("assignment_id", requestedAssignmentId)
        .maybeSingle();
      if (answerSnapshot.error) throw answerSnapshot.error;
      const preserved = {
        ...manifest,
        answers: (answerSnapshot.data?.answers ?? {}) as Record<
          string,
          Record<string, string | null>
        >
      };
      return {
        dueAt,
        questionId: preserved.item_id,
        questionSnapshot: preserved,
        questionSource: "question_bank",
        taskType
      };
    }
  }

  const manifest = taskType === "bas_category"
    ? await drawBasCategoryAssignmentManifest(db, config.rows, config.total)
    : await drawRapCategoryAssignmentManifest(db, config.rows, config.total);

  return {
    dueAt,
    questionId: manifest.item_id,
    questionSnapshot: manifest,
    questionSource: "question_bank",
    taskType
  };
}

export async function drawBasCategoryAssignmentManifest(
  db: SupabaseClient,
  rows: CategoryAssignmentConfigRow[],
  total: number
): Promise<CategoryAssignmentManifest> {
  const pool = await loadGrammarQuestionPool(db);
  const usedSentences = new Set<string>();
  const usedQuestionIds = new Set<string>();
  const questions: BasCategoryAssignmentQuestion[] = [];

  for (const row of rows) {
    const available = dedupeGrammarQuestions(
      pool.filter((question) =>
        questionHasGrammarTag(question, row.category)
        && !usedQuestionIds.has(String(question.question_id))
        && !usedSentences.has(normalizedFinalSentence(question))
      )
    );
    if (available.length < row.count) {
      throw new Error(
        `所选分类「${row.category}」当前可抽取 ${available.length} 题，无法满足设置的 ${row.count} 题。`
      );
    }
    const selected = shuffleQuestions(available).slice(0, row.count);
    for (const question of selected) {
      const questionId = String(question.question_id);
      const sentence = normalizedFinalSentence(question);
      usedQuestionIds.add(questionId);
      if (sentence) usedSentences.add(sentence);
      questions.push({
        blank_count: question.blank_count ?? 0,
        category: row.category,
        distractors_text: question.distractors_text ?? "",
        options_text: question.options_text ?? "",
        prompt: question.prompt ?? "",
        question_id: questionId,
        question_order: questions.length + 1,
        sentence_template: question.sentence_template ?? "",
        set_id: String(question.set_id),
        set_title: question.set_title ?? String(question.set_id)
      });
    }
  }

  if (questions.length !== total) {
    throw new Error("分类题目总数与设置不一致，请重新选择。");
  }
  const answers: Record<string, Record<string, string | null>> = {};
  const questionIds = questions.map((question) => question.question_id);
  if (questionIds.length > 0) {
    const answerResult = await db
      .from("questions")
      .select("question_id,correct_order_text,final_sentence")
      .in("question_id", questionIds);
    if (answerResult.error) throw new Error(answerResult.error.message);
    for (const row of answerResult.data ?? []) {
      const questionId = String(row.question_id);
      answers[questionId] = {
        correct_order_text: row.correct_order_text ?? null,
        final_sentence: row.final_sentence ?? null
      };
    }
  }
  const manifestId = randomUUID();
  const summary = categoryAssignmentSummary(rows);
  return {
    answers,
    categories: rows.map((row) => ({ ...row })),
    categorySummary: summary,
    item_id: manifestId,
    item_type: "bas_category",
    kind: "bas_category_assignment",
    questions,
    set_title: summary,
    totalQuestions: total,
    version: 1
  };
}

export async function drawRapCategoryAssignmentManifest(
  db: SupabaseClient,
  rows: CategoryAssignmentConfigRow[],
  total: number
): Promise<CategoryAssignmentManifest> {
  const categories = rows.map((row) => row.category);
  const result = await readAllSupabaseRows<{
    question_id: string;
    logical_item_id: string;
    question_order: number;
    question_category: string;
    correct_option_id: string | null;
    correct_anchor_id: string | null;
    correct_sentence_id: string | null;
  }>((from, to) =>
    db
      .from("reading_questions")
      .select("question_id,logical_item_id,question_order,question_category,correct_option_id,correct_anchor_id,correct_sentence_id")
      .eq("module", "rap")
      .in("question_category", categories)
      .order("question_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw new Error(result.error.message);
  const pool = result.data ?? [];
  const drawn: Array<{
    question_id: string;
    logical_item_id: string;
    question_order: number;
    question_category: string;
    correct_option_id: string | null;
    correct_anchor_id: string | null;
    correct_sentence_id: string | null;
  }> = [];
  for (const row of rows) {
    const categoryPool = pool.filter(
      (question) => question.question_category === row.category
    );
    if (categoryPool.length < row.count) {
      throw new Error(
        `所选分类「${row.category}」当前可抽取 ${categoryPool.length} 题，无法满足设置的 ${row.count} 题。`
      );
    }
    drawn.push(...shuffleQuestions(categoryPool).slice(0, row.count));
  }
  if (drawn.length !== total) {
    throw new Error("分类题目总数与设置不一致，请重新选择。");
  }

  const categoryByQuestion = new Map(
    drawn.map((question) => [question.question_id, question.question_category])
  );
  const questionOrderById = new Map(
    drawn.map((question, index) => [question.question_id, index + 1])
  );
  const titles = await loadLogicalItemTitles(
    db,
    Array.from(new Set(drawn.map((question) => question.logical_item_id)))
  );
  const groups = buildReadingSessionGroups({
    questionOrderById,
    targets: drawn.map((question) => ({
      logicalItemId: question.logical_item_id,
      questionId: question.question_id,
      slotId: null
    })),
    titles
  }).map((group) => ({
    ...group,
    targets: group.targets.map((target) => ({
      ...target,
      questionCategory: categoryByQuestion.get(target.questionId) ?? ""
    }))
  })) as RapCategoryAssignmentGroup[];

  const targetCount = groups.reduce((sum, group) => sum + group.targets.length, 0);
  if (targetCount !== total) {
    throw new Error("分类题目总数与设置不一致，请重新选择。");
  }
  const answers: Record<string, Record<string, string | null>> = {};
  for (const question of drawn) {
    answers[question.question_id] = {
      correct_anchor_id: question.correct_anchor_id,
      correct_option_id: question.correct_option_id,
      correct_sentence_id: question.correct_sentence_id
    };
  }
  const manifestId = randomUUID();
  const summary = categoryAssignmentSummary(rows);
  return {
    answers,
    categories: rows.map((row) => ({ ...row })),
    categorySummary: summary,
    groups,
    item_id: manifestId,
    item_type: "rap_category",
    kind: "category_assignment",
    set_title: summary,
    totalQuestions: total,
    version: 1
  };
}

async function loadLogicalItemTitles(db: SupabaseClient, itemIds: string[]) {
  const titles = new Map<string, string>();
  if (itemIds.length === 0) return titles;
  const result = await readAllSupabaseRows<{
    logical_item_id: string;
    title: string | null;
  }>((from, to) =>
    db
      .from("reading_logical_items")
      .select("logical_item_id,title")
      .in("logical_item_id", itemIds)
      .order("logical_item_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw new Error(result.error.message);
  for (const row of result.data ?? []) {
    titles.set(row.logical_item_id, row.title?.trim() || row.logical_item_id);
  }
  return titles;
}

function normalizedFinalSentence(question: GrammarQuestionRow) {
  return (question.final_sentence ?? "").replace(/\s+/g, " ").trim();
}

function validCategoryAssignmentDueAt(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("截止时间格式无效。");
  }
  return new Date(value).toISOString();
}
