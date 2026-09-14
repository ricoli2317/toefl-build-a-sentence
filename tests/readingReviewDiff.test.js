const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildReadingInlineDiff } = require("../lib/reading/reviewDiff.ts");

const root = path.resolve(__dirname, "..");

function renderedText(segments) {
  return segments.map((segment) => segment.text).join("");
}

function changedText(segments) {
  return segments.filter((segment) => segment.changed).map((segment) => segment.text).join("");
}

for (const [name, existing, incoming, existingChange, incomingChange] of [
  [
    "word insertion",
    "A sale of used photo equipment",
    "A sale of used photography equipment",
    "",
    "graphy"
  ],
  ["character insertion", "artifical", "artificial", "", "i"],
  [
    "trailing insertion",
    "most effective",
    "most effective strategies for combating AMR.",
    "",
    " strategies for combating AMR."
  ],
  [
    "deletion",
    "most effective strategies for combating AMR.",
    "most effective",
    " strategies for combating AMR.",
    ""
  ]
]) {
  test(`Reading inline diff preserves only real source text for ${name}`, () => {
    const diff = buildReadingInlineDiff(existing, incoming);
    assert.equal(renderedText(diff.existing), existing);
    assert.equal(renderedText(diff.incoming), incoming);
    assert.equal(changedText(diff.existing), existingChange);
    assert.equal(changedText(diff.incoming), incomingChange);
    assert.doesNotMatch(JSON.stringify(diff), /∅|Ø|\[缺失\]/);
  });
}

test("CTW, RDL, and RAP reviews share the placeholder-free inline renderer", () => {
  const renderer = fs.readFileSync(path.join(
    root,
    "components/import/ReadingInlineVersionValue.tsx"
  ), "utf8");
  const contentReview = fs.readFileSync(path.join(
    root,
    "components/import/ReadingContentConflictList.tsx"
  ), "utf8");
  const duplicateReview = fs.readFileSync(path.join(
    root,
    "components/import/ReadingDuplicateResolutionList.tsx"
  ), "utf8");
  const ctwDifferences = fs.readFileSync(path.join(
    root,
    "lib/reading/ctwDuplicateDifferences.ts"
  ), "utf8");

  assert.match(contentReview, /import \{ ReadingInlineVersionValue \}/);
  assert.match(duplicateReview, /import \{ ReadingInlineVersionValue \}/);
  assert.match(renderer, /\{segment\.text\}/);
  for (const source of [renderer, contentReview, duplicateReview, ctwDifferences]) {
    assert.doesNotMatch(source, /∅|Ø|\[缺失\]/);
  }
});
