const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSentenceDisplay } = require("../lib/questionText.ts");

test("reconstructs a wrong chunk order with fixed template text", () => {
  assert.equal(
    buildSentenceDisplay(
      "I ___ ___ the engaging story.",
      '["not","find"]'
    ),
    "I not find the engaging story."
  );
});

test("reconstructs multiple blanks without moving submitted chunks", () => {
  assert.equal(
    buildSentenceDisplay(
      "The ___ that ___ the students was canceled.",
      '["lecture","confused"]'
    ),
    "The lecture that confused the students was canceled."
  );
});

test("keeps punctuation in its template position", () => {
  assert.equal(
    buildSentenceDisplay(
      "Why did ___ ___, ___?",
      '["the professor","leave","early"]'
    ),
    "Why did the professor leave, early?"
  );
});

test("empty submitted content remains unanswered", () => {
  assert.equal(buildSentenceDisplay("I ___ today.", "[]") || "未作答", "未作答");
  assert.equal(buildSentenceDisplay("I ___ today.", "") || "未作答", "未作答");
  assert.equal(buildSentenceDisplay("I ___ today.", null) || "未作答", "未作答");
});

test("does not correct the student's grammar or chunk order", () => {
  assert.equal(
    buildSentenceDisplay(
      "She ___ ___ to class.",
      '["do not","goes"]'
    ),
    "She do not goes to class."
  );
});
