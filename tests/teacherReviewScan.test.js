import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeReviewPageCursor,
  parseReviewPageCursor,
  scanTeacherReviewPage
} from "../lib/teacherReviewScan.ts";
import { compareTeacherListUnitDesc } from "../lib/teacherListPagination.ts";

const BASE_AT = Date.parse("2026-11-24T10:00:00Z");

function row(index, overrides = {}) {
  return {
    attempt_id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    submitted_at: new Date(BASE_AT - index * 60_000).toISOString(),
    review_status: "published",
    ...overrides
  };
}

function cursorOf(item) {
  return { at: item.submitted_at ?? "", id: item.attempt_id };
}

function sortRows(rows) {
  return [...rows].sort((left, right) =>
    compareTeacherListUnitDesc(cursorOf(left), cursorOf(right))
  );
}

/** An already ordered stream that honours the keyset cursor like the API does. */
function stream(id, rows, enabled = true) {
  const ordered = sortRows(rows);
  return {
    id,
    enabled,
    load: async (cursor, limit) => {
      const remaining = cursor
        ? ordered.filter((item) => compareTeacherListUnitDesc(cursorOf(item), cursor) > 0)
        : ordered;
      return remaining.slice(0, limit);
    }
  };
}

async function scanAll(input) {
  const pages = [];
  let cursor = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await scanTeacherReviewPage({ ...input, cursor });
    pages.push(page.rows);
    if (!page.hasMore) {
      assert.equal(page.nextCursor, null);
      return pages;
    }
    assert.ok(page.nextCursor, "a page with hasMore must carry a cursor");
    cursor = parseReviewPageCursor(encodeReviewPageCursor(page.nextCursor));
  }
  assert.fail("scan did not finish");
}

test("interleaved sources merge in the shared order across pages", async () => {
  const left = Array.from({ length: 23 }, (_, index) => row(index * 2));
  const right = Array.from({ length: 22 }, (_, index) => row(index * 2 + 1));
  const pages = await scanAll({
    streams: [stream("self", left), stream("assignment", right)],
    limit: 20,
    batchSize: 20,
    maxBatches: 40,
    matches: () => true
  });
  const ids = pages.flat().map((item) => item.attempt_id);
  assert.equal(ids.length, 45);
  assert.equal(new Set(ids).size, 45);
  assert.deepEqual(
    ids,
    sortRows([...left, ...right]).map((item) => item.attempt_id)
  );
  assert.deepEqual(pages.map((page) => page.length), [20, 20, 5]);
});

test("a much larger source never hides the smaller source's rows", async () => {
  const big = Array.from({ length: 100 }, (_, index) => row(index * 3));
  const small = [row(1), row(4), row(7)];
  const pages = await scanAll({
    streams: [stream("self", big), stream("assignment", small)],
    limit: 20,
    batchSize: 15,
    maxBatches: 40,
    matches: () => true
  });
  const ids = pages.flat().map((item) => item.attempt_id);
  assert.equal(ids.length, 103);
  for (const item of small) assert.ok(ids.includes(item.attempt_id));
  assert.deepEqual(
    ids,
    sortRows([...big, ...small]).map((item) => item.attempt_id)
  );
});

test("a status filter can match rows in only one source", async () => {
  const self = Array.from({ length: 30 }, (_, index) =>
    row(index, { review_status: "published" })
  );
  const assignment = Array.from({ length: 30 }, (_, index) =>
    row(index + 1000, { review_status: "ignored" })
  );
  const pages = await scanAll({
    streams: [stream("self", self), stream("assignment", assignment)],
    limit: 20,
    batchSize: 25,
    maxBatches: 20,
    matches: (item) => item.review_status === "ignored"
  });
  const ids = pages.flat().map((item) => item.attempt_id);
  assert.equal(ids.length, 30);
  assert.deepEqual(ids, assignment.map((item) => item.attempt_id));
});

