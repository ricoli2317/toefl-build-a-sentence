import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "../supabasePagination.ts";
import {
  buildReadingFullSetCatalog,
  buildReadingFullSets,
  findValidReadingFullSet,
  type ReadingFullSet,
  type ReadingFullSetCatalogAttemptRow,
  type ReadingFullSetCatalogItem,
  type ReadingFullSetOccurrenceInput
} from "./fullSets.ts";
import type { ReadingModule, ReadingTestModule } from "./types.ts";

type ReadingFullSetOccurrenceRow = {
  occurrence_id: string;
  logical_item_id: string;
  source_label: string;
  occurrence_date: string;
  source_module: string;
  source_order: number;
  source_question_start: number;
  source_question_end: number;
  reading_logical_items:
    | { module: string; scored_item_count: number }
    | Array<{ module: string; scored_item_count: number }>;
};

type ReadingFullSetCatalogAnchorRow = Pick<
  ReadingFullSetOccurrenceRow,
  "occurrence_id" | "occurrence_date" | "source_label"
>;

export const READING_FULL_SET_CATALOG_PAGE_SIZE = 10;

export type ReadingFullSetCatalogPage = {
  fullSets: ReadingFullSetCatalogItem[];
  limit: typeof READING_FULL_SET_CATALOG_PAGE_SIZE;
  page: number;
  total: number;
};

/**
 * Loads only the requested catalog page. A valid Full Set has exactly one M1
 * occurrence beginning at question 1, so that row is the stable page anchor.
 * Full validation still runs against the occurrences fetched for those anchors.
 */
export async function loadReadingFullSetCatalogPage(
  db: SupabaseClient,
  input: { page: number; studentId: string }
): Promise<ReadingFullSetCatalogPage> {
  const from = (input.page - 1) * READING_FULL_SET_CATALOG_PAGE_SIZE;
  const anchorResult = await db.from("reading_source_occurrences")
    .select("occurrence_id,occurrence_date,source_label", { count: "exact" })
    .eq("source_module", "m1")
    .eq("source_question_start", 1)
    .order("occurrence_date", { ascending: false })
    .order("source_label", { ascending: true })
    .order("occurrence_id", { ascending: true })
    .range(from, from + READING_FULL_SET_CATALOG_PAGE_SIZE - 1);
  if (anchorResult.error) {
    throw new Error(`read Reading Full Set catalog anchors: ${anchorResult.error.message}`);
  }

  const anchors = (anchorResult.data ?? []) as ReadingFullSetCatalogAnchorRow[];
  if (anchors.length === 0) {
    return {
      fullSets: [],
      limit: READING_FULL_SET_CATALOG_PAGE_SIZE,
      page: input.page,
      total: anchorResult.count ?? 0
    };
  }

  const occurrenceResult = await loadReadingFullSetCatalogOccurrenceRows(db, anchors);
  if (occurrenceResult.error) {
    throw new Error(`read Reading Full Set catalog page: ${occurrenceResult.error.message}`);
  }
  const pageDefinitions = buildReadingFullSets(
    (occurrenceResult.data ?? []).map(readingFullSetOccurrenceInput)
  );
  const orderedDefinitions = anchors.flatMap((anchor) => {
    const match = pageDefinitions.find((fullSet) =>
      fullSet.occurrenceDate === anchor.occurrence_date
      && fullSet.sourceLabel === anchor.source_label
    );
    return match ? [match] : [];
  });
  const fullSetIds = orderedDefinitions.flatMap((fullSet) =>
    fullSet.validation.valid && fullSet.fullSetId ? [fullSet.fullSetId] : []
  );
  let attempts: ReadingFullSetCatalogAttemptRow[] = [];
  if (fullSetIds.length > 0) {
    const attemptsResult = await db.from("reading_full_set_attempts")
      .select("attempt_id,full_set_id,status,completed_at,created_at")
      .eq("student_id", input.studentId)
      .in("full_set_id", fullSetIds);
    if (attemptsResult.error) {
      throw new Error(`read Reading Full Set catalog attempts: ${attemptsResult.error.message}`);
    }
    attempts = (attemptsResult.data ?? []) as ReadingFullSetCatalogAttemptRow[];
  }

  return {
    fullSets: buildReadingFullSetCatalog(orderedDefinitions, attempts),
    limit: READING_FULL_SET_CATALOG_PAGE_SIZE,
    page: input.page,
    total: anchorResult.count ?? 0
  };
}

export async function loadReadingFullSets(db: SupabaseClient) {
  const result = await loadReadingFullSetOccurrenceRows(db);
  if (result.error) throw new Error(`read Reading Full Set occurrences: ${result.error.message}`);
  return buildReadingFullSets((result.data ?? []).map(readingFullSetOccurrenceInput));
}

