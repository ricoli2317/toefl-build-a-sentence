import type { AssignmentSubject } from "./assignmentCatalog.ts";
import { READING_QUESTION_CATEGORIES } from "./reading/questionCategory.ts";

export type CategoryAssignmentItemType = "bas_category" | "rap_category";

export type CategoryAssignmentConfigRow = {
  category: string;
  count: number;
};

export type BasCategoryAssignmentQuestion = {
  question_id: string;
  category: string;
  question_order: number;
  set_id: string;
  set_title: string;
  prompt: string;
  sentence_template: string;
  blank_count: number;
  options_text: string;
  distractors_text: string;
};

export type RapCategoryAssignmentTarget = {
  questionId: string;
  slotId: null;
  questionCategory: string;
};

export type RapCategoryAssignmentGroup = {
  logicalItemId: string;
  title: string;
  targets: RapCategoryAssignmentTarget[];
};

export type CategoryAssignmentManifest = {
  kind: "bas_category_assignment" | "category_assignment";
  version: 1;
  item_id: string;
  item_type: CategoryAssignmentItemType;
  set_title: string;
  categorySummary: string;
  totalQuestions: number;
  categories: CategoryAssignmentConfigRow[];
  questions?: BasCategoryAssignmentQuestion[];
  groups?: RapCategoryAssignmentGroup[];
  /**
   * Teacher/result-side answer snapshot, keyed by question id. The student
   * session JSON exposes only `questions` / `groups`, never this map.
   */
  answers?: Record<string, Record<string, string | null>>;
};

export const CATEGORY_ASSIGNMENT_ITEM_TYPES: readonly CategoryAssignmentItemType[] = [
  "bas_category",
  "rap_category"
];

export const CATEGORY_ASSIGNMENT_MAX_ROWS = 50;
export const CATEGORY_ASSIGNMENT_MAX_QUESTIONS = 500;

export function isCategoryAssignmentItemType(
  value: unknown
): value is CategoryAssignmentItemType {
  return value === "bas_category" || value === "rap_category";
}

export function categoryAssignmentItemTypeForSubject(
  subject: AssignmentSubject
): CategoryAssignmentItemType {
  return subject === "writing" ? "bas_category" : "rap_category";
}

export function categoryAssignmentSubject(
  itemType: CategoryAssignmentItemType
): AssignmentSubject {
  return itemType === "bas_category" ? "writing" : "reading";
}

export function categoryAssignmentItemLabel(
  itemType: CategoryAssignmentItemType
) {
  return itemType === "bas_category"
    ? "BAS Grammar Category"
    : "RAP Question Category";
}

export function categoryAssignmentItemShortLabel(
  itemType: CategoryAssignmentItemType
) {
  return itemType === "bas_category" ? "BAS 语法分类" : "RAP 题型分类";
}

export function categoryAssignmentManifestKind(
  itemType: CategoryAssignmentItemType
) {
  return itemType === "bas_category" ? "bas_category_assignment" : "category_assignment";
}

export function categoryAssignmentConfig(
  rows: ReadonlyArray<CategoryAssignmentConfigRow>
) {
  return rows.map((row) => ({
    category: row.category.trim(),
    count: row.count
  }));
}

export function categoryAssignmentConfigEqual(
  left: ReadonlyArray<CategoryAssignmentConfigRow>,
  right: ReadonlyArray<CategoryAssignmentConfigRow>
) {
  if (left.length !== right.length) return false;
  return left.every((row, index) =>
    row.category.trim() === right[index]?.category.trim()
    && row.count === right[index]?.count
  );
}

export function categoryAssignmentTotalQuestions(
  rows: ReadonlyArray<CategoryAssignmentConfigRow>
) {
  return rows.reduce((total, row) => total + row.count, 0);
}

export function categoryAssignmentSummary(
  rows: ReadonlyArray<CategoryAssignmentConfigRow>
) {
  return rows
    .map((row) => `${row.category.trim()} ${row.count}题`)
    .join(" + ");
}

export type CategoryConfigValidation =
  | { ok: true; rows: CategoryAssignmentConfigRow[]; total: number }
  | { ok: false; error: string };

/**
 * Strict shared category config validation. The server uses it before drawing
 * questions; the form uses it for immediate feedback. It never accepts a fixed
 * 5/10/15/20 tier and never silently caps a requested count.
 */
