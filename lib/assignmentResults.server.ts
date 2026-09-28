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
 */

export type AssignmentResultLookupItem = {
  assignmentId: string;
  itemType: AssignmentItemType;
  /** Stable item identity stored as the Assignment item `question_id`. */
  itemId: string;
  /** BAS only: the raw question set the existing 套题记录 route is keyed by. */
  sourceSetId: string | null;
};

export type AssignmentStudentResult = {
  available_result: TeacherAssignmentItemResult | null;
  /** Any draft / in-progress row, so withdraw rules can see "开始作答". */
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

export async function loadAssignmentStudentResults(input: {
  db: SupabaseClient;
  items: ReadonlyArray<AssignmentResultLookupItem>;
  studentIds: ReadonlyArray<string>;
}): Promise<AssignmentStudentResultMap> {
  const results: AssignmentStudentResultMap = new Map();
  const studentIds = Array.from(new Set(input.studentIds));
  if (studentIds.length === 0) return results;

  const readingItems = input.items.filter(
    (item) => item.itemType === "ctw" || item.itemType === "rdl" || item.itemType === "rap"
  );
  const fullSetItems = input.items.filter((item) => item.itemType === "full_set");
  const basItems = input.items.filter(
    (item) => item.itemType === "build_sentence" && Boolean(item.sourceSetId)
  );

  const [readingRows, fullSetRows, basRows] = await Promise.all([
    readReadingAttemptRows(input.db, readingItems.map((item) => item.itemId), studentIds),
    readFullSetAttemptRows(input.db, fullSetItems.map((item) => item.itemId), studentIds),
    readBuildSentenceAttemptRows(
      input.db,
      basItems.map((item) => item.sourceSetId!).filter(Boolean),
      studentIds
    )
  ]);

  const latestReadingAttempt = new Map<string, { attemptId: string; status: string; submittedAt: string | null }>();
  for (const row of readingRows) {
    const key = `${row.logical_item_id}:${row.student_id}`;
    const current = latestReadingAttempt.get(key);
    if (
      !current
      || isLaterResultRow(
        { completed_at: row.submitted_at, id: String(row.attempt_id) },
        { completed_at: current.submittedAt, id: current.attemptId }
      )
    ) {
      latestReadingAttempt.set(key, {
        attemptId: String(row.attempt_id),
        status: row.status,
        submittedAt: row.submitted_at
      });
    }
  }
  for (const item of readingItems) {
    for (const studentId of studentIds) {
      const attempt = latestReadingAttempt.get(`${item.itemId}:${studentId}`);
      if (!attempt) continue;
      setResult(results, item.assignmentId, studentId, {
        available_result: attempt.status === "submitted"
          ? { completed_at: attempt.submittedAt, id: attempt.attemptId, kind: "reading_attempt" }
          : null,
        started: true
      });
    }
  }

  const latestFullSetAttempt = new Map<string, { attemptId: string; status: string; completedAt: string | null }>();
  for (const row of fullSetRows) {
    const key = `${row.full_set_id}:${row.student_id}`;
    const current = latestFullSetAttempt.get(key);
    if (
      !current
      || isLaterResultRow(
        { completed_at: row.completed_at, id: String(row.attempt_id) },
        { completed_at: current.completedAt, id: current.attemptId }
      )
    ) {
      latestFullSetAttempt.set(key, {
        attemptId: String(row.attempt_id),
        status: row.status,
        completedAt: row.completed_at
      });
    }
  }
  for (const item of fullSetItems) {
    for (const studentId of studentIds) {
      const attempt = latestFullSetAttempt.get(`${item.itemId}:${studentId}`);
      if (!attempt) continue;
      setResult(results, item.assignmentId, studentId, {
        available_result: attempt.status === "completed"
          ? { completed_at: attempt.completedAt, id: attempt.attemptId, kind: "reading_full_set" }
          : null,
        started: true
      });
    }
  }

  const basAttemptedSets = new Map<string, { attemptId: string | null; submittedAt: string | null }>();
  for (const row of basRows) {
    const key = `${String(row.set_id)}:${row.student_id}`;
    const current = basAttemptedSets.get(key);
    if (
      !current
      || (row.submitted_at && (!current.submittedAt || row.submitted_at > current.submittedAt))
    ) {
      basAttemptedSets.set(key, {
        attemptId: String(row.attempt_id),
        submittedAt: row.submitted_at
      });
    }
  }
  for (const item of basItems) {
    for (const studentId of studentIds) {
      const key = `${item.sourceSetId}:${studentId}`;
      const attempted = basAttemptedSets.get(key);
      if (!attempted) continue;
      setResult(results, item.assignmentId, studentId, {
        // The existing teacher 套题记录 route is keyed by the raw set id, not the
        // attempt id; the set page then lists the student's own attempts. The
        // student result route is keyed by the latest submitted attempt id.
        available_result: {
          attempt_id: attempted.attemptId,
          completed_at: attempted.submittedAt,
          id: item.sourceSetId!,
          kind: "bas_set"
        },
        started: true
      });
    }
  }

  return results;
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
};

async function readReadingAttemptRows(
  db: SupabaseClient,
  itemIds: string[],
  studentIds: string[]
) {
  const rows: ReadingAttemptRow[] = [];
  for (const itemBatch of chunk(itemIds)) {
    for (const studentBatch of chunk(studentIds)) {
      const result = await readAllSupabaseRows<ReadingAttemptRow>((from, to) =>
        db
          .from("reading_attempts")
          .select("attempt_id,student_id,logical_item_id,status,submitted_at")
          .in("logical_item_id", itemBatch)
          .in("student_id", studentBatch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      rows.push(...(result.data ?? []));
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
};

async function readFullSetAttemptRows(
  db: SupabaseClient,
  fullSetIds: string[],
  studentIds: string[]
) {
  const rows: FullSetAttemptRow[] = [];
  for (const itemBatch of chunk(fullSetIds)) {
    for (const studentBatch of chunk(studentIds)) {
      const result = await readAllSupabaseRows<FullSetAttemptRow>((from, to) =>
        db
          .from("reading_full_set_attempts")
          .select("attempt_id,student_id,full_set_id,status,completed_at")
          .in("full_set_id", itemBatch)
          .in("student_id", studentBatch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      rows.push(...(result.data ?? []));
    }
  }
  return rows;
}

type BuildSentenceAttemptRow = {
  attempt_id: string;
  student_id: string;
  set_id: string;
  submitted_at: string | null;
};

async function readBuildSentenceAttemptRows(
  db: SupabaseClient,
  setIds: string[],
  studentIds: string[]
) {
  const rows: BuildSentenceAttemptRow[] = [];
  for (const itemBatch of chunk(setIds)) {
    for (const studentBatch of chunk(studentIds)) {
      const result = await readAllSupabaseRows<BuildSentenceAttemptRow>((from, to) =>
        db
          .from("attempts")
          .select("attempt_id,student_id,set_id,submitted_at")
          .in("set_id", itemBatch)
          .in("student_id", studentBatch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      rows.push(...(result.data ?? []));
    }
  }
  return rows;
}

function chunk<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
