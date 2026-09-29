import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignmentItemType } from "./assignmentCatalog.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import type { TeacherAssignmentItemResult } from "./writingAssignments.ts";

/**
 * Teacher-side Assignment result LOCATOR.
 *
 * For the item types that are graded by their own student practice flow
 * (BAS / CTW / RDL / RAP / Full Set) the Assignment Detail only needs to know
 * whether the student already has an existing result and which existing
 * attempt / set identity that result has. This module never scores, never
 * copies an attempt and never creates an Assignment-specific attempt or
 * result: it only reads the existing practice tables.
 *
 * Time boundary (correctness):
 *
 *   Only attempts that were formally completed at or after the Assignment
 *   became effective for the student count. The authoritative Assignment
 *   timestamp is `writing_assignment_students.assigned_at` (the per-recipient
 *   membership time, which the Assignment RPCs set when the item is placed or
 *   re-placed); never `attempt.created_at`. A student who already practiced
 *   the same item before a later Assignment never inherits that completion,
 *   and two Assignments of the same item each only see attempts inside their
 *   own window.
 *
 * Performance:
 *
 *   Everything stays batched: one query per attempt table for the whole
 *   visible list, then the per-Assignment time boundary is applied in memory.
 *   There is deliberately no per-Assignment attempt query.
 */

export type AssignmentResultLookupItem = {
  assignmentId: string;
  itemType: AssignmentItemType;
  /** Stable item identity stored as the Assignment item `question_id`. */
  itemId: string;
  /** BAS only: the raw question set the existing 套题记录 route is keyed by. */
  sourceSetId: string | null;
  /**
   * The effective time of the Assignment for this item / student
   * (`writing_assignment_students.assigned_at`). Attempts completed before it
   * are ignored. Callers must always hand over a value: production data has no
   * membership without `assigned_at` (audited 0 rows), and every caller falls
   * back to the item's own `created_at` — never to "count every historical
   * attempt". `null` only exists for explicit compatibility callers/tests.
   */
  boundaryAt?: string | null;
  /**
   * Optional single-student scope. When present only this student is looked
   * up, which lets callers carry one boundary per (assignment, student) pair.
   * When absent the shared `studentIds` list is used.
   */
  studentId?: string | null;
};

export type AssignmentStudentResult = {
  available_result: TeacherAssignmentItemResult | null;
  /** Any draft / in-progress row after the Assignment time, for 开始作答. */
  started: boolean;
};

export type AssignmentStudentResultMap = Map<string, AssignmentStudentResult>;

export function assignmentStudentResultKey(assignmentId: string, studentId: string) {
  return `${assignmentId}:${studentId}`;
}

export function assignmentStudentResult(map: AssignmentStudentResultMap, assignmentId: string, studentId: string) {
  return map.get(assignmentStudentResultKey(assignmentId, studentId))
    ?? { available_result: null, started: false };
}

type AssignmentResultScope = {
  assignmentId: string;
  itemType: AssignmentItemType;
  itemId: string;
  sourceSetId: string | null;
  studentId: string;
  boundaryAt: string | null;
};

/** One row of any read-only practice table, normalized for the shared rules. */
type ResultAttemptRow = {
  attemptId: string;
  itemId: string;
  studentId: string;
  /** Formal completion time (submitted_at / completed_at). */
  completedAt: string | null;
  /** Row creation time; only used to decide "already started" for drafts. */
  startedAt: string | null;
  /** True when the row represents a formally completed attempt. */
  completed: boolean;
};

