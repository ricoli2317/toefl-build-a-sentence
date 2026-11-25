import {
  compareTeacherListUnitDesc,
  encodeTeacherListCursor,
  parseTeacherListCursor,
  type TeacherListCursor
} from "./teacherListPagination.ts";
import type { WritingReviewListStatus } from "./teacherWritingReviewList.ts";

/**
 * Shared cursor scanner for the teacher Writing Review list.
 *
 * The list has up to four disjoint ordered streams (free practice / assignment
 * attempts × original / correction). Each stream keeps its own keyset cursor,
 * so a deep stream can never be skipped just because another stream ended
 * earlier. Streams are merged by the same `(submitted_at DESC, attempt_id DESC)`
 * order the UI already uses.
 *
 * A normal page cuts after 20 matches and resumes every stream from the last
 * emitted row. When a bounded scan reaches its limit without collecting a full
 * page, the response carries the per-stream cursors too; the next request
 * resumes each stream exactly where it stopped, so a long run of filtered-out
 * rows can neither omit nor duplicate a later match.
 */
export type ReviewScanRow = {
  attempt_id: string;
  submitted_at: string | null;
  review_status: WritingReviewListStatus;
};

export type ReviewScanStream<T extends ReviewScanRow> = {
  id: string;
  enabled: boolean;
  load: (cursor: TeacherListCursor | null, limit: number) => Promise<T[]>;
};

export type ReviewScanState = {
  /** Last fetched row of each stream; streams without a cursor start at the page cursor. */
  cursors: Record<string, TeacherListCursor | null>;
  /** Streams already known to have no more rows. */
  exhausted: string[];
};

export type ReviewPageCursor = {
  page: TeacherListCursor | null;
  /** Present only when a bounded scan stopped before exhausting its streams. */
  state: ReviewScanState | null;
};

export type ReviewScanPage<T extends ReviewScanRow> = {
  rows: T[];
  hasMore: boolean;
  nextCursor: ReviewPageCursor | null;
};

export async function scanTeacherReviewPage<T extends ReviewScanRow>(input: {
  streams: ReadonlyArray<ReviewScanStream<T>>;
  cursor: ReviewPageCursor | null;
  limit: number;
  batchSize: number;
  maxBatches: number;
  matches: (row: T) => boolean;
}): Promise<ReviewScanPage<T>> {
  const limit = Math.max(1, Math.trunc(input.limit));
  const batchSize = Math.max(1, Math.trunc(input.batchSize));
  const maxBatches = Math.max(1, Math.trunc(input.maxBatches));
  const streams = input.streams
    .filter((stream) => stream.enabled)
    .map((stream) => ({
      ...stream,
      cursor:
        input.cursor?.state?.cursors[stream.id] ?? input.cursor?.page ?? null,
      exhausted: input.cursor?.state?.exhausted.includes(stream.id) ?? false,
      buffer: [] as T[]
    }));

  const collected: T[] = [];
  let scanCursor = input.cursor?.page ?? null;
  let batches = 0;

  while (collected.length <= limit) {
    for (const stream of streams) {
      if (stream.exhausted || stream.buffer.length > 0) continue;
      if (batches >= maxBatches) break;
      batches += 1;
      const rows = await stream.load(stream.cursor, batchSize);
      if (rows.length < batchSize) stream.exhausted = true;
      if (rows.length > 0) {
        stream.cursor = cursorOf(rows[rows.length - 1]);
      }
      stream.buffer = rows;
    }

    const candidates = streams.filter((stream) => stream.buffer.length > 0);
    if (candidates.length === 0) {
      if (streams.every((stream) => stream.exhausted)) break;
      if (batches >= maxBatches) break;
      continue;
    }
    const nextStream = candidates.reduce((left, right) =>
      compareTeacherListUnitDesc(
        cursorOf(left.buffer[0]),
        cursorOf(right.buffer[0])
      ) <= 0
        ? left
        : right
    );
    const row = nextStream.buffer.shift();
    if (!row) break;
    scanCursor = cursorOf(row);
    if (!input.matches(row)) continue;
    collected.push(row);
  }

  const exhausted = streams.every(
    (stream) => stream.exhausted && stream.buffer.length === 0
  );
  const hasMore = collected.length > limit ? true : !exhausted;
  const rows = collected.slice(0, limit);
  let nextCursor: ReviewPageCursor | null = null;
  if (hasMore) {
    if (collected.length > limit) {
      const last = rows[rows.length - 1];
      nextCursor = {
        page: last ? cursorOf(last) : scanCursor,
        state: null
      };
    } else {
      // The scan bound stopped before a full page. Keep every stream's own
      // position so the next request cannot skip unfetched rows of a source
      // whose batch did not reach the merged page boundary.
      nextCursor = {
        page: scanCursor,
        state: {
          cursors: Object.fromEntries(
            streams.map((stream) => [stream.id, stream.cursor])
          ),
          exhausted: streams
            .filter((stream) => stream.exhausted)
            .map((stream) => stream.id)
        }
      };
    }
  }
  return { rows, hasMore, nextCursor };
}

function cursorOf(row: ReviewScanRow): TeacherListCursor {
  return {
    at: row.submitted_at ?? "",
    id: String(row.attempt_id)
  };
}

/**
 * The review list cursor is opaque to the client. A normal page cursor is the
 * existing `timestamp|id` format; a bounded-scan cursor additionally carries
 * the per-stream positions in a compact base64url payload.
 */
export function encodeReviewPageCursor(cursor: ReviewPageCursor | null): string | null {
  if (!cursor) return null;
  if (!cursor.state) return encodeTeacherListCursor(cursor.page);
  const payload = JSON.stringify({
    v: 1,
    page: cursor.page,
    state: cursor.state
  });
  return `r1:${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function parseReviewPageCursor(
  value: string | null | undefined
): ReviewPageCursor | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  if (!text.startsWith("r1:")) {
    const page = parseTeacherListCursor(text);
    return page ? { page, state: null } : null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(text.slice(3), "base64url").toString("utf8")
    ) as unknown;
    if (!isRecord(decoded) || decoded.v !== 1) return null;
    let page: TeacherListCursor | null = null;
    if (decoded.page !== null) {
      page = parseCursorValue(decoded.page);
      if (!page) return null;
    }
    const stateValue = decoded.state;
    if (!isRecord(stateValue)) return null;
    const cursorValues = stateValue.cursors;
    if (!isRecord(cursorValues)) return null;
    const cursors: Record<string, TeacherListCursor | null> = {};
    for (const [streamId, value] of Object.entries(cursorValues)) {
      if (!streamId) return null;
      const cursor = parseCursorValue(value);
      if (value !== null && !cursor) return null;
      cursors[streamId] = cursor;
    }
    const exhaustedValue = stateValue.exhausted;
    if (!Array.isArray(exhaustedValue)) return null;
    const exhausted = exhaustedValue.filter(
      (value): value is string => typeof value === "string" && value.length > 0
    );
    if (exhausted.length !== exhaustedValue.length) return null;
    return { page, state: { cursors, exhausted } };
  } catch {
    return null;
  }
}

function parseCursorValue(value: unknown): TeacherListCursor | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  const at = typeof value.at === "string" ? value.at : null;
  const id = typeof value.id === "string" ? value.id : null;
  if (at === null || id === null) return null;
  return parseTeacherListCursor(`${at}|${id}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
