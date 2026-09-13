import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  auditCtwLogicalIdentities,
  renderCtwLogicalIdentityAuditMarkdown,
  type CtwAuditLogicalItemInput,
  type CtwAuditOccurrence
} from "../lib/reading/ctwLogicalIdentityAudit.ts";
import type { CtwQuestion, CtwSegment, CtwSlot } from "../lib/reading/types.ts";

type Row = Record<string, unknown>;

const OUTPUT_DIRECTORY = "work/audit";
const JSON_FILENAME = "ctw-logical-identity-audit.json";
const MARKDOWN_FILENAME = "ctw-logical-identity-audit.md";

void run().catch((error) => {
  console.error(`CTW logical-identity audit stopped: ${safeError(error)}`);
  process.exitCode = 1;
});

async function run() {
  assertNoArguments();
  const supabase = createReadOnlyAuditClient();
  const { count: databaseCount, error: countError } = await supabase
    .from("reading_logical_items")
    .select("logical_item_id", { count: "exact", head: true })
    .eq("module", "ctw");
  if (countError) throw new Error(`count reading_logical_items: ${countError.message}`);

  const items = await loadAllCtwLogicalItems(supabase);
  if (databaseCount !== items.length) {
    throw new Error(
      `Full-library coverage check failed: database count=${databaseCount}, loaded=${items.length}`
    );
  }

  const preliminary = auditCtwLogicalIdentities(items);
  const duplicateLogicalItemIds = preliminary.clusters.flatMap((cluster) => cluster.logicalItemIds);
  const relatedCounts = await loadRelatedRecordCounts(
    supabase,
    duplicateLogicalItemIds,
    items
  );
  const manifest = auditCtwLogicalIdentities(items.map((item) => ({
    ...item,
    relatedRecordCounts: relatedCounts.get(item.logicalItemId) ?? {}
  })));

  const outputDirectory = resolve(process.cwd(), OUTPUT_DIRECTORY);
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = resolve(outputDirectory, JSON_FILENAME);
  const markdownPath = resolve(outputDirectory, MARKDOWN_FILENAME);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderCtwLogicalIdentityAuditMarkdown(manifest), "utf8")
  ]);

  console.log(JSON.stringify({
    totalLogicalItems: manifest.totalLogicalItems,
    uniqueIdentityCount: manifest.uniqueIdentityCount,
    duplicateClusterCount: manifest.duplicateClusterCount,
    duplicateLogicalItemCount: manifest.duplicateLogicalItemCount,
    theoreticalLogicalItemReduction: manifest.theoreticalLogicalItemReduction,
    prefixConflictClusterCount: manifest.prefixConflictClusterCount,
    punctuationOnlyClusterCount: manifest.punctuationOnlyClusterCount,
    duplicateOccurrenceMappingCount: manifest.duplicateOccurrenceMappingCount,
    otherManualReviewClusterCount: manifest.otherManualReviewClusterCount,
    jsonPath,
    markdownPath
  }, null, 2));
}

