import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ASSIGNMENT_ITEM_TYPES,
  assignmentCatalogEntryKey,
  assignmentItemSubject,
  buildAssignmentItemSnapshot,
  isAssignmentItemType,
  type AssignmentCatalogEntry,
  type AssignmentItemSnapshot,
  type AssignmentItemType,
  type AssignmentSubject,
  type ReadingLength
} from "./assignmentCatalog.ts";
import { loadPracticeCatalogDirectory } from "./practicePublicUniverse.ts";
import type { PracticeTaskType } from "./practiceImporter/types.ts";
import { logicalPracticeItemTitle } from "./practiceLogicalCatalog.ts";
import {
  compareReadingCatalogIdentityOrder,
  readingCatalogDisplayNumbers,
  type ReadingCatalogIdentityRow
} from "./reading/catalog.ts";
import { loadReadingFullSetPickerCatalog } from "./reading/fullSets.server.ts";
import type { ReadingModule } from "./reading/types.ts";
import { readingBankItemTitle } from "./teacherReadingQuestionBank.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";

/**
 * Server-side Assignment catalog loader.
 *
 * The Assignment picker only ever needs lightweight identity rows: stable id,
 * item type, title, occurrence months, topic and the RDL length metadata. This
 * loader never selects passage / material / question bodies or the catalog
 * search index, and it reuses the exact catalog helpers the student and teacher
 * question banks already use so month, topic, title and 长短篇 judgement can
 * never drift between the two ends.
 */

type ReadingAssignmentIdentityRow = ReadingCatalogIdentityRow & {
  module: ReadingModule;
  title: string | null;
  question_count: number;
  catalog_category?: string | null;
  reading_source_occurrences?: Array<{ occurrence_id?: string; occurrence_date: string }>;
};

const WRITING_ASSIGNMENT_CATALOG_TYPES = [
  "email",
  "academic_discussion",
  "build_sentence"
] as const satisfies ReadonlyArray<PracticeTaskType>;

export async function loadTeacherAssignmentCatalog(
  db: SupabaseClient,
  subject: AssignmentSubject
): Promise<AssignmentCatalogEntry[]> {
  if (subject === "writing") {
    const groups = await Promise.all(
      WRITING_ASSIGNMENT_CATALOG_TYPES.map((taskType) => loadWritingCatalogEntries(db, taskType))
    );
    return groups.flat();
  }
  const [readingGroups, fullSets] = await Promise.all([
    Promise.all(
      (["ctw", "rdl", "rap"] as const).map((module) => loadReadingCatalogEntries(db, module))
    ),
    loadReadingFullSetPickerCatalog(db)
  ]);
  return [
    ...readingGroups.flat(),
    ...fullSets.map((fullSet) => {
      const months = assignmentOccurrenceMonths([fullSet.occurrenceDate], fullSet.occurrenceDate);
      return {
        catalog_category: null,
        item_id: fullSet.fullSetId,
        item_type: "full_set",
        months,
        reading_length: null,
        title: fullSet.title,
        year_month: months[0] ?? ""
      } satisfies AssignmentCatalogEntry;
    })
  ];
}

/**
 * One request-scoped catalog for every item type a mutation payload contains,
 * keyed by the stable selection key `item_type:item_id`. Group creation resolves
 * every item against this map, so a large Assignment never triggers per-item
 * catalog queries.
 */
export async function loadAssignmentCatalogEntryMap(
  db: SupabaseClient,
  itemTypes: ReadonlyArray<AssignmentItemType>
) {
  const subjects = Array.from(new Set(itemTypes.map(assignmentItemSubject)));
  const catalogs = await Promise.all(
    subjects.map((subject) => loadTeacherAssignmentCatalog(db, subject))
  );
  const map = new Map<string, AssignmentCatalogEntry>();
  for (const entry of catalogs.flat()) {
    map.set(`${entry.item_type}:${entry.item_id}`, entry);
  }
  return map;
}

