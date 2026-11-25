import assert from "node:assert/strict";
import test from "node:test";

import {
  compareTeacherListUnitDesc,
  createdAtKeysetFilter,
  encodeTeacherListCursor,
  mergeTeacherListUnitsDesc,
  parseTeacherListCursor,
  submittedAtKeysetFilter
} from "../lib/teacherListPagination.ts";

const AT = "2026-11-24T10:01:42.195688+00:00";
const ID = "bdd0bd35-e23d-4b59-934f-cbc9de875a93";

test("cursor helpers round-trip and reject malformed values", () => {
  assert.equal(encodeTeacherListCursor(null), null);
  assert.equal(encodeTeacherListCursor({ at: AT, id: ID }), `${AT}|${ID}`);
  assert.deepEqual(parseTeacherListCursor(`${AT}|${ID}`), { at: AT, id: ID });
  // The null-timestamp attempt tail keeps an empty timestamp.
  assert.deepEqual(parseTeacherListCursor(`|${ID}`), { at: "", id: ID });
  assert.equal(parseTeacherListCursor(""), null);
  assert.equal(parseTeacherListCursor("not-a-cursor"), null);
  assert.equal(parseTeacherListCursor(`not-a-date|${ID}`), null);
  assert.equal(parseTeacherListCursor(`${AT}|not-a-uuid`), null);
});

test("keyset filters quote the timestamp and keep the unique tiebreaker", () => {
  const cursor = { at: AT, id: ID };
  assert.equal(
    createdAtKeysetFilter(cursor, "created_at", "group_id"),
    `created_at.lt."${AT}",and(created_at.eq."${AT}",group_id.lt.${ID})`
  );
  assert.equal(
    submittedAtKeysetFilter(cursor),
    `submitted_at.lt."${AT}",and(submitted_at.eq."${AT}",attempt_id.lt.${ID}),submitted_at.is.null`
  );
  // Null timestamps sort last, so only the null tail with a smaller id remains.
  assert.equal(
    submittedAtKeysetFilter({ at: "", id: ID }),
    `and(submitted_at.is.null,attempt_id.lt.${ID})`
  );
});

test("two already ordered sources merge with the same DESC order and no duplicate", () => {
  const left = [
    { id: "a", at: "2026-11-24T10:00:00Z", source: "group" },
    { id: "c", at: "2026-11-20T10:00:00Z", source: "group" },
    { id: "e", at: null, source: "group" }
  ];
  const right = [
    { id: "b", at: "2026-11-22T10:00:00Z", source: "assignment" },
    { id: "d", at: "2026-11-20T10:00:00Z", source: "assignment" },
    { id: "f", at: null, source: "assignment" }
  ];
  const merged = mergeTeacherListUnitsDesc(left, right, (unit) => unit);
  assert.deepEqual(
    merged.map((unit) => unit.id),
    ["a", "b", "d", "c", "f", "e"]
  );
  assert.equal(new Set(merged.map((unit) => unit.id)).size, merged.length);
  // Null timestamps always go last.
  assert.equal(compareTeacherListUnitDesc({ at: null, id: "z" }, { at: AT, id: "a" }), 1);
  assert.equal(compareTeacherListUnitDesc({ at: AT, id: "z" }, { at: AT, id: "a" }), -1);
  assert.equal(compareTeacherListUnitDesc({ at: AT, id: "a" }, { at: AT, id: "a" }), 0);
});

test("cursor pages over 45 units keep order, never duplicate and stop on a short page", () => {
  const units = Array.from({ length: 45 }, (_, index) => ({
    id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
    at: `2026-11-${String(28 - Math.floor(index / 2)).padStart(2, "0")}T10:00:00Z`
  })).sort(compareTeacherListUnitDesc);

  const pageSize = 20;
  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const remaining = cursor
      ? units.filter((unit) => compareTeacherListUnitDesc(unit, cursor) > 0)
      : units;
    const page = remaining.slice(0, pageSize);
    pages += 1;
    seen.push(...page.map((unit) => unit.id));
    if (page.length < pageSize) break;
    cursor = page[page.length - 1];
  }
  assert.equal(pages, 3);
  assert.equal(seen.length, 45);
  assert.equal(new Set(seen).size, 45);
  assert.deepEqual(seen, units.map((unit) => unit.id));
});
