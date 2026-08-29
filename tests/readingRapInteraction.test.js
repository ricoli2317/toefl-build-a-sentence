const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  calculateReadingElapsedSeconds,
  createReadingNavigation,
  moveReadingNavigation,
  setReadingAnswer
} = require("../lib/reading/practiceState.ts");
const { toStudentReadingPracticePayload } = require("../lib/reading/studentPractice.ts");

function rapPackage() {
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../data/reading/fixtures/reading-source.fixture.json"),
    "utf8"
  ));
  return structuredClone(groupReadingSourceOccurrences(source.occurrences).packages.find(
    (candidate) => candidate.item.module === "rap"
  ));
}

test("RAP student payload shares one ordered structured passage without answer keys", () => {
  const packageData = rapPackage();
  const payload = toStudentReadingPracticePayload(packageData);

  assert.equal(payload.item.module, "rap");
  assert.equal(payload.passage.passageId, packageData.passages[0].passageId);
  assert.deepEqual(
    payload.passage.paragraphs.map((paragraph) => paragraph.paragraphId),
    packageData.passages[0].paragraphs.map((paragraph) => paragraph.paragraphId)
  );
  assert.deepEqual(
    payload.passage.paragraphs.map((paragraph) => paragraph.sentences.map((sentence) => sentence.sentenceId)),
    packageData.passages[0].paragraphs.map((paragraph) => paragraph.sentences.map((sentence) => sentence.sentenceId))
  );
  assert.ok(payload.questions.every((question) => !("passage" in question) && !("paragraphs" in question)));
  assert.equal(JSON.stringify(payload).includes("correctOptionId"), false);
  assert.equal(JSON.stringify(payload).includes("correctAnchorId"), false);
  assert.equal(JSON.stringify(payload).includes("correctSentenceId"), false);
});

test("RAP multiple-choice answers replace per question and survive navigation without resetting the timer anchor", () => {
  const startedAt = 30_000;
  let answers = {};
  let navigation = createReadingNavigation("rap", 3, 3);

  answers = setReadingAnswer(answers, "question-1", { kind: "choice", optionId: "option-1" });
  answers = setReadingAnswer(answers, "question-1", { kind: "choice", optionId: "option-3" });
  navigation = moveReadingNavigation(navigation, 1);
  navigation = moveReadingNavigation(navigation, -1);

  assert.equal(navigation.currentIndex, 0);
  assert.deepEqual(answers["question-1"], { kind: "choice", optionId: "option-3" });
  assert.equal(calculateReadingElapsedSeconds(startedAt, 38_700), 8);
});

test("RAP workspace renders stable sentence DOM in the shared fixed 50:50 shell", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const rapSource = source.slice(
    source.indexOf("function RapPracticeWorkspace"),
    source.indexOf("function ChoiceOptionList")
  );

  assert.match(source, /testId="rap-workspace"/);
  assert.match(source, /function ReadingTwoColumnPracticeShell/);
  assert.match(source, /lg:grid-cols-\[minmax\(0,1fr\)_minmax\(0,1fr\)\]/);
  assert.match(source, /title=\{passage\.title\}/);
  assert.doesNotMatch(rapSource, />Read an Academic Passage</);
  assert.match(source, /data-testid="rap-passage"/);
  assert.match(source, /data-passage-id=\{passage\.passageId\}/);
  assert.match(source, /data-paragraph-id=\{paragraph\.paragraphId\}/);
  assert.match(source, /data-sentence-id=\{sentence\.sentenceId\}/);
  assert.match(source, /paragraph\.sentences\.map/);
  assert.match(source, /lg:min-h-0 lg:overflow-y-auto/);
  assert.match(source, /style=\{readingPassageTextStyle\}/);
  assert.match(source, /className="last:mb-0"/);
  assert.match(source, /question\.questionType === "rap_multiple_choice"/);
  assert.match(source, /question\.questionType === "rap_sentence_insertion"/);
  assert.match(source, /question\.questionType === "rap_sentence_selection"/);
  assert.match(source, /data-testid="rap-insertion-anchor"/);
  assert.match(source, /data-testid="rap-insertion-marker"/);
  assert.match(source, /data-testid="rap-inserted-sentence"/);
  assert.match(source, /data-testid="rap-selectable-sentence"/);
  assert.match(source, /function ChoiceOptionList/);
  assert.equal((source.match(/<ChoiceOptionList/g) ?? []).length, 2);
  assert.match(source, /role="radiogroup"/);
  assert.match(source, /role="radio"/);
  assert.match(source, /aria-checked=\{selected\}/);
  assert.match(source, /selected \? "font-bold" : "font-normal"/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /<span className="font-normal">\{option\.text\}<\/span>/);
  assert.match(source, /onAnswerChange\(question\.questionId, \{ kind: "choice", optionId \}\)/);
  assert.doesNotMatch(source, /lg:divide-x|lg:grid-cols-\[minmax\(0,1\.15fr\)/);
  assert.doesNotMatch(source, /String\.fromCharCode|optionIndex \+ 65/);
  assert.doesNotMatch(source, /rawDisplayText.*split|split\([^)]*[.!?]/s);
});
