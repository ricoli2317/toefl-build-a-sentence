import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  compareReadingCatalogIdentityOrder,
  readingCatalogDisplayNumbers,
  type ReadingCatalogIdentityRow
} from "@/lib/reading/catalog";
import { countOccurrenceDates } from "@/lib/catalogOccurrenceDates";
import { assertCanonicalCtwTitle } from "@/lib/reading/ctwTitles";
import { loadStudentReadingPractice } from "@/lib/reading/studentPractice";
import type { ReadingModule } from "@/lib/reading/types";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { buildTeacherReadingAnswerKey } from "@/lib/teacherReadingAnswerKey.server";
import {
  isReadingModuleTaskType,
  readingBankItemTitle,
  type TeacherReadingBankCatalog,
  type TeacherReadingBankCatalogItem,
  type TeacherReadingBankItemDetail
} from "@/lib/teacherReadingQuestionBank";

export const dynamic = "force-dynamic";

const READING_ID_PATTERN = /^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/;

type ReadingIdentityRow = ReadingCatalogIdentityRow & {
  module: ReadingModule;
  title: string | null;
  question_count: number;
  scored_item_count: number;
  catalog_category?: string | null;
  catalog_search_text?: string | null;
  reading_source_occurrences?: Array<{ occurrence_id?: string; occurrence_date: string }>;
};

type PageError = { message: string };

export async function GET(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error) {
      return jsonError(auth.error, auth.error === "Unauthorized" ? 401 : 403);
    }

    const params = new URL(request.url).searchParams;
    const itemId = params.get("itemId")?.trim();
    const db = createServiceSupabase();

    if (itemId) {
      if (!READING_ID_PATTERN.test(itemId)) return jsonError("Reading item not found.", 404);
      const detail = await loadReadingItemDetail(db, itemId);
      return detail ? json(detail) : jsonError("Reading item not found.", 404);
    }

    const requestedModule = params.get("module");
    if (!isReadingModuleTaskType(requestedModule)) {
      return jsonError("Invalid Reading module.", 400);
    }
    return json(await loadReadingBankCatalog(db, requestedModule));
  } catch (error) {
    console.error("[teacher-reading-question-bank] load_failed", error);
    return jsonError("Could not load the teacher Reading question bank.");
  }
}

async function loadReadingIdentityRows(
  db: ReturnType<typeof createServiceSupabase>,
  module: ReadingModule
) {
  let result = await readAllSupabaseRows<ReadingIdentityRow>((from, to) =>
    db
      .from("reading_logical_items")
      .select(
        "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count,catalog_category,catalog_search_text,reading_source_occurrences(occurrence_id,occurrence_date)"
      )
      .eq("module", module)
      .order("first_seen_date", { ascending: true })
      .order("first_seen_source_label", { ascending: true })
      .order("first_seen_source_order", { ascending: true })
      .order("logical_item_id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
      data: ReadingIdentityRow[] | null;
      error: PageError | null;
    }>
  );
  if (result.error?.message.includes("catalog_search_text") && result.error.message.includes("does not exist")) {
    result = await readAllSupabaseRows<ReadingIdentityRow>((from, to) =>
      db
        .from("reading_logical_items")
        .select(
          "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count,catalog_category,reading_source_occurrences(occurrence_id,occurrence_date)"
        )
        .eq("module", module)
        .order("first_seen_date", { ascending: true })
        .order("first_seen_source_label", { ascending: true })
        .order("first_seen_source_order", { ascending: true })
        .order("logical_item_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: ReadingIdentityRow[] | null;
        error: PageError | null;
      }>
    );
  }
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).sort(compareReadingCatalogIdentityOrder);
}

function toCatalogItem(
  row: ReadingIdentityRow,
  displayNumber: string
): TeacherReadingBankCatalogItem {
  const rawOccurrenceDates = (row.reading_source_occurrences ?? []).map((occurrence) =>
    String(occurrence.occurrence_date)
  );
  const occurrenceDateCounts = countOccurrenceDates(
    rawOccurrenceDates.length ? rawOccurrenceDates : [row.first_seen_date]
  );
  const occurrenceDates = occurrenceDateCounts.map(({ date }) => date);
  return {
    itemId: row.logical_item_id,
    module: row.module,
    displayNumber,
    title: readingBankItemTitle({
      module: row.module,
      title: row.title,
      displayNumber
    }),
    firstSeenDate: row.first_seen_date,
    latestSeenDate: occurrenceDates[0] ?? row.first_seen_date,
    occurrenceDates,
    occurrenceDateCounts,
    occurrenceCount: rawOccurrenceDates.length,
    category: row.catalog_category?.trim() ?? "",
    searchText: row.catalog_search_text ?? "",
    questionCount: Number(row.question_count),
    scoringPointCount: Number(row.scored_item_count)
  };
}

async function loadReadingBankCatalog(
  db: ReturnType<typeof createServiceSupabase>,
  module: ReadingModule
): Promise<TeacherReadingBankCatalog> {
  const ranked = await loadReadingIdentityRows(db, module);
  const displayNumbers = readingCatalogDisplayNumbers(ranked);
  // The display rank is historical, while the bank list itself is latest-first.
  const items = [...ranked].reverse().map((row) =>
    toCatalogItem(row, displayNumbers.get(row.logical_item_id) ?? "")
  );
  return {
    module,
    items
  };
}

async function loadReadingItemDetail(
  db: ReturnType<typeof createServiceSupabase>,
  itemId: string
): Promise<TeacherReadingBankItemDetail | null> {
  const itemResult = await db
    .from("reading_logical_items")
    .select("logical_item_id,module,title")
    .eq("logical_item_id", itemId)
    .maybeSingle();
  if (itemResult.error) throw new Error(itemResult.error.message);
  if (!itemResult.data) return null;

  const practice = await loadStudentReadingPractice(db, itemId, undefined, {
    ctwDisplayTitle: itemResult.data.module === "ctw"
      ? assertCanonicalCtwTitle(String(itemResult.data.title ?? ""), `CTW title for ${itemId}`)
      : undefined,
    skipRdlAssetVerification: true
  });
  const answerKey = await buildTeacherReadingAnswerKey(db, practice);
  return { practice, answerKey };
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function jsonError(error: string, status = 500) {
  return json({ error }, { status });
}
