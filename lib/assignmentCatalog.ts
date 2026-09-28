import { READING_PRODUCT_NAMES } from "./reading/product.ts";
import { WRITING_TASK_CONFIG } from "./writing.ts";

/**
 * Shared Assignment catalog model (client + server safe).
 *
 * One Assignment Group always belongs to exactly one subject (写作 / 阅读), and
 * every item inside it keeps its own stable item type. Writing items reuse the
 * historical writing types (WE / AD) plus the Build a Sentence practice item;
 * Reading items are CTW / RDL / RAP / Full Set. The database keeps the existing
 * Assignment Group / item abstraction: only `subject` and the task_type value
 * set are extended, and the stable item identity stays the Assignment item's
 * `question_id`.
 */

export type AssignmentSubject = "writing" | "reading";

export type AssignmentItemType =
  | "email"
  | "academic_discussion"
  | "build_sentence"
  | "ctw"
  | "rdl"
  | "rap"
  | "full_set";

export type ReadingLength = "short" | "long";

export const ASSIGNMENT_SUBJECTS: readonly AssignmentSubject[] = ["writing", "reading"];

export const ASSIGNMENT_SUBJECT_LABELS: Record<AssignmentSubject, string> = {
  writing: "写作",
  reading: "阅读"
};

export const ASSIGNMENT_ITEM_CONFIG = {
  email: {
    badgeLabel: WRITING_TASK_CONFIG.email.label,
    hasLength: false,
    hasQuestionView: true,
    hasTopic: true,
    subject: "writing",
    tabLabel: "WE"
  },
  academic_discussion: {
    badgeLabel: WRITING_TASK_CONFIG.academic_discussion.label,
    hasLength: false,
    hasQuestionView: true,
    hasTopic: true,
    subject: "writing",
    tabLabel: "AD"
  },
  build_sentence: {
    badgeLabel: "Build a Sentence",
    hasLength: false,
    hasQuestionView: true,
    hasTopic: false,
    subject: "writing",
    tabLabel: "BAS"
  },
  ctw: {
    badgeLabel: READING_PRODUCT_NAMES.ctw,
    hasLength: false,
    hasQuestionView: true,
    hasTopic: true,
    subject: "reading",
    tabLabel: "CTW"
  },
  rdl: {
    badgeLabel: READING_PRODUCT_NAMES.rdl,
    hasLength: true,
    hasQuestionView: true,
    hasTopic: true,
    subject: "reading",
    tabLabel: "RDL"
  },
  rap: {
    badgeLabel: READING_PRODUCT_NAMES.rap,
    hasLength: false,
    hasQuestionView: true,
    hasTopic: true,
    subject: "reading",
    tabLabel: "RAP"
  },
  full_set: {
    badgeLabel: "Full Set",
    hasLength: false,
    hasQuestionView: false,
    hasTopic: false,
    subject: "reading",
    tabLabel: "Full Set"
  }
} satisfies Record<
  AssignmentItemType,
  {
    badgeLabel: string;
    hasLength: boolean;
    hasQuestionView: boolean;
    hasTopic: boolean;
    subject: AssignmentSubject;
    tabLabel: string;
  }
>;

export const ASSIGNMENT_ITEM_TYPES = Object.keys(
  ASSIGNMENT_ITEM_CONFIG
) as AssignmentItemType[];

export function isAssignmentSubject(value: unknown): value is AssignmentSubject {
  return value === "writing" || value === "reading";
}

export function isAssignmentItemType(value: unknown): value is AssignmentItemType {
  return typeof value === "string" && value in ASSIGNMENT_ITEM_CONFIG;
}

export function assignmentItemTypesForSubject(subject: AssignmentSubject) {
  return ASSIGNMENT_ITEM_TYPES.filter(
    (itemType) => ASSIGNMENT_ITEM_CONFIG[itemType].subject === subject
  );
}

export function assignmentItemSubject(itemType: AssignmentItemType): AssignmentSubject {
  return ASSIGNMENT_ITEM_CONFIG[itemType].subject;
}

export function assignmentItemTypeLabel(itemType: AssignmentItemType) {
  return ASSIGNMENT_ITEM_CONFIG[itemType].badgeLabel;
}

export function assignmentItemTypeTabLabel(itemType: AssignmentItemType) {
  return ASSIGNMENT_ITEM_CONFIG[itemType].tabLabel;
}

export function assignmentItemHasTopic(itemType: AssignmentItemType) {
  return ASSIGNMENT_ITEM_CONFIG[itemType].hasTopic;
}

