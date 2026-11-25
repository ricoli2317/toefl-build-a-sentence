/**
 * Shared cursor pagination primitives for the teacher Writing lists
 * (作业管理 / 写作批改).
 *
 * Every list uses the same contract:
 *
 *   - a page is a fixed number of display units (default 20),
 *   - the order is stable: `created_at` / `submitted_at` DESC with the unique
 *     row id as the tiebreaker,
 *   - the cursor is the sort key of the last emitted row, and the next page
 *     only reads rows strictly after it. Inserting a newer row can therefore
 *     never duplicate or skip an already emitted row.
 *
 * The cursor is a plain `timestamp|id` string; callers URL-encode it when it
 * travels in a query string. Timestamps may be empty for the legacy
 * "submitted_at is null" tail of the writing review order.
 */

export const TEACHER_LIST_PAGE_SIZE = 20;
export const TEACHER_LIST_MAX_PAGE_SIZE = 50;

export type TeacherListCursor = {
  /** Sort timestamp. Empty only for the `submitted_at is null` attempt tail. */
  at: string;
  /** Unique row id used as the stable DESC tiebreaker. */
  id: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clampTeacherListLimit(value: string | null | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return TEACHER_LIST_PAGE_SIZE;
  return Math.min(
    TEACHER_LIST_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(parsed))
  );
}

export function encodeTeacherListCursor(cursor: TeacherListCursor | null) {
  return cursor ? `${cursor.at}|${cursor.id}` : null;
}

export function parseTeacherListCursor(value: string | null | undefined): TeacherListCursor | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) return null;
  const separator = normalized.indexOf("|");
  if (separator < 0) return null;
  const at = normalized.slice(0, separator).trim();
  const id = normalized.slice(separator + 1).trim();
  if (!UUID_PATTERN.test(id)) return null;
  if (at && Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}

export function teacherListTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * PostgREST `.or(...)` body for a `(timestamp DESC, id DESC)` keyset. The
 * timestamp is double-quoted so `:` / `+` / `,` stay inside one value.
 */
export function createdAtKeysetFilter(
  cursor: TeacherListCursor,
  timestampColumn: string,
  idColumn: string
) {
  const timestamp = `"${cursor.at}"`;
  return [
    `${timestampColumn}.lt.${timestamp}`,
    `and(${timestampColumn}.eq.${timestamp},${idColumn}.lt.${cursor.id})`
  ].join(",");
}

/**
 * The writing review order puts rows without `submitted_at` last, so the
 * cursor filter has three branches: older timestamps, the same timestamp with
 * a smaller attempt id, and the whole null timestamp tail.
 */
export function submittedAtKeysetFilter(
  cursor: TeacherListCursor,
  timestampColumn = "submitted_at",
  idColumn = "attempt_id"
) {
  if (!cursor.at) {
    return `and(${timestampColumn}.is.null,${idColumn}.lt.${cursor.id})`;
  }
  const timestamp = `"${cursor.at}"`;
  return [
    `${timestampColumn}.lt.${timestamp}`,
    `and(${timestampColumn}.eq.${timestamp},${idColumn}.lt.${cursor.id})`,
    `${timestampColumn}.is.null`
  ].join(",");
}

/**
 * Merge two already ordered `(timestamp DESC, id DESC)` pages into one stream
 * without losing the stable tiebreaker. `at` may be empty (null timestamp),
 * which always sorts last.
 */
export function mergeTeacherListUnitsDesc<T>(
  left: readonly T[],
  right: readonly T[],
  read: (row: T) => { at: string | null | undefined; id: string }
): T[] {
  const merged: T[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    if (leftIndex >= left.length) {
      merged.push(right[rightIndex]);
      rightIndex += 1;
      continue;
    }
    if (rightIndex >= right.length) {
      merged.push(left[leftIndex]);
      leftIndex += 1;
      continue;
    }
    const comparison = compareTeacherListUnitDesc(
      read(left[leftIndex]),
      read(right[rightIndex])
    );
    if (comparison <= 0) {
      merged.push(left[leftIndex]);
      leftIndex += 1;
    } else {
      merged.push(right[rightIndex]);
      rightIndex += 1;
    }
  }
  return merged;
}

export function compareTeacherListUnitDesc(
  left: { at: string | null | undefined; id: string },
  right: { at: string | null | undefined; id: string }
) {
  const leftTime = teacherListTimestamp(left.at);
  const rightTime = teacherListTimestamp(right.at);
  if (leftTime !== rightTime) {
    if (leftTime === null) return 1;
    if (rightTime === null) return -1;
    return rightTime - leftTime;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}