export function validateCategoryAssignmentConfig(
  value: unknown
): CategoryConfigValidation {
  if (!Array.isArray(value) || value.length < 1) {
    return { ok: false, error: "请至少添加一个分类。" };
  }
  if (value.length > CATEGORY_ASSIGNMENT_MAX_ROWS) {
    return { ok: false, error: `一次最多选择 ${CATEGORY_ASSIGNMENT_MAX_ROWS} 个分类。` };
  }
  const rows: CategoryAssignmentConfigRow[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "分类配置格式无效。" };
    }
    const rawCategory = (raw as Record<string, unknown>).category;
    const category = typeof rawCategory === "string" ? rawCategory.trim() : "";
    const count = (raw as Record<string, unknown>).count;
    if (!category) {
      return { ok: false, error: "请选择分类。" };
    }
    if (seen.has(category)) {
      return { ok: false, error: `分类「${category}」不能重复添加。` };
    }
    if (
      typeof count !== "number"
      || !Number.isInteger(count)
      || count < 1
      || count > CATEGORY_ASSIGNMENT_MAX_QUESTIONS
    ) {
      return { ok: false, error: `分类「${category}」的题量必须是正整数。` };
    }
    seen.add(category);
    rows.push({ category, count });
  }
  const total = categoryAssignmentTotalQuestions(rows);
  if (total < 1 || total > CATEGORY_ASSIGNMENT_MAX_QUESTIONS) {
    return {
      ok: false,
      error: `题目总量必须在 1 到 ${CATEGORY_ASSIGNMENT_MAX_QUESTIONS} 之间。`
    };
  }
  return { ok: true, rows, total };
}

export function isCategoryAssignmentManifest(
  value: unknown
): value is CategoryAssignmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (
    (manifest.kind !== "bas_category_assignment"
      && manifest.kind !== "category_assignment")
    || manifest.version !== 1
    || typeof manifest.item_id !== "string"
    || !manifest.item_id.trim()
    || (manifest.item_type !== "bas_category"
      && manifest.item_type !== "rap_category")
    || typeof manifest.set_title !== "string"
    || typeof manifest.categorySummary !== "string"
    || typeof manifest.totalQuestions !== "number"
  ) {
    return false;
  }
  const config = validateCategoryAssignmentConfig(manifest.categories);
  if (!config.ok || config.total !== manifest.totalQuestions) return false;
  if (manifest.item_type === "bas_category") {
    if (manifest.kind !== "bas_category_assignment" || !Array.isArray(manifest.questions)) {
      return false;
    }
    return manifest.questions.length === manifest.totalQuestions;
  }
  if (manifest.kind !== "category_assignment" || !Array.isArray(manifest.groups)) {
    return false;
  }
  return manifest.groups.length > 0;
}

export function categoryAssignmentManifestFromSnapshot(
  value: unknown
): CategoryAssignmentManifest | null {
  return isCategoryAssignmentManifest(value) ? value : null;
}

export function categoryAssignmentConfigFromManifest(
  manifest: CategoryAssignmentManifest
) {
  return categoryAssignmentConfig(manifest.categories);
}

export function categoryAssignmentTitleFromManifest(
  manifest: Pick<CategoryAssignmentManifest, "categorySummary"> | null | undefined
) {
  return manifest?.categorySummary?.trim() || "分类练习";
}

export function categoryAssignmentSessionTitle(
  categories: ReadonlyArray<CategoryAssignmentConfigRow> | null | undefined,
  fallbackCategory?: string | null
) {
  const rows = (categories ?? []).filter((row) => row.category.trim());
  if (rows.length > 1) return "题型分类综合练习";
  if (rows.length === 1) return `题型分类练习·${rows[0].category}`;
  return `题型分类练习·${fallbackCategory?.trim() || "分类"}`;
}

export function categoryAssignmentRetakeHref(
  itemType: CategoryAssignmentItemType,
  assignmentId: string
) {
  const base = itemType === "bas_category"
    ? "/student/grammar-practice/assignment"
    : "/student/question-category-practice/assignment";
  return `${base}/${encodeURIComponent(assignmentId)}?new=1`;
}

/**
 * The category wizard always submits exactly one assignment item. Keeping this
 * check shared prevents a mixed category + normal item payload from reaching a
 * category-specific RPC.
 */
export function singleCategoryAssignmentValue(
  values: unknown[]
): Record<string, unknown> | null {
  if (values.length !== 1) return null;
  const value = values[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const itemType = row.itemType ?? row.taskType;
  return isCategoryAssignmentItemType(itemType) ? row : null;
}

export function isKnownRapCategory(value: unknown): boolean {
  return typeof value === "string"
    && (READING_QUESTION_CATEGORIES as readonly string[]).includes(value);
}