export function assignmentItemHasLength(itemType: AssignmentItemType) {
  return ASSIGNMENT_ITEM_CONFIG[itemType].hasLength;
}

export function assignmentItemHasQuestionView(itemType: AssignmentItemType) {
  return ASSIGNMENT_ITEM_CONFIG[itemType].hasQuestionView;
}

/**
 * Lecturer-facing subject label used by automatic Assignment titles:
 * `学生姓名 / 班级名称 + 写作 / 阅读 + 日期`.
 */
export function assignmentSubjectLabel(subject: AssignmentSubject) {
  return ASSIGNMENT_SUBJECT_LABELS[subject];
}

/**
 * The lightweight row the Assignment picker filters entirely on the client:
 * stable id, item type, title, occurrence months, topic and the RDL length
 * metadata. It never carries passage / material / question bodies.
 */
export type AssignmentCatalogEntry = {
  item_id: string;
  item_type: AssignmentItemType;
  title: string;
  /** Newest occurrence month (`YYYY-MM`); empty when the source has none. */
  year_month: string;
  /** Every occurrence month, newest first; the month filter matches this list. */
  months: string[];
  catalog_category: string | null;
  reading_length: ReadingLength | null;
  /** BAS only: the raw question set used by the existing teacher结果 page. */
  source_set_id?: string | null;
};

export type AssignmentCatalogPayload = {
  subject: AssignmentSubject;
  items: AssignmentCatalogEntry[];
};

/** Stable selection key: the same item can never enter one Assignment twice. */
export function assignmentCatalogEntryKey(
  entry: Pick<AssignmentCatalogEntry, "item_id" | "item_type">
) {
  return `${entry.item_type}:${entry.item_id}`;
}

export type AssignmentCatalogSelection = ReadonlyMap<string, AssignmentCatalogEntry>;

export function toggleAssignmentCatalogSelection(
  current: AssignmentCatalogSelection,
  entry: AssignmentCatalogEntry
) {
  const key = assignmentCatalogEntryKey(entry);
  const next = new Map(current);
  if (next.has(key)) next.delete(key);
  else next.set(key, entry);
  return next;
}

/** 全选当前结果: only the currently filtered rows are added, never removed. */
export function selectAllAssignmentCatalogEntries(
  current: AssignmentCatalogSelection,
  entries: ReadonlyArray<AssignmentCatalogEntry>
) {
  const next = new Map(current);
  for (const entry of entries) next.set(assignmentCatalogEntryKey(entry), entry);
  return next;
}

/** Unchecking 全选当前结果 removes exactly the currently filtered rows. */
export function clearAssignmentCatalogEntries(
  current: AssignmentCatalogSelection,
  entries: ReadonlyArray<AssignmentCatalogEntry>
) {
  const next = new Map(current);
  for (const entry of entries) next.delete(assignmentCatalogEntryKey(entry));
  return next;
}

export function selectedAssignmentCatalogEntries(
  current: AssignmentCatalogSelection
): AssignmentCatalogEntry[] {
  return Array.from(current.values());
}

export function isAssignmentCatalogEntrySelected(
  current: AssignmentCatalogSelection,
  entry: Pick<AssignmentCatalogEntry, "item_id" | "item_type">
) {
  return current.has(assignmentCatalogEntryKey(entry));
}

export function allAssignmentCatalogEntriesSelected(
  current: AssignmentCatalogSelection,
  entries: ReadonlyArray<AssignmentCatalogEntry>
) {
  return entries.length > 0 && entries.every((entry) =>
    isAssignmentCatalogEntrySelected(current, entry)
  );
}

export function someAssignmentCatalogEntriesSelected(
  current: AssignmentCatalogSelection,
  entries: ReadonlyArray<AssignmentCatalogEntry>
) {
  return entries.some((entry) => isAssignmentCatalogEntrySelected(current, entry));
}

export type AssignmentCatalogFilters = {
  itemType: AssignmentItemType;
  /** `""` / null means 全部 (no restriction). */
  month?: string | null;
  topic?: string | null;
  length?: ReadingLength | "all" | null;
  /** Title-only search; never matches passage / question content. */
  query?: string;
};

/**
 * One shared front-end filter for every Assignment picker tab. Month, topic and
 * length are AND-combined, and the title search is AND-combined with them.
 * Dimensions that are unset (`""`, null, "all") do not restrict the result.
 */