test("a long run of non-matching rows is fully scanned before reporting no more", async () => {
  const rows = [
    ...Array.from({ length: 120 }, (_, index) =>
      row(index, { review_status: "published" })
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      row(200 + index, { review_status: "reviewing" })
    )
  ];
  const pages = await scanAll({
    streams: [stream("self", rows)],
    limit: 20,
    batchSize: 40,
    maxBatches: 40,
    matches: (item) => item.review_status === "reviewing"
  });
  const ids = pages.flat().map((item) => item.attempt_id);
  assert.equal(ids.length, 5);
  assert.deepEqual(ids, rows.slice(120).map((item) => item.attempt_id));
});

test("the scan bound pauses safely and resumes with per-stream cursors", async () => {
  const matches = Array.from({ length: 5 }, (_, index) =>
    row(300 + index, { review_status: "reviewing" })
  );
  const rows = [
    ...Array.from({ length: 200 }, (_, index) =>
      row(index, { review_status: "published" })
    ),
    ...matches
  ];
  const allPages = await scanAll({
    streams: [stream("self", rows)],
    limit: 20,
    batchSize: 20,
    maxBatches: 2,
    matches: (item) => item.review_status === "reviewing"
  });
  const ids = allPages.flat().map((item) => item.attempt_id);
  assert.equal(ids.length, 5);
  assert.deepEqual(ids, matches.map((item) => item.attempt_id));
});

test("bounded scan state round-trips and rejects a tampered cursor", async () => {
  const cursor = {
    page: { at: "2026-11-20T00:00:00Z", id: "00000000-0000-0000-0000-000000000001" },
    state: {
      cursors: {
        "self-original": { at: "", id: "00000000-0000-0000-0000-000000000002" },
        "assignment-correction": null
      },
      exhausted: ["assignment-correction"]
    }
  };
  const encoded = encodeReviewPageCursor(cursor);
  assert.ok(encoded?.startsWith("r1:"));
  assert.deepEqual(parseReviewPageCursor(encoded), cursor);
  assert.equal(parseReviewPageCursor("r1:not-base64"), null);
  assert.equal(parseReviewPageCursor("garbage"), null);

  // A tampered id must be rejected instead of reaching a database query.
  const tampered = `r1:${Buffer.from(
    JSON.stringify({
      v: 1,
      page: { at: "2026-11-20T00:00:00Z", id: "not-a-uuid" },
      state: { cursors: {}, exhausted: [] }
    })
  ).toString("base64url")}`;
  assert.equal(parseReviewPageCursor(tampered), null);
});

test("equal submission times use the attempt id as the stable tiebreaker", async () => {
  const sameTime = "2026-11-20T00:00:00.000Z";
  const rows = [
    row(1, { submitted_at: sameTime }),
    row(2, { submitted_at: sameTime }),
    row(3, { submitted_at: sameTime })
  ];
  const pages = await scanAll({
    streams: [stream("self", rows)],
    limit: 2,
    batchSize: 2,
    maxBatches: 10,
    matches: () => true
  });
  assert.deepEqual(pages.map((page) => page.length), [2, 1]);
  assert.deepEqual(
    pages.flat().map((item) => item.attempt_id),
    [row(3), row(2), row(1)].map((item) => item.attempt_id)
  );
});

test("empty result and no more rows report a clean terminal page", async () => {
  const page = await scanTeacherReviewPage({
    streams: [stream("self", []), stream("assignment", [])],
    cursor: null,
    limit: 20,
    batchSize: 20,
    maxBatches: 10,
    matches: () => true
  });
  assert.deepEqual(page.rows, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test("original and correction rows merge while keeping their own status source", async () => {
  const originals = Array.from({ length: 22 }, (_, index) =>
    row(index * 2, { review_status: "published" })
  );
  const corrections = Array.from({ length: 4 }, (_, index) =>
    row(index * 2 + 1, { review_status: "reviewing" })
  );
  const pages = await scanAll({
    streams: [stream("self-original", originals), stream("self-correction", corrections)],
    limit: 20,
    batchSize: 20,
    maxBatches: 20,
    matches: (item) => item.review_status === "reviewing"
  });
  const ids = pages.flat().map((item) => item.attempt_id);
  assert.deepEqual(ids, corrections.map((item) => item.attempt_id));
});
