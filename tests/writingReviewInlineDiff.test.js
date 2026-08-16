const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeInlineRevisionDiff
} = require("../lib/writingReviewInlineDiff.ts");

test("visual diff isolates am to was while preserving common words", () => {
  assert.deepEqual(computeInlineRevisionDiff("I am writing", "I was writing"), {
    prefix: "I ",
    originalChanged: "am",
    replacementChanged: "was",
    suffix: " writing"
  });
});

test("visual diff expands event plus deleted s to the readable whole token", () => {
  assert.deepEqual(computeInlineRevisionDiff("this events", "this event"), {
    prefix: "this ",
    originalChanged: "events",
    replacementChanged: "event",
    suffix: ""
  });
});

test("visual diff preserves a shared prefix", () => {
  const result = computeInlineRevisionDiff("Please send it", "Please share it");
  assert.equal(result.prefix, "Please ");
  assert.equal(result.originalChanged, "send");
  assert.equal(result.replacementChanged, "share");
  assert.equal(result.suffix, " it");
});

test("visual diff preserves a shared suffix", () => {
  const result = computeInlineRevisionDiff("old response", "new response");
  assert.equal(result.originalChanged, "old");
  assert.equal(result.replacementChanged, "new");
  assert.equal(result.suffix, " response");
});

test("visual diff handles pure insertion and deletion without throwing", () => {
  assert.deepEqual(computeInlineRevisionDiff("", "please"), {
    prefix: "", originalChanged: "", replacementChanged: "please", suffix: ""
  });
  assert.deepEqual(computeInlineRevisionDiff("please", ""), {
    prefix: "", originalChanged: "please", replacementChanged: "", suffix: ""
  });
});

test("visual diff handles complete phrase replacement", () => {
  assert.deepEqual(computeInlineRevisionDiff("old idea", "new claim"), {
    prefix: "", originalChanged: "old idea", replacementChanged: "new claim", suffix: ""
  });
});

test("visual diff safely accepts unusual text", () => {
  assert.doesNotThrow(() => computeInlineRevisionDiff("🙂a", "🙂b"));
  const result = computeInlineRevisionDiff("🙂a", "🙂b");
  assert.equal(result.prefix, "🙂");
  assert.equal(result.originalChanged, "a");
  assert.equal(result.replacementChanged, "b");
});