export function filterAssignmentCatalogEntries(
  entries: ReadonlyArray<AssignmentCatalogEntry>,
  filters: AssignmentCatalogFilters
) {
  const month = filters.month?.trim() || "";
  const topic = filters.topic?.trim() || "";
  const length = filters.length && filters.length !== "all" ? filters.length : null;
  const needle = normalizeAssignmentCatalogSearch(filters.query ?? "");
  return entries.filter((entry) => {
    if (entry.item_type !== filters.itemType) return false;
    if (month && !entry.months.includes(month)) return false;
    if (topic && (entry.catalog_category ?? "") !== topic) return false;
    if (length && entry.reading_length !== length) return false;
    if (needle && !normalizeAssignmentCatalogSearch(entry.title).includes(needle)) return false;
    return true;
  });
}

export function normalizeAssignmentCatalogSearch(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, " ")
    .trim();
}

export function assignmentCatalogMonths(entries: ReadonlyArray<AssignmentCatalogEntry>) {
  return Array.from(new Set(entries.flatMap((entry) => entry.months)))
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left));
}

export function assignmentCatalogTopics(entries: ReadonlyArray<AssignmentCatalogEntry>) {
  return Array.from(new Set(
    entries.flatMap((entry) => entry.catalog_category?.trim() ? [entry.catalog_category.trim()] : [])
  )).sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function formatAssignmentCatalogMonth(monthKey: string) {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
  return `${monthKey.slice(0, 4)}年${Number(monthKey.slice(5, 7))}月`;
}

/**
 * 查看题目: every item type except Full Set reuses the existing teacher read-only
 * question page. The stable item id is the route identity; the visible row
 * number is never part of it.
 */
export function assignmentItemViewerHref(
  entry: Pick<AssignmentCatalogEntry, "item_id" | "item_type">
) {
  if (!assignmentItemHasQuestionView(entry.item_type)) return null;
  return `/teacher/question-bank/${encodeURIComponent(entry.item_id)}?taskType=${entry.item_type}`;
}

/**
 * The persisted Assignment item snapshot. It keeps the historical `set_title`
 * key the teacher list already reads and stores only lightweight catalog
 * metadata — never question / passage content.
 */
export type AssignmentItemSnapshot = {
  item_id: string;
  item_type: AssignmentItemType;
  set_title: string;
  year_month: string;
  catalog_category: string | null;
  reading_length?: ReadingLength | null;
  source_set_id?: string | null;
};

export function buildAssignmentItemSnapshot(entry: AssignmentCatalogEntry): AssignmentItemSnapshot {
  return {
    catalog_category: entry.catalog_category,
    item_id: entry.item_id,
    item_type: entry.item_type,
    reading_length: entry.reading_length,
    set_title: entry.title,
    source_set_id: entry.source_set_id ?? null,
    year_month: entry.year_month
  };
}

export function assignmentSnapshotItemType(
  snapshot: unknown,
  fallback: AssignmentItemType
): AssignmentItemType {
  if (isRecord(snapshot)) {
    const value = snapshot.item_type;
    if (isAssignmentItemType(value)) return value;
    // Historical Writing snapshots only carry the raw task type fields.
    if (value === undefined) {
      if (typeof snapshot.professor_prompt === "string") return "academic_discussion";
      if (typeof snapshot.scenario === "string") return "email";
    }
  }
  return fallback;
}

export function assignmentSnapshotItemId(
  snapshot: unknown,
  fallbackItemId: string | null
): string | null {
  if (isRecord(snapshot) && typeof snapshot.item_id === "string" && snapshot.item_id.trim()) {
    return snapshot.item_id.trim();
  }
  return fallbackItemId;
}

export function assignmentSnapshotTitle(snapshot: unknown, fallback: string) {
  if (isRecord(snapshot) && typeof snapshot.set_title === "string" && snapshot.set_title.trim()) {
    return snapshot.set_title.trim();
  }
  return fallback;
}

export function assignmentSnapshotSourceSetId(snapshot: unknown) {
  if (isRecord(snapshot) && typeof snapshot.source_set_id === "string" && snapshot.source_set_id.trim()) {
    return snapshot.source_set_id.trim();
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One shared Assignment preview fold for 写作 and 阅读: up to 5 items are always
 * shown in full, more than 5 collapse to the first 5 with a 查看剩余 N 题
 * toggle. Purely a display state — it never changes the selection or the
 * submitted payload.
 */
export const ASSIGNMENT_PREVIEW_LIMIT = 5;

export function assignmentPreviewVisibility<T>(items: ReadonlyArray<T>, expanded: boolean) {
  const visible = expanded ? [...items] : items.slice(0, ASSIGNMENT_PREVIEW_LIMIT);
  return {
    expanded,
    expandable: items.length > ASSIGNMENT_PREVIEW_LIMIT,
    remaining: Math.max(0, items.length - visible.length),
    visible
  };
}