/** Runtime attempt paths should resolve only the requested date, not rebuild the catalog. */
export async function loadReadingFullSet(
  db: SupabaseClient,
  fullSetId: string
): Promise<ReadingFullSet | null> {
  const occurrenceDate = readingFullSetOccurrenceDate(fullSetId);
  if (!occurrenceDate) return null;
  const result = await loadReadingFullSetOccurrenceRows(db, occurrenceDate);
  if (result.error) throw new Error(`read Reading Full Set definition: ${result.error.message}`);
  return findValidReadingFullSet(
    buildReadingFullSets((result.data ?? []).map(readingFullSetOccurrenceInput)),
    fullSetId
  );
}

function loadReadingFullSetOccurrenceRows(db: SupabaseClient, occurrenceDate?: string) {
  return readAllSupabaseRows<ReadingFullSetOccurrenceRow>(async (from, to) => {
    let query = db.from("reading_source_occurrences")
      .select(FULL_SET_OCCURRENCE_SELECT)
      .order("occurrence_date", { ascending: true })
      .order("source_label", { ascending: true })
      .order("source_module", { ascending: true })
      .order("source_order", { ascending: true });
    if (occurrenceDate) query = query.eq("occurrence_date", occurrenceDate);
    const page = await query.order("occurrence_id", { ascending: true }).range(from, to);
    return {
      data: page.data as unknown as ReadingFullSetOccurrenceRow[] | null,
      error: page.error
    };
  });
}

function loadReadingFullSetCatalogOccurrenceRows(
  db: SupabaseClient,
  anchors: ReadingFullSetCatalogAnchorRow[]
) {
  const identityFilter = anchors.map((anchor) =>
    `and(occurrence_date.eq.${catalogFilterValue(anchor.occurrence_date)},source_label.eq.${catalogFilterValue(anchor.source_label)})`
  ).join(",");
  return db.from("reading_source_occurrences")
    .select(FULL_SET_OCCURRENCE_SELECT)
    .or(identityFilter)
    .order("occurrence_date", { ascending: false })
    .order("source_label", { ascending: true })
    .order("source_module", { ascending: true })
    .order("source_order", { ascending: true })
    .order("occurrence_id", { ascending: true }) as unknown as PromiseLike<{
      data: ReadingFullSetOccurrenceRow[] | null;
      error: { message: string } | null;
    }>;
}

function catalogFilterValue(value: string) {
  if (!/^[A-Za-z0-9.-]+$/.test(value)) {
    throw new Error("Reading Full Set catalog identity contains an unsafe filter value");
  }
  return value;
}

const FULL_SET_OCCURRENCE_SELECT = [
  "occurrence_id",
  "logical_item_id",
  "source_label",
  "occurrence_date",
  "source_module",
  "source_order",
  "source_question_start",
  "source_question_end",
  "reading_logical_items!inner(module,scored_item_count)"
].join(",");

function readingFullSetOccurrenceDate(fullSetId: string) {
  const match = /^(\d{4})(\d{2})(\d{2})[A-Za-z]*$/.exec(fullSetId);
  if (!match) return null;
  const value = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function readingFullSetOccurrenceInput(row: ReadingFullSetOccurrenceRow): ReadingFullSetOccurrenceInput {
  const logicalItem = Array.isArray(row.reading_logical_items)
    ? row.reading_logical_items[0]
    : row.reading_logical_items;
  if (!logicalItem || !isReadingModule(logicalItem.module)) {
    throw new Error(`Reading occurrence ${row.occurrence_id} has an invalid logical item module`);
  }
  if (!isReadingTestModule(row.source_module)) {
    throw new Error(`Reading occurrence ${row.occurrence_id} has an invalid source module`);
  }
  return {
    occurrenceId: String(row.occurrence_id),
    logicalItemId: String(row.logical_item_id),
    taskType: logicalItem.module,
    occurrenceDate: String(row.occurrence_date),
    sourceLabel: String(row.source_label),
    sourceModule: row.source_module,
    sourceOrder: Number(row.source_order),
    sourceQuestionStart: Number(row.source_question_start),
    sourceQuestionEnd: Number(row.source_question_end),
    scoringPointCount: Number(logicalItem.scored_item_count)
  };
}

function isReadingModule(value: string): value is ReadingModule {
  return value === "ctw" || value === "rdl" || value === "rap";
}

function isReadingTestModule(value: string): value is ReadingTestModule {
  return value === "m1" || value === "m2";
}
