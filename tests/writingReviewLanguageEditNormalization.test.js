const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeLanguageEditOverlaps
} = require("../lib/writingReviewLanguageEditNormalization.ts");

function edit(response, original, replacement, id, from = 0) {
  const start = response.indexOf(original, from);
  return {
    edit_id: id,
    original_text: original,
    replacement_text: replacement,
    category: "grammar",
    severity: "major",
    explanation: `修正 ${id}。`,
    start,
    end: start + original.length,
    restored: false
  };
}

function assertInvariants(response, edits) {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  ordered.forEach((item, index) => {
    assert.equal(response.slice(item.start, item.end), item.original_text);
    if (index > 0) assert.ok(ordered[index - 1].end <= item.start);
  });
}

test("no overlap does not change Language Edits", () => {
  const response = "Bad start and bad end.";
  const edits = [
    edit(response, "Bad", "Good", "a"),
    edit(response, "bad end", "good ending", "b")
  ];
  const result = normalizeLanguageEditOverlaps(response, edits);
  assert.equal(result.edits, edits);
  assert.equal(result.diagnostic, null);
});

test("exact duplicate is deterministically deduplicated", () => {
  const response = "This are wrong.";
  const first = edit(response, "are", "is", "a");
  const second = { ...first, edit_id: "b", explanation: "主谓一致错误，需要使用单数动词。" };
  const result = normalizeLanguageEditOverlaps(response, [first, second]);
  assert.equal(result.edits.length, 1);
  assert.equal(result.diagnostic.groups[0].action, "deduplicated");
  assert.equal(result.diagnostic.groups[0].suppressed_edits.length, 1);
  assertInvariants(response, result.edits);
});

test("broad and contained equivalent corrections keep the smallest edit", () => {
  const response = "some issue happens";
  const result = normalizeLanguageEditOverlaps(response, [
    edit(response, "some issue", "some issues", "broad"),
    edit(response, "issue", "issues", "small")
  ]);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].original_text, "issue");
  assert.equal(result.diagnostic.groups[0].action, "kept_minimal_equivalent");
  assertInvariants(response, result.edits);
});

test("context-only overlap merges non-overlapping actual changed cores", () => {
  const response = "bad word here";
  const result = normalizeLanguageEditOverlaps(response, [
    edit(response, "bad word", "good word", "a"),
    edit(response, "word here", "word there", "b")
  ]);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].original_text, response);
  assert.equal(result.edits[0].replacement_text, "good word there");
  assert.equal(result.diagnostic.groups[0].action, "merged_context_overlap");
  assertInvariants(response, result.edits);
});

test("compatible overlapping corrections use an existing carrier correction", () => {
  const response = "bad cats remain";
  const result = normalizeLanguageEditOverlaps(response, [
    edit(response, "bad cats", "good dogs", "carrier"),
    edit(response, "cats", "dogs", "contained")
  ]);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0].replacement_text, "good dogs");
  assert.equal(result.diagnostic.groups[0].action, "merged_compatible");
  assertInvariants(response, result.edits);
});

test("true conflicting replacements suppress deterministically without failing review", () => {
  const response = "bad result";
  const alternatives = [
    edit(response, "bad", "poor", "z"),
    edit(response, "bad", "wrong", "a")
  ];
  const forward = normalizeLanguageEditOverlaps(response, alternatives);
  const reverse = normalizeLanguageEditOverlaps(response, [...alternatives].reverse());
  assert.equal(forward.edits.length, 1);
  assert.equal(forward.edits[0].edit_id, reverse.edits[0].edit_id);
  assert.equal(forward.diagnostic.groups[0].action, "suppressed_conflict");
  assert.equal(forward.diagnostic.groups[0].suppressed_edits.length, 1);
  assertInvariants(response, forward.edits);
});

test("A-B-C connected overlaps normalize as one group", () => {
  const response = "bad word here now";
  const result = normalizeLanguageEditOverlaps(response, [
    edit(response, "bad word", "good word", "a"),
    edit(response, "word here", "word there", "b"),
    edit(response, "here now", "here soon", "c")
  ]);
  assert.equal(result.diagnostic.group_count, 1);
  assert.equal(result.diagnostic.groups[0].edits.length, 3);
  assert.equal(result.edits[0].replacement_text, "good word there soon");
  assertInvariants(response, result.edits);
});