export async function loadAssignmentStudentResults(input: {
  db: SupabaseClient;
  items: ReadonlyArray<AssignmentResultLookupItem>;
  studentIds: ReadonlyArray<string>;
}): Promise<AssignmentStudentResultMap> {
  const results: AssignmentStudentResultMap = new Map();
  const studentIds = Array.from(new Set(input.studentIds));
  if (studentIds.length === 0) return results;

  const scopes: AssignmentResultScope[] = [];
  for (const item of input.items) {
    const scopeStudentIds = item.studentId ? [item.studentId] : studentIds;
    for (const studentId of scopeStudentIds) {
      scopes.push({
        assignmentId: item.assignmentId,
        boundaryAt: item.boundaryAt ?? null,
        itemId: item.itemId,
        itemType: item.itemType,
        sourceSetId: item.sourceSetId,
        studentId
      });
    }
  }
  if (scopes.length === 0) return results;

  const readingItems = scopes.filter(
    (scope) => scope.itemType === "ctw" || scope.itemType === "rdl" || scope.itemType === "rap"
  );
  const fullSetItems = scopes.filter((scope) => scope.itemType === "full_set");
  const basItems = scopes.filter(
    (scope) => scope.itemType === "build_sentence" && Boolean(scope.sourceSetId)
  );

  const [readingRows, fullSetRows, basRows] = await Promise.all([
    readReadingAttemptRows(input.db, unique(readingItems.map((item) => item.itemId)), unique(readingItems.map((item) => item.studentId))),
    readFullSetAttemptRows(input.db, unique(fullSetItems.map((item) => item.itemId)), unique(fullSetItems.map((item) => item.studentId))),
    readBuildSentenceAttemptRows(
      input.db,
      unique(basItems.map((item) => item.sourceSetId!).filter(Boolean)),
      unique(basItems.map((item) => item.studentId))
    )
  ]);

  applyScopes(results, readingItems, readingRows, "reading_attempt");
  applyScopes(results, fullSetItems, fullSetRows, "reading_full_set");
  applyScopes(results, basItems, basRows, "bas_set");

  return results;
}

/**
 * The one shared per-scope rule: only rows inside the Assignment window count,
 * the newest completed row inside the window is the result identity, and any
 * row inside the window means the student already started.
 */
function applyScopes(
  results: AssignmentStudentResultMap,
  scopes: ReadonlyArray<AssignmentResultScope>,
  rows: ReadonlyArray<ResultAttemptRow>,
  kind: TeacherAssignmentItemResult["kind"]
) {
  const rowsByKey = new Map<string, ResultAttemptRow[]>();
  for (const row of rows) {
    const key = `${row.itemId}:${row.studentId}`;
    rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
  }
  for (const scope of scopes) {
    const key = `${scope.itemId}:${scope.studentId}`;
    const candidates = (rowsByKey.get(key) ?? []).filter((row) =>
      isInsideAssignmentWindow(row, scope.boundaryAt)
    );
    if (candidates.length === 0) continue;
    const latest = candidates.reduce((current, row) =>
      isLaterResultRow(
        { completed_at: row.completedAt, id: row.attemptId },
        { completed_at: current.completedAt, id: current.attemptId }
      )
        ? row
        : current
    );
    const availableResult = latest.completed
      ? kind === "bas_set"
        ? {
            // The existing teacher 套题记录 route is keyed by the raw set id,
            // not the attempt id; the set page then lists the student's own
            // attempts. The student result route is keyed by the latest
            // submitted attempt id.
            attempt_id: latest.attemptId,
            completed_at: latest.completedAt,
            id: scope.sourceSetId!,
            kind
          }
        : { completed_at: latest.completedAt, id: latest.attemptId, kind }
      : null;
    setResult(results, scope.assignmentId, scope.studentId, {
      available_result: availableResult,
      started: true
    });
  }
}

/**
 * A row counts for the Assignment when it was formally completed inside the
 * window, or (draft / in-progress) when it was started inside the window. The
 * completion time is `submitted_at` / `completed_at`; `created_at` is only
 * ever used for an unfinished row so a pre-Assignment draft can never mark a
 * new Assignment as 进行中.
 */
function isInsideAssignmentWindow(row: ResultAttemptRow, boundaryAt: string | null) {
  if (!boundaryAt) return true;
  const boundary = Date.parse(boundaryAt);
  if (Number.isNaN(boundary)) return true;
  const time = Date.parse((row.completed ? row.completedAt : row.startedAt) ?? "");
  if (Number.isNaN(time)) return false;
  return time >= boundary;
}

function setResult(
  results: AssignmentStudentResultMap,
  assignmentId: string,
  studentId: string,
  value: AssignmentStudentResult
) {
  const key = assignmentStudentResultKey(assignmentId, studentId);
  const current = results.get(key);
  // Merging keeps the completed identity even when an earlier row was a draft.
  if (current && (current.available_result || !value.available_result)) {
    results.set(key, { ...current, started: current.started || value.started });
    return;
  }
  results.set(key, value);
}

