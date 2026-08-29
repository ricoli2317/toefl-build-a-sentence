const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { toStudentReadingPracticePayload } = require("../lib/reading/studentPractice.ts");
const {
  backspaceCtwLetter,
  calculateReadingElapsedSeconds,
  createCtwSlotAnswers,
  deleteCtwLetter,
  enterCtwLetter,
  firstCtwPosition,
  setReadingAnswer
} = require("../lib/reading/practiceState.ts");

const slotModels = [
  { slotId: "slot-b", slotOrder: 2, missingLength: 2 },
  { slotId: "slot-a", slotOrder: 1, missingLength: 3 }
];

function emptyAnswers() {
  return createCtwSlotAnswers(slotModels);
}

function position(slotId, characterIndex) {
  return { slotId, characterIndex };
}

function ctwFixturePayload() {
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../data/reading/fixtures/reading-source.fixture.json"),
    "utf8"
  ));
  const packageData = groupReadingSourceOccurrences(source.occurrences).packages.find(
    (candidate) => candidate.item.module === "ctw"
  );
  return toStudentReadingPracticePayload(packageData);
}

test("initial CTW focus targets the first slot and first character by slot order", () => {
  assert.deepEqual(firstCtwPosition(slotModels), position("slot-a", 0));
});

test("one ASCII letter updates exactly one position and advances within the word", () => {
  const result = enterCtwLetter(slotModels, emptyAnswers(), position("slot-a", 0), "Q");
  assert.equal(result.accepted, true);
  assert.deepEqual(result.slots["slot-a"], ["Q", "", ""]);
  assert.deepEqual(result.focus, position("slot-a", 1));
});

test("completing a word advances to the next ordered slot", () => {
  const answers = { ...emptyAnswers(), "slot-a": ["a", "b", ""] };
  const result = enterCtwLetter(slotModels, answers, position("slot-a", 2), "c");
  assert.deepEqual(result.slots["slot-a"], ["a", "b", "c"]);
  assert.deepEqual(result.focus, position("slot-b", 0));
});

test("completing the final slot loops focus to the first position", () => {
  const answers = { "slot-a": ["a", "b", "c"], "slot-b": ["d", ""] };
  const result = enterCtwLetter(slotModels, answers, position("slot-b", 1), "e");
  assert.deepEqual(result.focus, position("slot-a", 0));
});

test("typing at a clicked middle position replaces only that character", () => {
  const answers = { "slot-a": ["a", "b", "c"], "slot-b": ["d", "e"] };
  const result = enterCtwLetter(slotModels, answers, position("slot-a", 1), "Z");
  assert.deepEqual(result.slots["slot-a"], ["a", "Z", "c"]);
  assert.deepEqual(result.slots["slot-b"], ["d", "e"]);
});

test("position state preserves a middle hole and later entered characters", () => {
  const answers = { ...emptyAnswers(), "slot-a": ["a", "", "c"] };
  const result = enterCtwLetter(slotModels, answers, position("slot-b", 0), "d");
  assert.deepEqual(result.slots["slot-a"], ["a", "", "c"]);
  assert.deepEqual(result.slots["slot-b"], ["d", ""]);
});

test("Backspace clears the current character without moving", () => {
  const answers = { ...emptyAnswers(), "slot-a": ["a", "b", ""] };
  const result = backspaceCtwLetter(slotModels, answers, position("slot-a", 1));
  assert.deepEqual(result.slots["slot-a"], ["a", "", ""]);
  assert.deepEqual(result.focus, position("slot-a", 1));
});

test("Backspace on an empty position moves backward and clears across slot boundaries", () => {
  const answers = { "slot-a": ["a", "b", "c"], "slot-b": ["", ""] };
  const result = backspaceCtwLetter(slotModels, answers, position("slot-b", 0));
  assert.deepEqual(result.slots["slot-a"], ["a", "b", ""]);
  assert.deepEqual(result.focus, position("slot-a", 2));
  const first = backspaceCtwLetter(slotModels, emptyAnswers(), position("slot-a", 0));
  assert.deepEqual(first.focus, position("slot-a", 0));
});

test("Delete clears only the focused character and preserves focus", () => {
  const answers = { "slot-a": ["a", "b", "c"], "slot-b": ["d", "e"] };
  const result = deleteCtwLetter(slotModels, answers, position("slot-a", 1));
  assert.deepEqual(result.slots["slot-a"], ["a", "", "c"]);
  assert.deepEqual(result.slots["slot-b"], ["d", "e"]);
  assert.deepEqual(result.focus, position("slot-a", 1));
});

test("non-ASCII letters and multi-character input are rejected without changing state", () => {
  const answers = emptyAnswers();
  for (const input of ["1", " ", ".", "中", "🙂", "ab"]) {
    const result = enterCtwLetter(slotModels, answers, position("slot-a", 0), input);
    assert.equal(result.accepted, false);
    assert.equal(result.slots, answers);
  }
});

