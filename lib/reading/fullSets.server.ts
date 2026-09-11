import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "../supabasePagination.ts";
import {
  buildReadingFullSets,
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
  const result = await readAllSupabaseRows<ReadingFullSetOccurrenceRow>(async (from, to) => {
    const page = await db.from("reading_source_occurrences")
      .select([
        "occurrence_id",
        "logical_item_id",
        "source_label",
        "occurrence_date",
        "source_module",
        "source_order",
        "source_question_start",
        "source_question_end",
        "reading_logical_items!inner(module,scored_item_count)"
      ].join(","))
      .order("occurrence_date", { ascending: true })
      .order("source_label", { ascending: true })
      .order("source_module", { ascending: true })
      .order("source_order", { ascending: true })
      .order("occurrence_id", { ascending: true })
      .range(from, to);
    return {
      data: page.data as unknown as ReadingFullSetOccurrenceRow[] | null,
      error: page.error
    };
  });
  if (result.error) throw new Error(`read Reading Full Set occurrences: ${result.error.message}`);
  return buildReadingFullSets((result.data ?? []).map(readingFullSetOccurrenceInput));
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
