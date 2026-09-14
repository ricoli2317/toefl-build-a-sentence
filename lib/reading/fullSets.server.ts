import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "../supabasePagination.ts";
import {
  buildReadingFullSets,
  findValidReadingFullSet,
  type ReadingFullSet,
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
