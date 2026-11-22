import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type AssignmentItemType,
  type AssignmentSubject
} from "./assignmentCatalog.ts";
import {
  assignmentPracticeFullSetBadge,
  assignmentPracticeItemIsCompleted,
  assignmentPracticeStatusKey,
  type AssignmentPracticeStatusEntry
} from "./assignmentPracticeStatus.ts";
import { loadReadingFullSetDefinitions } from "./reading/fullSets.server.ts";
import type { ReadingFullSet } from "./reading/fullSets.ts";
import type { ReadingModule } from "./reading/types.ts";
import { isStudentPracticeItemStateUnavailableError } from "./studentPracticeItemState.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { chunkValues } from "./teacherClassSharing.server.ts";

/**
 * Server-side practice badge loader for the teacher Assignment catalog.
 *
 * The loader resolves the union of completed item identities for the selected
 * students in a fixed number of batched reads:
 *
 *   1. `student_practice_item_state` (sparse indexed summary) supplies the
 *      ordinary Reading attempts, BAS attempts and self-practice Writing
 *      attempts. A row counts when it has ANY completed attempt, even if a
 *      newer attempt is currently `in_progress`.
 *   2. Writing teacher-assigned attempts are not part of the sparse state
 *      (the shared rebuild only tracks self practice), so submitted original
 *      assigned attempts are read separately and resolved through the
 *      canonical `practice_item_sources` mapping.
 *   3. Reading Full Sets are expanded to their real constituent logical items
 *      and both whole-Full-Set completions and submitted module attempts are
 *      applied, so a student who never opened the Full Set but practiced its
 *      CTW / RDL / RAP items is still recognized.
 *   4. Category practice and wrongbook correction answers are added as
 *      ordinary `practiced` identities. They target individual scored
 *      questions, so they never count as a fully completed multi-question
 *      reading item for Full Set coverage.
 *
 * No per-item query and no per-student query: every read is batched over the
 * whole selected student set, and the response only carries the item
 * identities that actually have a badge.
 */

const WRITING_TASK_TYPES = [
  "email",
  "academic_discussion",
  "build_sentence"
] as const;

const READING_TASK_TYPES = ["ctw", "rdl", "rap", "full_set"] as const;

type PracticeStateRow = {
  task_type: string;
  item_id: string;
  latest_completed_attempt_id: string | null;
  last_completed_at: string | null;
};

type PracticedItem = { item_id: string; item_type: AssignmentItemType };

type FullSetConstituent = { logicalItemId: string; taskType: ReadingModule };

type FullSetPracticeDefinition = {
  all: FullSetConstituent[];
  module1: FullSetConstituent[];
  module2: FullSetConstituent[];
};

export type AssignmentPracticeStatusLoadInput = {
  studentIds: readonly string[];
  subject: AssignmentSubject;
};