export function findAssignmentCatalogEntry(
  entries: ReadonlyArray<AssignmentCatalogEntry>,
  itemType: AssignmentItemType,
  itemId: string
) {
  return entries.find(
    (entry) => entry.item_type === itemType && entry.item_id === itemId
  ) ?? null;
}

export async function resolveTeacherAssignmentCatalogEntry(
  db: SupabaseClient,
  itemType: AssignmentItemType,
  itemId: string
) {
  const entries = await loadTeacherAssignmentCatalog(db, assignmentItemSubject(itemType));
  return findAssignmentCatalogEntry(entries, itemType, itemId);
}

export async function resolveAssignmentItemSnapshot(
  db: SupabaseClient,
  itemType: AssignmentItemType,
  itemId: string
): Promise<AssignmentItemSnapshot> {
  const entry = await resolveTeacherAssignmentCatalogEntry(db, itemType, itemId);
  if (!entry) throw new Error("所选题目不存在或已下线。");
  return buildAssignmentItemSnapshot(entry);
}

export function assignmentItemTypesFromValues(values: unknown[]): AssignmentItemType[] {
  return Array.from(new Set(values.filter(isAssignmentItemType)));
}

export const ASSIGNMENT_CATALOG_ITEM_TYPE_ORDER = ASSIGNMENT_ITEM_TYPES;

/**
 * The teacher Assignment detail keeps the historical stored identity
 * (`question_id`) for WE / AD (the canonical raw question id) but the picker
 * and 查看题目 address the same item by its stable catalog id. This resolves
 * the stored WE / AD raw ids back to the catalog item ids so a withdrawn edit
 * can seed the exact picker selection it originally came from. BAS / Reading
 * rows already store the catalog id and are returned unchanged.
 */
export async function resolveAssignmentCatalogItemIds(
  db: SupabaseClient,
  items: ReadonlyArray<{
    itemType: AssignmentItemType;
    questionId: string | null;
    questionSource: "question_bank" | "custom";
  }>
) {
  const map = new Map<string, string>();
  const rawQuestionIds = Array.from(new Set(items.flatMap((item) =>
    item.questionSource === "question_bank"
      && item.questionId
      && isWritingTaskType(item.itemType)
      ? [item.questionId]
      : []
  )));
  for (const item of items) {
    if (item.questionSource !== "question_bank" || !item.questionId) continue;
    if (isWritingTaskType(item.itemType)) continue;
    map.set(assignmentCatalogEntryKey({ item_id: item.questionId, item_type: item.itemType }), item.questionId);
  }
  if (rawQuestionIds.length > 0) {
    const result = await db
      .from("practice_item_sources")
      .select("task_type,source_question_id,item_id")
      .in("source_question_id", rawQuestionIds);
    if (result.error) throw result.error;
    for (const row of (result.data ?? []) as Array<{
      task_type: string;
      source_question_id: string | null;
      item_id: string;
    }>) {
      if (!isWritingTaskType(row.task_type) || !row.source_question_id) continue;
      map.set(
        assignmentCatalogEntryKey({
          item_id: String(row.source_question_id),
          item_type: row.task_type
        }),
        String(row.item_id)
      );
    }
  }
  return map;
}

function isWritingTaskType(value: unknown): value is "email" | "academic_discussion" {
  return value === "email" || value === "academic_discussion";
}

