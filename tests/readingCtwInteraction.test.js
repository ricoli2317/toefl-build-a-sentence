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

test("Full Set wrongbook editable slots accumulate input and skip locked original slots", () => {
  const originalSlots = [
    { slotId: "slot-1", slotOrder: 1, missingLength: 2 },
    { slotId: "slot-2", slotOrder: 2, missingLength: 3 },
    { slotId: "slot-3", slotOrder: 3, missingLength: 2 },
    { slotId: "slot-4", slotOrder: 4, missingLength: 2 },
    { slotId: "slot-5", slotOrder: 5, missingLength: 2 },
    { slotId: "slot-6", slotOrder: 6, missingLength: 2 }
  ];
  const editableIds = new Set(["slot-2", "slot-4", "slot-5"]);
  const editableSlots = originalSlots.filter((slot) => editableIds.has(slot.slotId));
  let answers = createCtwSlotAnswers(originalSlots);
  let focus = position("slot-2", 0);
  for (const letter of ["a", "b", "c"]) {
    const result = enterCtwLetter(editableSlots, answers, focus, letter);
    answers = result.slots;
    focus = result.focus;
  }
  assert.deepEqual(answers["slot-2"], ["a", "b", "c"]);
  assert.deepEqual(focus, position("slot-4", 0));
  assert.deepEqual(editableSlots.map((slot) => slot.slotId), ["slot-2", "slot-4", "slot-5"]);
});