test("student-safe CTW payload retains paragraph and segment order without answers", () => {
  const payload = ctwFixturePayload();
  const question = payload.questions[0];
  assert.equal(question.questionType, "ctw");
  assert.deepEqual(question.paragraphs.map((paragraph) => paragraph.paragraphOrder), [1, 2]);
  assert.deepEqual(
    question.paragraphs.flatMap((paragraph) => paragraph.segments)
      .filter((segment) => segment.kind === "blank")
      .map((segment) => segment.slotId),
    question.slots.map((slot) => slot.slotId)
  );
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("missingText"));
  assert.ok(!serialized.includes("\"answer\""));
  assert.ok(!serialized.includes("population"));
});

test("Reading answer state keeps CTW character positions across rerenders", () => {
  const slotAnswers = { ...emptyAnswers(), "slot-a": ["a", "", "c"] };
  const state = setReadingAnswer({}, "question-1", { kind: "ctw", slots: slotAnswers });
  const rerenderedAnswer = state["question-1"];
  assert.equal(rerenderedAnswer.kind, "ctw");
  assert.deepEqual(rerenderedAnswer.slots["slot-a"], ["a", "", "c"]);
});

test("CTW edits and focus movement do not alter the Reading timer anchor", () => {
  const startedAt = 10_000;
  const before = calculateReadingElapsedSeconds(startedAt, 12_100);
  enterCtwLetter(slotModels, emptyAnswers(), position("slot-a", 0), "a");
  const after = calculateReadingElapsedSeconds(startedAt, 15_900);
  assert.equal(before, 2);
  assert.equal(after, 5);
});

test("CTW workspace keeps one raised line per missing letter and one persistent fill-region background", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const writingSource = fs.readFileSync(
    path.join(__dirname, "../components/writing/WritingPractice.tsx"),
    "utf8"
  );
  assert.match(source, /paragraph\.segments\.map/);
  assert.match(source, /data-ctw-position/);
  assert.match(source, /data-filled/);
  assert.match(source, /data-ctw-fill-region="true"/);
  assert.match(source, /bg-\[#f1f2f5\]/);
  assert.match(source, /border-b-\[1\.5px\]/);
  assert.match(source, /mx-\[0\.07em\]/);
  assert.match(source, /h-\[0\.72em\]/);
  assert.match(source, /align-baseline/);
  assert.match(source, /leading-none/);
  assert.match(source, /\{character \|\| null\}/);
  assert.match(source, /\? `inline leading-\[inherit\] outline-none/);
  assert.match(source, /readOnly \? "cursor-default" : "cursor-text/);
  const blankWordSource = source.slice(source.indexOf("function CtwBlankWord"), source.indexOf("function ctwPositionKey"));
  assert.ok(blankWordSource.indexOf("data-ctw-fill-region") < blankWordSource.indexOf("characters.map"));
  assert.equal((blankWordSource.match(/bg-\[#f1f2f5\]/g) ?? []).length, 1);
  assert.doesNotMatch(blankWordSource, /tracking-/);
  assert.match(source, /WritingPracticeActions/);
  assert.match(source, /components\/writing\/WritingPracticeActions/);
  assert.match(writingSource, /components\/writing\/WritingPracticeActions/);
  assert.match(source, /Fill in the missing letters in the paragraph\./);
  assert.doesNotMatch(source, /Type the missing letters in the passage\.|1 个完整练习|个填写位置/);
  assert.match(source, /focusPosition\(firstCtwPosition/);
  assert.match(source, /if \(module === "ctw" && !readOnly\)/);
  assert.doesNotMatch(source, /rawText\.(match|replace)|querySelector|setTimeout/);
});

test("active CTW position renders one non-layout blinking caret before its letter or underline", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const blankWordSource = source.slice(source.indexOf("function CtwBlankWord"), source.indexOf("function ctwPositionKey"));
  const caretClassSource = blankWordSource.slice(
    blankWordSource.indexOf("const activeCaretClass"),
    blankWordSource.indexOf("return (")
  );

  assert.match(caretClassSource, /readOnly\s*\? ""/);
  assert.match(caretClassSource, /relative/);
  assert.match(caretClassSource, /focus:after:absolute/);
  assert.match(caretClassSource, /focus:after:right-full/);
  assert.match(caretClassSource, /focus:after:translate-x-\[0\.05em\]/);
  assert.doesNotMatch(caretClassSource, /focus:after:left-full|focus:after:-translate-x/);
  assert.match(caretClassSource, /focus:after:h-\[1em\]/);
  assert.match(caretClassSource, /focus:after:w-\[1\.5px\]/);
  assert.match(caretClassSource, /focus:after:animate-pulse/);
  assert.match(caretClassSource, /focus:after:bg-student-text/);
  assert.match(caretClassSource, /focus:after:content-\[''\]/);
  assert.doesNotMatch(caretClassSource, /border|outline|ring/);
  assert.equal((blankWordSource.match(/\$\{activeCaretClass\}/g) ?? []).length, 1);
  assert.ok(blankWordSource.indexOf("${activeCaretClass}") < blankWordSource.indexOf("data-filled"));
});