function isLaterResultRow(
  candidate: { completed_at: string | null; id: string },
  current: { completed_at: string | null; id: string }
) {
  const candidateTime = Date.parse(candidate.completed_at ?? "");
  const currentTime = Date.parse(current.completed_at ?? "");
  if (candidateTime !== currentTime) {
    return (Number.isNaN(currentTime) ? Number.NEGATIVE_INFINITY : currentTime) <
      (Number.isNaN(candidateTime) ? Number.NEGATIVE_INFINITY : candidateTime);
  }
  return candidate.id > current.id;
}

type ReadingAttemptRow = {
  attempt_id: string;
  student_id: string;
  logical_item_id: string;
  status: string;
  submitted_at: string | null;
  created_at: string | null;
};

async function readReadingAttemptRows(
  db: SupabaseClient,
  itemIds: string[],
  studentIds: string[]
) {
  const rows: ResultAttemptRow[] = [];
  if (itemIds.length === 0 || studentIds.length === 0) return rows;
  for (const itemBatch of chunk(itemIds)) {
    for (const studentBatch of chunk(studentIds)) {
      const result = await readAllSupabaseRows<ReadingAttemptRow>((from, to) =>
        db
          .from("reading_attempts")
          .select("attempt_id,student_id,logical_item_id,status,submitted_at,created_at")
          .in("logical_item_id", itemBatch)
          .in("student_id", studentBatch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      for (const row of result.data ?? []) {
        rows.push({
          attemptId: String(row.attempt_id),
          completed: row.status === "submitted",
          completedAt: row.submitted_at,
          itemId: row.logical_item_id,
          startedAt: row.created_at,
          studentId: row.student_id
        });
      }
    }
  }
  return rows;
}

type FullSetAttemptRow = {
  attempt_id: string;
  student_id: string;
  full_set_id: string;
  status: string;
  completed_at: string | null;
  created_at: string | null;
};

async function readFullSetAttemptRows(
  db: SupabaseClient,
  fullSetIds: string[],
  studentIds: string[]
) {
  const rows: ResultAttemptRow[] = [];
  if (fullSetIds.length === 0 || studentIds.length === 0) return rows;
  for (const itemBatch of chunk(fullSetIds)) {
    for (const studentBatch of chunk(studentIds)) {
      const result = await readAllSupabaseRows<FullSetAttemptRow>((from, to) =>
        db
          .from("reading_full_set_attempts")
          .select("attempt_id,student_id,full_set_id,status,completed_at,created_at")
          .in("full_set_id", itemBatch)
          .in("student_id", studentBatch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      for (const row of result.data ?? []) {
        rows.push({
          attemptId: String(row.attempt_id),
          completed: row.status === "completed",
          completedAt: row.completed_at,
          itemId: row.full_set_id,
          startedAt: row.created_at,
          studentId: row.student_id
        });
      }
    }
  }
  return rows;
}

type BuildSentenceAttemptRow = {
  attempt_id: string;
  student_id: string;
  set_id: string;
  submitted_at: string | null;
  created_at: string | null;
};

async function readBuildSentenceAttemptRows(
  db: SupabaseClient,
  setIds: string[],
  studentIds: string[]
) {
  const rows: ResultAttemptRow[] = [];
  if (setIds.length === 0 || studentIds.length === 0) return rows;
  for (const itemBatch of chunk(setIds)) {
    for (const studentBatch of chunk(studentIds)) {
      const result = await readAllSupabaseRows<BuildSentenceAttemptRow>((from, to) =>
        db
          .from("attempts")
          .select("attempt_id,student_id,set_id,submitted_at,created_at")
          .in("set_id", itemBatch)
          .in("student_id", studentBatch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      for (const row of result.data ?? []) {
        rows.push({
          attemptId: String(row.attempt_id),
          completed: Boolean(row.submitted_at),
          completedAt: row.submitted_at,
          itemId: row.set_id,
          startedAt: row.created_at,
          studentId: row.student_id
        });
      }
    }
  }
  return rows;
}

function unique(values: ReadonlyArray<string>) {
  return Array.from(new Set(values));
}

function chunk<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