async function loadAllCtwLogicalItems(
  supabase: SupabaseClient
): Promise<CtwAuditLogicalItemInput[]> {
  const logicalRows = await readAllRows(
    () => supabase
      .from("reading_logical_items")
      .select("logical_item_id,title,first_seen_date,first_seen_source_label,first_seen_source_order,dedup_fingerprint")
      .eq("module", "ctw")
      .order("logical_item_id", { ascending: true }),
    "reading_logical_items"
  );
  const logicalItemIds = logicalRows.map((row) => text(row.logical_item_id));
  const [questionRows, occurrenceRows] = await Promise.all([
    readInBatches(
      supabase,
      "reading_questions",
      "question_id,logical_item_id,question_order,question_type,stem,raw_display_text",
      "logical_item_id",
      logicalItemIds,
      ["logical_item_id", "question_order"]
    ),
    readInBatches(
      supabase,
      "reading_source_occurrences",
      "occurrence_id,logical_item_id,source_kind,source_label,occurrence_date,source_module,source_order,source_question_start,source_question_end",
      "logical_item_id",
      logicalItemIds,
      ["logical_item_id", "occurrence_date", "source_label", "source_order"]
    )
  ]);
  const questionIds = questionRows.map((row) => text(row.question_id));
  const [paragraphRows, slotRows, segmentRows] = await Promise.all([
    readInBatches(
      supabase,
      "reading_ctw_paragraphs",
      "question_id,paragraph_id,paragraph_order,raw_text",
      "question_id",
      questionIds,
      ["question_id", "paragraph_order"]
    ),
    readInBatches(
      supabase,
      "reading_ctw_slots",
      "question_id,slot_id,slot_order,paragraph_id,answer,prefix,display_text,missing_text,missing_length",
      "question_id",
      questionIds,
      ["question_id", "slot_order"]
    ),
    readInBatches(
      supabase,
      "reading_ctw_segments",
      "question_id,paragraph_id,segment_order,segment_type,text_content,slot_id",
      "question_id",
      questionIds,
      ["question_id", "paragraph_id", "segment_order"]
    )
  ]);

  const questionsByLogical = grouped(questionRows, "logical_item_id");
  const occurrencesByLogical = grouped(occurrenceRows, "logical_item_id");
  const paragraphsByQuestion = grouped(paragraphRows, "question_id");
  const slotsByQuestion = grouped(slotRows, "question_id");
  const segmentsByParagraph = groupedComposite(segmentRows, ["question_id", "paragraph_id"]);

  return logicalRows.map((logicalRow) => {
    const logicalItemId = text(logicalRow.logical_item_id);
    const questionCandidates = questionsByLogical.get(logicalItemId) ?? [];
    if (questionCandidates.length !== 1) {
      throw new Error(
        `CTW logical item ${logicalItemId} has ${questionCandidates.length} canonical questions; expected 1`
      );
    }
    const questionRow = questionCandidates[0];
    if (text(questionRow.question_type) !== "ctw") {
      throw new Error(`CTW logical item ${logicalItemId} has a non-CTW question`);
    }
    const questionId = text(questionRow.question_id);
    const slots = (slotsByQuestion.get(questionId) ?? []).map(slotFromRow);
    const paragraphs = (paragraphsByQuestion.get(questionId) ?? [])
      .map((paragraphRow) => ({
        paragraphId: text(paragraphRow.paragraph_id),
        paragraphOrder: integer(paragraphRow.paragraph_order),
        rawText: text(paragraphRow.raw_text),
        segments: (segmentsByParagraph.get(compositeKey([
          questionId,
          text(paragraphRow.paragraph_id)
        ])) ?? [])
          .sort((left, right) => integer(left.segment_order) - integer(right.segment_order))
          .map(segmentFromRow)
      }))
      .sort((left, right) => left.paragraphOrder - right.paragraphOrder);
    if (paragraphs.length === 0 || slots.length === 0) {
      throw new Error(`CTW logical item ${logicalItemId} is missing canonical paragraphs or slots`);
    }
    const question: CtwQuestion = {
      questionId,
      logicalItemId,
      questionOrder: integer(questionRow.question_order),
      questionType: "ctw",
      stem: text(questionRow.stem),
      rawDisplayText: nullableText(questionRow.raw_display_text),
      payload: { paragraphs, slots }
    };
    return {
      logicalItemId,
      title: nullableText(logicalRow.title),
      firstSeenDate: text(logicalRow.first_seen_date),
      firstSeenSourceLabel: text(logicalRow.first_seen_source_label),
      firstSeenSourceOrder: integer(logicalRow.first_seen_source_order),
      oldFingerprint: text(logicalRow.dedup_fingerprint),
      question,
      occurrences: (occurrencesByLogical.get(logicalItemId) ?? []).map(occurrenceFromRow)
    };
  });
}