export async function loadAssignmentPracticeStatus(
  db: SupabaseClient,
  input: AssignmentPracticeStatusLoadInput
): Promise<AssignmentPracticeStatusEntry[]> {
  const studentIds = Array.from(new Set(input.studentIds.map((id) => id.trim()).filter(Boolean)));
  if (studentIds.length === 0) return [];

  // Item identities that must be displayed as 已练习. Keyed by
  // `item_type:item_id` so the same identity can never be added twice.
  const practicedItems = new Map<string, PracticedItem>();
  // Fully completed Reading logical items only (multi-question material
  // completion). Used exclusively for Full Set coverage.
  const fullyCompletedReadingItemIds = new Set<string>();
  const completedFullSetIds = new Set<string>();

  const addPracticed = (itemType: AssignmentItemType, itemId: string) => {
    if (!itemId) return;
    const key = assignmentPracticeStatusKey(itemType, itemId);
    if (!practicedItems.has(key)) {
      practicedItems.set(key, { item_id: itemId, item_type: itemType });
    }
  };
  const addCompletedReadingItem = (module: ReadingModule, itemId: string) => {
    if (!itemId) return;
    fullyCompletedReadingItemIds.add(itemId);
    addPracticed(module, itemId);
  };

  const taskTypes = input.subject === "reading" ? READING_TASK_TYPES : WRITING_TASK_TYPES;
  // The Full Set definition query is the slowest read; start it together with
  // the state read instead of after it. The same canonical definitions are
  // still used for the mapping.
  const fullSetDefinitionsPromise = input.subject === "reading"
    ? loadReadingFullSetDefinitions(db)
    : null;
  const state = await loadCompletedPracticeState(db, studentIds, taskTypes);

  if (state.available) {
    for (const row of state.rows) {
      if (!assignmentPracticeItemIsCompleted(row)) continue;
      if (row.task_type === "full_set") {
        completedFullSetIds.add(row.item_id);
        continue;
      }
      const itemType = row.task_type as AssignmentItemType;
      addPracticed(itemType, row.item_id);
      if (row.task_type === "ctw" || row.task_type === "rdl" || row.task_type === "rap") {
        fullyCompletedReadingItemIds.add(row.item_id);
      }
    }
  } else {
    // The sparse state migration is unavailable: derive the same identities
    // from the canonical attempt tables instead of treating everything as
    // un-practiced.
    await loadFallbackCompletedItems(db, studentIds, input.subject, {
      addCompletedReadingItem,
      addPracticed,
      completedFullSetIds
    });
  }

  if (input.subject === "writing") {
    if (state.available) {
      await addWritingAttemptItemIds(db, studentIds, addPracticed, true);
    }
    return buildStatusEntries(practicedItems, null, new Set(), completedFullSetIds);
  }

  const fullSets = buildFullSetPracticeDefinitions(await fullSetDefinitionsPromise!);

  // A student who completed the whole Full Set completed every constituent.
  for (const fullSetId of Array.from(completedFullSetIds)) {
    const definition = fullSets.get(fullSetId);
    if (!definition) continue;
    for (const constituent of definition.all) {
      addCompletedReadingItem(constituent.taskType, constituent.logicalItemId);
    }
  }

  await Promise.all([
    addFullSetModuleProgress(db, studentIds, fullSets, {
      addCompletedReadingItem,
      completedFullSetIds
    }),
    addCategoryPracticeAnswers(db, studentIds, addPracticed),
    addWrongbookPracticeAnswers(db, studentIds, addPracticed)
  ]);

  return buildStatusEntries(
    practicedItems,
    fullSets,
    fullyCompletedReadingItemIds,
    completedFullSetIds
  );
}

function buildStatusEntries(
  practicedItems: ReadonlyMap<string, PracticedItem>,
  fullSets: ReadonlyMap<string, FullSetPracticeDefinition> | null,
  fullyCompletedItemIds: ReadonlySet<string>,
  completedFullSetIds: ReadonlySet<string>
) {
  const entries: AssignmentPracticeStatusEntry[] = Array.from(
    practicedItems.values(),
    (item) => ({
      item_id: item.item_id,
      item_type: item.item_type,
      status: "practiced" as const
    })
  );
  if (!fullSets) return entries;
  for (const [fullSetId, definition] of Array.from(fullSets.entries())) {
    const status = assignmentPracticeFullSetBadge({
      completedFullSetIds,
      completedItemIds: fullyCompletedItemIds,
      constituentItemIds: definition.all.map((constituent) => constituent.logicalItemId),
      fullSetId
    });
    if (status) {
      entries.push({ item_id: fullSetId, item_type: "full_set", status });
    }
  }
  return entries;
}

async function loadCompletedPracticeState(
  db: SupabaseClient,
  studentIds: readonly string[],
  taskTypes: readonly string[]
): Promise<{ available: boolean; rows: PracticeStateRow[] }> {
  const rows: PracticeStateRow[] = [];
  for (const batch of chunkValues([...studentIds])) {
    const result = await readAllSupabaseRows<PracticeStateRow>((from, to) =>
      db
        .from("student_practice_item_state")
        .select("task_type,item_id,latest_completed_attempt_id,last_completed_at")
        .in("student_id", batch)
        .in("task_type", [...taskTypes])
        .not("latest_completed_attempt_id", "is", null)
        .order("student_id", { ascending: true })
        .order("task_type", { ascending: true })
        .order("item_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: PracticeStateRow[] | null;
        error: { code?: string | null; message: string } | null;
      }>
    );
    if (result.error) {
      if (isStudentPracticeItemStateUnavailableError(result.error)) {
        return { available: false, rows: [] };
      }
      throw new Error(
        `load Assignment practice state: ${result.error.message}`
      );
    }
    rows.push(...(result.data ?? []));
  }
  return { available: true, rows };
}