async function loadWritingCatalogEntries(
  db: SupabaseClient,
  taskType: PracticeTaskType
): Promise<AssignmentCatalogEntry[]> {
  const { directory, occurrences } = await loadPracticeCatalogDirectory(db, taskType);
  const occurrenceDatesByItem = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    const itemId = directory.resolveSourceToPracticeItemId(occurrence.source_id);
    if (!itemId) continue;
    occurrenceDatesByItem.set(itemId, [
      ...(occurrenceDatesByItem.get(itemId) ?? []),
      occurrence.occurred_on
    ]);
  }
  const sourceSetIdByItem = new Map<string, string | null>();
  for (const item of directory.publicItems) {
    const canonical = directory
      .getFormalSourcesForPracticeItem(item.itemId)
      .find((source) => source.isCanonical);
    sourceSetIdByItem.set(item.itemId, canonical?.sourceSetId ?? null);
  }
  return directory.publicItems
    .filter((item) => item.taskType === taskType)
    .map((item) => {
      const months = assignmentOccurrenceMonths(
        occurrenceDatesByItem.get(item.itemId) ?? [],
        item.firstSeenDate
      );
      return {
        item_id: item.itemId,
        item_type: taskType,
        title: logicalPracticeItemTitle({
          display_number: item.displayNumber,
          display_title: item.displayTitle,
          task_type: item.taskType
        }),
        year_month: months[0] ?? "",
        months,
        catalog_category: item.catalogCategory?.trim() || null,
        reading_length: null,
        ...(taskType === "build_sentence"
          ? { source_set_id: sourceSetIdByItem.get(item.itemId) ?? null }
          : {})
      } satisfies AssignmentCatalogEntry;
    });
}

async function loadReadingCatalogEntries(
  db: SupabaseClient,
  module: ReadingModule
): Promise<AssignmentCatalogEntry[]> {
  const rows = await readReadingIdentityRows(db, module);
  const displayNumbers = readingCatalogDisplayNumbers(rows);
  return rows.map((row) => {
    const rawOccurrenceDates = (row.reading_source_occurrences ?? []).map((occurrence) =>
      String(occurrence.occurrence_date)
    );
    const months = assignmentOccurrenceMonths(rawOccurrenceDates, row.first_seen_date);
    const displayNumber = displayNumbers.get(row.logical_item_id) ?? "";
    return {
      item_id: row.logical_item_id,
      item_type: module,
      title: readingBankItemTitle({
        displayNumber,
        module: row.module,
        title: row.title
      }),
      year_month: months[0] ?? "",
      months,
      catalog_category: row.catalog_category?.trim() || null,
      reading_length: row.module === "rdl" ? readingLengthFromQuestionCount(row.question_count) : null
    } satisfies AssignmentCatalogEntry;
  });
}

/**
 * RDL 长短篇 judgement shared with the student catalog: question_count 2 = 短篇,
 * 3 = 长篇 (the same field `filterReadingCatalogByLength` uses).
 */
export function readingLengthFromQuestionCount(questionCount: unknown): ReadingLength | null {
  const count = Number(questionCount);
  if (count === 2) return "short";
  if (count === 3) return "long";
  return null;
}

async function readReadingIdentityRows(db: SupabaseClient, module: ReadingModule) {
  const result = await readAllSupabaseRows<ReadingAssignmentIdentityRow>((from, to) =>
    db
      .from("reading_logical_items")
      .select(
        "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,catalog_category,reading_source_occurrences(occurrence_id,occurrence_date)"
      )
      .eq("module", module)
      .order("first_seen_date", { ascending: true })
      .order("first_seen_source_label", { ascending: true })
      .order("first_seen_source_order", { ascending: true })
      .order("logical_item_id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: ReadingAssignmentIdentityRow[] | null;
      error: { message: string } | null;
    }>
  );
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).sort(compareReadingCatalogIdentityOrder);
}

/**
 * Occurrence months are the month filter dimension, exactly like the question
 * banks; an item without any occurrence falls back to its first-seen month.
 */
function assignmentOccurrenceMonths(rawOccurrenceDates: string[], firstSeenDate: string) {
  const months = new Set(
    rawOccurrenceDates
      .map((date) => date.slice(0, 7))
      .filter((month) => /^\d{4}-\d{2}$/.test(month))
  );
  if (months.size === 0 && /^\d{4}-\d{2}/.test(firstSeenDate)) {
    months.add(firstSeenDate.slice(0, 7));
  }
  return Array.from(months).sort((left, right) => right.localeCompare(left));
}