async function loadRelatedRecordCounts(
  supabase: SupabaseClient,
  duplicateLogicalItemIds: string[],
  items: CtwAuditLogicalItemInput[]
) {
  const counts = new Map<string, Record<string, number>>(
    duplicateLogicalItemIds.map((logicalItemId) => [logicalItemId, {}])
  );
  if (duplicateLogicalItemIds.length === 0) return counts;

  const itemById = new Map(items.map((item) => [item.logicalItemId, item]));
  const questionToLogical = new Map(items.flatMap((item) => [[
    item.question.questionId,
    item.logicalItemId
  ] as const]));
  for (const logicalItemId of duplicateLogicalItemIds) {
    const item = requiredMap(itemById, logicalItemId, "logical item");
    setCount(counts, logicalItemId, "reading_source_occurrences", item.occurrences.length);
    setCount(counts, logicalItemId, "reading_questions", 1);
    setCount(counts, logicalItemId, "reading_ctw_paragraphs", item.question.payload.paragraphs.length);
    setCount(counts, logicalItemId, "reading_ctw_segments", item.question.payload.paragraphs.reduce(
      (total, paragraph) => total + paragraph.segments.length,
      0
    ));
    setCount(counts, logicalItemId, "reading_ctw_slots", item.question.payload.slots.length);
  }

  const directTables = [
    "reading_question_occurrences",
    "reading_attempts",
    "reading_attempt_answers",
    "reading_full_set_answers",
    "reading_wrongbook_attempts",
    "reading_wrongbook_attempt_answers"
  ];
  const directRows = await Promise.all(directTables.map(async (table) => ({
    table,
    rows: await readInBatches(
      supabase,
      table,
      "logical_item_id",
      "logical_item_id",
      duplicateLogicalItemIds,
      ["logical_item_id"]
    )
  })));
  for (const { table, rows } of directRows) {
    for (const row of rows) increment(counts, text(row.logical_item_id), table);
  }

  const duplicateOccurrences = duplicateLogicalItemIds.flatMap((logicalItemId) =>
    requiredMap(itemById, logicalItemId, "logical item").occurrences.map((occurrence) => ({
      occurrenceId: occurrence.occurrenceId,
      logicalItemId
    }))
  );
  const occurrenceToLogical = new Map(
    duplicateOccurrences.map((entry) => [entry.occurrenceId, entry.logicalItemId])
  );
  const loadPauseRows = await readInBatches(
    supabase,
    "reading_full_set_load_pauses",
    "occurrence_id",
    "occurrence_id",
    duplicateOccurrences.map((entry) => entry.occurrenceId),
    ["occurrence_id"]
  );
  for (const row of loadPauseRows) {
    const occurrenceId = nullableText(row.occurrence_id);
    if (!occurrenceId) continue;
    const logicalItemId = occurrenceToLogical.get(occurrenceId);
    if (logicalItemId) increment(counts, logicalItemId, "reading_full_set_load_pauses");
  }

  const fullSetWrongbookRows = await readAllRows(
    () => supabase
      .from("reading_wrongbook_attempts")
      .select("attempt_id,targets")
      .eq("task_type", "full_set")
      .order("attempt_id", { ascending: true }),
    "reading_wrongbook_attempts full_set targets"
  );
  for (const row of fullSetWrongbookRows) {
    const seenInAttempt = new Set<string>();
    for (const target of jsonArray(row.targets)) {
      const logicalItemId = typeof target.logicalItemId === "string"
        ? target.logicalItemId
        : null;
      if (logicalItemId && counts.has(logicalItemId)) seenInAttempt.add(logicalItemId);
      const questionId = typeof target.questionId === "string" ? target.questionId : null;
      const mappedLogicalItemId = questionId ? questionToLogical.get(questionId) : null;
      if (mappedLogicalItemId && counts.has(mappedLogicalItemId)) seenInAttempt.add(mappedLogicalItemId);
    }
    for (const logicalItemId of Array.from(seenInAttempt)) {
      increment(counts, logicalItemId, "reading_wrongbook_attempts.targets");
    }
  }
  return counts;
}

function createReadOnlyAuditClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

async function readInBatches(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  field: string,
  values: string[],
  orderColumns: string[]
): Promise<Row[]> {
  if (values.length === 0) return [];
  const result: Row[] = [];
  const uniqueValues = Array.from(new Set(values));
  const batchSize = 150;
  for (let start = 0; start < uniqueValues.length; start += batchSize) {
    const batch = uniqueValues.slice(start, start + batchSize);
    const rows = await readAllRows(() => {
      let query = supabase.from(table).select(columns).in(field, batch);
      for (const column of orderColumns) query = query.order(column, { ascending: true });
      return query;
    }, `${table} by ${field}`);
    result.push(...rows);
  }
  return result;
}

async function readAllRows(
  buildQuery: () => any,
  label: string
): Promise<Row[]> {
  const pageSize = 1000;
  const rows: Row[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(`read ${label}: ${error.message}`);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function slotFromRow(row: Row): CtwSlot {
  return {
    slotId: text(row.slot_id),
    slotOrder: integer(row.slot_order),
    paragraphId: text(row.paragraph_id),
    answer: text(row.answer),
    prefix: text(row.prefix),
    displayText: text(row.display_text),
    missingText: text(row.missing_text),
    missingLength: integer(row.missing_length)
  };
}

function segmentFromRow(row: Row): CtwSegment {
  if (text(row.segment_type) === "text") {
    return { kind: "text", text: text(row.text_content) };
  }
  return { kind: "blank", slotId: text(row.slot_id) };
}

function occurrenceFromRow(row: Row): CtwAuditOccurrence {
  return {
    occurrenceId: text(row.occurrence_id),
    sourceKind: text(row.source_kind),
    sourceLabel: text(row.source_label),
    occurrenceDate: text(row.occurrence_date),
    sourceModule: text(row.source_module),
    sourceOrder: integer(row.source_order),
    sourceQuestionStart: integer(row.source_question_start),
    sourceQuestionEnd: integer(row.source_question_end)
  };
}

function grouped(rows: Row[], field: string) {
  const result = new Map<string, Row[]>();
  for (const row of rows) {
    const key = text(row[field]);
    result.set(key, [...(result.get(key) ?? []), row]);
  }
  return result;
}

function groupedComposite(rows: Row[], fields: string[]) {
  const result = new Map<string, Row[]>();
  for (const row of rows) {
    const key = compositeKey(fields.map((field) => text(row[field])));
    result.set(key, [...(result.get(key) ?? []), row]);
  }
  return result;
}

function compositeKey(values: string[]) {
  return JSON.stringify(values);
}

function setCount(
  counts: Map<string, Record<string, number>>,
  logicalItemId: string,
  table: string,
  count: number
) {
  requiredMap(counts, logicalItemId, "related count")[table] = count;
}

function increment(
  counts: Map<string, Record<string, number>>,
  logicalItemId: string,
  table: string
) {
  const record = requiredMap(counts, logicalItemId, "related count");
  record[table] = (record[table] ?? 0) + 1;
}

function jsonArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    : [];
}

function text(value: unknown) {
  if (typeof value !== "string") throw new Error(`Expected database text, received ${typeof value}`);
  return value;
}

function nullableText(value: unknown) {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown) {
  const result = Number(value);
  if (!Number.isInteger(result)) throw new Error(`Expected database integer, received ${String(value)}`);
  return result;
}

function requiredMap<K, V>(map: Map<K, V>, key: K, label: string): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing ${label}: ${String(key)}`);
  return value;
}

function assertNoArguments() {
  const argumentsAfterScript = process.argv.slice(2).filter((argument) => argument !== "--");
  if (argumentsAfterScript.length > 0) throw new Error("This read-only audit does not accept arguments");
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}