async function loadFallbackCompletedItems(
  db: SupabaseClient,
  studentIds: readonly string[],
  subject: AssignmentSubject,
  target: {
    addCompletedReadingItem: (module: ReadingModule, itemId: string) => void;
    addPracticed: (itemType: AssignmentItemType, itemId: string) => void;
    completedFullSetIds: Set<string>;
  }
) {
  if (subject === "writing") {
    await addWritingAttemptItemIds(db, studentIds, target.addPracticed, false);
    await addFallbackBasAttempts(db, studentIds, target.addPracticed);
    return;
  }

  for (const batch of chunkValues([...studentIds])) {
    const attempts = await readAllSupabaseRows<{
      task_type: string;
      logical_item_id: string;
    }>((from, to) =>
      db
        .from("reading_attempts")
        .select("task_type,logical_item_id")
        .in("student_id", batch)
        .eq("status", "submitted")
        .order("attempt_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ task_type: string; logical_item_id: string }> | null;
        error: { message: string } | null;
      }>
    );
    if (attempts.error) throw new Error(`load Reading attempts: ${attempts.error.message}`);
    for (const row of attempts.data ?? []) {
      if (row.task_type === "ctw" || row.task_type === "rdl" || row.task_type === "rap") {
        target.addCompletedReadingItem(row.task_type, row.logical_item_id);
      }
    }

    const fullSets = await readAllSupabaseRows<{ full_set_id: string }>((from, to) =>
      db
        .from("reading_full_set_attempts")
        .select("full_set_id")
        .in("student_id", batch)
        .eq("status", "completed")
        .not("completed_at", "is", null)
        .order("attempt_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ full_set_id: string }> | null;
        error: { message: string } | null;
      }>
    );
    if (fullSets.error) throw new Error(`load Reading Full Set attempts: ${fullSets.error.message}`);
    for (const row of fullSets.data ?? []) target.completedFullSetIds.add(row.full_set_id);
  }
}

async function addWritingAttemptItemIds(
  db: SupabaseClient,
  studentIds: readonly string[],
  addPracticed: (itemType: AssignmentItemType, itemId: string) => void,
  assignedOnly: boolean
) {
  const rawQuestionIds = new Set<string>();
  for (const batch of chunkValues([...studentIds])) {
    const result = await readAllSupabaseRows<{
      task_type: string;
      question_id: string;
    }>((from, to) => {
      let query = db
        .from("writing_attempts")
        .select("task_type,question_id")
        .in("user_id", batch)
        .eq("status", "submitted")
        .eq("attempt_kind", "original");
      if (assignedOnly) query = query.not("assignment_id", "is", null);
      return query
        .order("attempt_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ task_type: string; question_id: string }> | null;
        error: { message: string } | null;
      }>;
    });
    if (result.error) throw new Error(`load Writing attempts: ${result.error.message}`);
    for (const row of result.data ?? []) {
      if (row.task_type === "email" || row.task_type === "academic_discussion") {
        rawQuestionIds.add(row.question_id);
      }
    }
  }
  const itemIdByRawQuestion = await loadWritingItemIdsByQuestionId(db, rawQuestionIds);
  for (const resolved of Array.from(itemIdByRawQuestion.values())) {
    addPracticed(resolved.taskType, resolved.itemId);
  }
}