test("Full Set wrongbook clicked editable position stays authoritative and can revisit earlier slots", () => {
  const editableSlots = [
    { slotId: "slot-2", slotOrder: 2, missingLength: 3 },
    { slotId: "slot-4", slotOrder: 4, missingLength: 2 },
    { slotId: "slot-5", slotOrder: 5, missingLength: 2 }
  ];
  let answers = createCtwSlotAnswers(editableSlots);
  const clickedLater = enterCtwLetter(editableSlots, answers, position("slot-5", 0), "x");
  answers = clickedLater.slots;
  assert.deepEqual(clickedLater.focus, position("slot-5", 1));
  assert.deepEqual(answers["slot-5"], ["x", ""]);

  const clickedEarlier = enterCtwLetter(editableSlots, answers, position("slot-2", 1), "y");
  assert.deepEqual(clickedEarlier.focus, position("slot-2", 2));
  assert.deepEqual(clickedEarlier.slots["slot-2"], ["", "y", ""]);
  assert.deepEqual(clickedEarlier.slots["slot-5"], ["x", ""]);
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
  assert.match(source, /readOnly \? "cursor-default" : `cursor-text/);
  const blankWordSource = source.slice(source.indexOf("function CtwBlankWord"), source.indexOf("function ctwPositionKey"));
  assert.ok(blankWordSource.indexOf("data-ctw-fill-region") < blankWordSource.indexOf("characters.map"));
  assert.equal((blankWordSource.match(/bg-\[#f1f2f5\]/g) ?? []).length, 1);
  assert.doesNotMatch(blankWordSource, /tracking-/);
  assert.match(source, /Fill in the missing letters in the paragraph\./);
  assert.match(source, /className="text-center font-extrabold text-student-text" style=\{readingTitleTypographyStyle\}/);
  assert.match(source, /data-testid="ctw-passage"/);
  assert.match(source, /text-left text-\[19em\] leading-\[1\.6842105263\]/);
  assert.doesNotMatch(source, /Type the missing letters in the passage\.|1 个完整练习|个填写位置/);
  assert.match(source, /focusPosition\(firstCtwPosition/);
  assert.match(source, /<ReadingQuestionViewport[\s\S]*onSubmit=\{submit\}/);
  assert.doesNotMatch(source, /rawText\.(match|replace)|querySelector|setTimeout/);
});

test("Full Set wrongbook memoizes editable slot identity so CTW focus initialization does not rerun after answer state updates", () => {
  const fullSetWrongbookSource = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingFullSetWrongbookPractice.tsx"),
    "utf8"
  );
  const ordinaryWrongbookSource = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  assert.match(fullSetWrongbookSource, /const currentTargets = current\?\.targets/);
  assert.match(fullSetWrongbookSource, /const editableSlotIds = useMemo\([\s\S]*readingWrongbookEditableSlotIds\(currentTargets\)[\s\S]*\[currentModule, currentTargets\]/);
  assert.equal((fullSetWrongbookSource.match(/readingWrongbookEditableSlotIds\(currentTargets\)/g) ?? []).length, 1);
  assert.match(ordinaryWrongbookSource, /const editableSlotIds = useMemo\([\s\S]*readingWrongbookEditableSlotIds\(wrongbookTargets\)[\s\S]*\[wrongbookTargets\]/);
  assert.match(ordinaryWrongbookSource, /focusPosition\(firstCtwPosition\(interactionSlots\)\)[\s\S]*\[focusPosition, interactionSlots, question\.questionId, readOnly\]/);
});

test("all editable CTW entry points share one iOS-compatible native keyboard input", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const fullSetSource = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingFullSetRunner.tsx"),
    "utf8"
  );
  const fullSetWrongbookSource = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingFullSetWrongbookPractice.tsx"),
    "utf8"
  );
  const workspaceSource = source.slice(source.indexOf("function CtwPracticeWorkspace"), source.indexOf("function CtwBlankWord"));
  const activateSource = workspaceSource.slice(
    workspaceSource.indexOf("const focusKeyboardInput"),
    workspaceSource.indexOf("useEffect", workspaceSource.indexOf("const focusKeyboardInput"))
  );
  const keyboardInputSource = workspaceSource.slice(
    workspaceSource.indexOf("<input"),
    workspaceSource.indexOf("/>", workspaceSource.indexOf("<input"))
  );

  assert.match(workspaceSource, /!readOnly \? \([\s\S]*<input/);
  assert.match(keyboardInputSource, /data-ctw-keyboard-input="true"/);
  assert.match(keyboardInputSource, /inputMode="text"/);
  assert.match(keyboardInputSource, /tabIndex=\{-1\}/);
  assert.match(keyboardInputSource, /type="text"/);
  assert.doesNotMatch(keyboardInputSource, /disabled|readOnly|inputMode="none"|display-none|visibility-hidden|pointer-events-none/);
  assert.match(activateSource, /keyboardInputRef\.current\?\.focus\(\)/);
  assert.doesNotMatch(activateSource, /setTimeout|requestAnimationFrame|Promise|async/);
  assert.match(source, /onClick=\{readOnly \? undefined : \(\) => onActivatePosition\(position\)\}/);
  assert.match(source, /export function ReadingPracticeShell[\s\S]*<ReadingWorkspaceRouter[\s\S]*readOnly=\{readOnly\}/);
  assert.match(fullSetSource, /<ReadingWorkspaceRouter[\s\S]*readOnly=\{!workspaceInteractive\}/);
  assert.match(fullSetWrongbookSource, /<ReadingWorkspaceRouter[\s\S]*editableSlotIds=\{editableSlotIds\}[\s\S]*readOnly=\{false\}/);
});

test("active CTW position renders one non-layout blinking caret before its letter or underline", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const tailwindSource = fs.readFileSync(
    path.join(__dirname, "../tailwind.config.ts"),
    "utf8"
  );
  const blankWordSource = source.slice(source.indexOf("function CtwBlankWord"), source.indexOf("function ctwPositionKey"));
  const caretClassStart = blankWordSource.indexOf("const activeCaretClass");
  const caretClassSource = blankWordSource.slice(
    caretClassStart,
    blankWordSource.indexOf("return (", caretClassStart)
  );

  assert.match(caretClassSource, /readOnly\s*\? ""/);
  assert.match(caretClassSource, /relative/);
  assert.match(caretClassSource, /focus:after:absolute/);
  assert.match(caretClassSource, /focus:after:right-full/);
  assert.match(caretClassSource, /focus:after:translate-x-\[0\.05em\]/);
  assert.doesNotMatch(caretClassSource, /focus:after:left-full|focus:after:-translate-x/);
  assert.match(caretClassSource, /focus:after:h-\[1em\]/);
  assert.match(caretClassSource, /focus:after:w-\[1\.5px\]/);
  assert.match(caretClassSource, /focus:after:animate-ctw-caret-blink/);
  assert.doesNotMatch(caretClassSource, /focus:after:animate-pulse/);
  assert.match(caretClassSource, /focus:after:bg-student-text/);
  assert.match(caretClassSource, /focus:after:content-\[''\]/);
  assert.doesNotMatch(caretClassSource, /border|outline|ring/);
  assert.match(tailwindSource, /"ctw-caret-blink": "ctw-caret-blink 1s step-end infinite"/);
  assert.match(tailwindSource, /"0%, 49%": \{ opacity: "1" \}/);
  assert.match(tailwindSource, /"50%, 100%": \{ opacity: "0" \}/);
  assert.equal((blankWordSource.match(/\$\{activeCaretClass\}/g) ?? []).length, 1);
  assert.ok(blankWordSource.indexOf("${activeCaretClass}") < blankWordSource.indexOf("data-filled"));
});