async function loadWritingItemIdsByQuestionId(
  db: SupabaseClient,
  rawQuestionIds: ReadonlySet<string>
) {
  const resolved = new Map<
    string,
    { itemId: string; taskType: "email" | "academic_discussion" }
  >();
  if (rawQuestionIds.size === 0) return resolved;
  for (const batch of chunkValues(Array.from(rawQuestionIds))) {
    const result = await readAllSupabaseRows<{
      task_type: string;
      source_question_id: string | null;
      item_id: string;
    }>((from, to) =>
      db
        .from("practice_item_sources")
        .select("task_type,source_question_id,item_id")
        .in("task_type", ["email", "academic_discussion"])
        .in("source_question_id", batch)
        .order("item_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{
          task_type: string;
          source_question_id: string | null;
          item_id: string;
        }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load Writing item sources: ${result.error.message}`);
    for (const row of result.data ?? []) {
      if (
        row.source_question_id
        && (row.task_type === "email" || row.task_type === "academic_discussion")
      ) {
        resolved.set(`${row.task_type}:${row.source_question_id}`, {
          itemId: String(row.item_id),
          taskType: row.task_type
        });
      }
    }
  }
  return resolved;
}

async function addFallbackBasAttempts(
  db: SupabaseClient,
  studentIds: readonly string[],
  addPracticed: (itemType: AssignmentItemType, itemId: string) => void
) {
  const setIds = new Set<string>();
  for (const batch of chunkValues([...studentIds])) {
    const result = await readAllSupabaseRows<{ set_id: string | null }>((from, to) =>
      db
        .from("attempts")
        .select("set_id")
        .in("student_id", batch)
        .not("submitted_at", "is", null)
        .order("attempt_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ set_id: string | null }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load BAS attempts: ${result.error.message}`);
    for (const row of result.data ?? []) {
      const setId = row.set_id?.trim();
      if (setId) setIds.add(setId);
    }
  }
  if (setIds.size === 0) return;

  const itemIdBySetId = new Map<string, string>();
  for (const batch of chunkValues(Array.from(setIds))) {
    const result = await readAllSupabaseRows<{
      source_set_id: string | null;
      item_id: string;
    }>((from, to) =>
      db
        .from("practice_item_sources")
        .select("source_set_id,item_id")
        .eq("task_type", "build_sentence")
        .in("source_set_id", batch)
        .order("item_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ source_set_id: string | null; item_id: string }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load BAS item sources: ${result.error.message}`);
    for (const row of result.data ?? []) {
      if (row.source_set_id) itemIdBySetId.set(row.source_set_id, String(row.item_id));
    }
  }
  for (const [setId, itemId] of Array.from(itemIdBySetId.entries())) {
    if (/^(grammar|wrongbook)-/i.test(setId)) continue;
    addPracticed("build_sentence", itemId);
  }
}

function buildFullSetPracticeDefinitions(fullSets: readonly ReadingFullSet[]) {
  const definitions = new Map<string, FullSetPracticeDefinition>();
  for (const fullSet of fullSets) {
    if (!fullSet.validation.valid || !fullSet.fullSetId) continue;
    const all: FullSetConstituent[] = [];
    const module1: FullSetConstituent[] = [];
    const module2: FullSetConstituent[] = [];
    for (const occurrence of [...fullSet.module1.occurrences, ...fullSet.module2.occurrences]) {
      const constituent = {
        logicalItemId: occurrence.logicalItemId,
        taskType: occurrence.taskType
      };
      all.push(constituent);
      if (occurrence.sourceModule === "m1") module1.push(constituent);
      else module2.push(constituent);
    }
    definitions.set(fullSet.fullSetId, { all, module1, module2 });
  }
  return definitions;
}

async function addFullSetModuleProgress(
  db: SupabaseClient,
  studentIds: readonly string[],
  definitions: ReadonlyMap<string, FullSetPracticeDefinition>,
  target: {
    addCompletedReadingItem: (module: ReadingModule, itemId: string) => void;
    completedFullSetIds: Set<string>;
  }
) {
  const attempts: Array<{ attempt_id: string; full_set_id: string; status: string }> = [];
  for (const batch of chunkValues([...studentIds])) {
    const result = await readAllSupabaseRows<{
      attempt_id: string;
      full_set_id: string;
      status: string;
    }>((from, to) =>
      db
        .from("reading_full_set_attempts")
        .select("attempt_id,full_set_id,status")
        .in("student_id", batch)
        .order("attempt_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ attempt_id: string; full_set_id: string; status: string }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load Reading Full Set progress: ${result.error.message}`);
    attempts.push(...(result.data ?? []));
  }
  if (attempts.length === 0) return;

  const fullSetByAttemptId = new Map<string, string>();
  for (const attempt of attempts) {
    fullSetByAttemptId.set(attempt.attempt_id, attempt.full_set_id);
    if (attempt.status === "completed") {
      target.completedFullSetIds.add(attempt.full_set_id);
      // A completed Full Set also completed all of its constituent items, even
      // when the sparse state row is missing. This keeps shared canonical items
      // correct in every other Full Set as well.
      const definition = definitions.get(attempt.full_set_id);
      if (definition) {
        for (const constituent of definition.all) {
          target.addCompletedReadingItem(constituent.taskType, constituent.logicalItemId);
        }
      }
    }
  }

  const attemptIds = Array.from(fullSetByAttemptId.keys());
  const submittedModules: Array<{ attempt_id: string; module_number: number }> = [];
  for (const batch of chunkValues(attemptIds)) {
    const result = await readAllSupabaseRows<{
      attempt_id: string;
      module_number: number;
    }>((from, to) =>
      db
        .from("reading_full_set_module_attempts")
        .select("attempt_id,module_number")
        .in("attempt_id", batch)
        .eq("status", "submitted")
        .order("module_attempt_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ attempt_id: string; module_number: number }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load Reading Full Set modules: ${result.error.message}`);
    submittedModules.push(...(result.data ?? []));
  }

  for (const submittedModule of submittedModules) {
    const fullSetId = fullSetByAttemptId.get(submittedModule.attempt_id);
    const definition = fullSetId ? definitions.get(fullSetId) : undefined;
    if (!definition) continue;
    const constituents = Number(submittedModule.module_number) === 1
      ? definition.module1
      : Number(submittedModule.module_number) === 2
        ? definition.module2
        : [];
    for (const constituent of constituents) {
      target.addCompletedReadingItem(constituent.taskType, constituent.logicalItemId);
    }
  }
}

async function addCategoryPracticeAnswers(
  db: SupabaseClient,
  studentIds: readonly string[],
  addPracticed: (itemType: AssignmentItemType, itemId: string) => void
) {
  const sessionIds: string[] = [];
  for (const batch of chunkValues([...studentIds])) {
    const result = await readAllSupabaseRows<{ session_id: string }>((from, to) =>
      db
        .from("reading_question_category_sessions")
        .select("session_id")
        .in("student_id", batch)
        .order("session_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ session_id: string }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load category practice sessions: ${result.error.message}`);
    for (const row of result.data ?? []) sessionIds.push(String(row.session_id));
  }
  if (sessionIds.length === 0) return;

  for (const batch of chunkValues(sessionIds)) {
    const result = await readAllSupabaseRows<{ logical_item_id: string }>((from, to) =>
      db
        .from("reading_question_category_session_answers")
        .select("logical_item_id")
        .in("session_id", batch)
        .order("answer_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ logical_item_id: string }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load category practice answers: ${result.error.message}`);
    for (const row of result.data ?? []) {
      const readingModule = readingModuleFromLogicalItemId(row.logical_item_id);
      if (readingModule) addPracticed(readingModule, row.logical_item_id);
    }
  }
}

async function addWrongbookPracticeAnswers(
  db: SupabaseClient,
  studentIds: readonly string[],
  addPracticed: (itemType: AssignmentItemType, itemId: string) => void
) {
  const attemptIds: string[] = [];
  for (const batch of chunkValues([...studentIds])) {
    const result = await readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
      db
        .from("reading_wrongbook_attempts")
        .select("attempt_id")
        .in("student_id", batch)
        .eq("status", "submitted")
        .order("attempt_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ attempt_id: string }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load wrongbook attempts: ${result.error.message}`);
    for (const row of result.data ?? []) attemptIds.push(String(row.attempt_id));
  }
  if (attemptIds.length === 0) return;

  for (const batch of chunkValues(attemptIds)) {
    const result = await readAllSupabaseRows<{ logical_item_id: string }>((from, to) =>
      db
        .from("reading_wrongbook_attempt_answers")
        .select("logical_item_id")
        .in("attempt_id", batch)
        .order("attempt_answer_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: Array<{ logical_item_id: string }> | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw new Error(`load wrongbook answers: ${result.error.message}`);
    for (const row of result.data ?? []) {
      const readingModule = readingModuleFromLogicalItemId(row.logical_item_id);
      if (readingModule) addPracticed(readingModule, row.logical_item_id);
    }
  }
}

function readingModuleFromLogicalItemId(itemId: string): ReadingModule | null {
  if (itemId.startsWith("reading-ctw-")) return "ctw";
  if (itemId.startsWith("reading-rdl-")) return "rdl";
  if (itemId.startsWith("reading-rap-")) return "rap";
  return null;
}
