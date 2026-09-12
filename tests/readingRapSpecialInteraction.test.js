const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  insertionAnchorAtBoundary,
  isRapSentenceSelectable,
  rapSentenceSelectionInstruction,
  rapSentenceSelectionStem,
  rapVisibleHighlightRanges,
  validateRapInsertionAnchors,
  validateRapSentenceTarget
} = require("../lib/reading/rapInteraction.ts");
const {
  calculateReadingElapsedSeconds,
  createReadingNavigation,
  moveReadingNavigation,
  setReadingAnswer
} = require("../lib/reading/practiceState.ts");
const { toStudentReadingPracticePayload } = require("../lib/reading/studentPractice.ts");

function rapPayload() {
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, "../data/reading/fixtures/reading-source.fixture.json"),
    "utf8"
  ));
  const packageData = structuredClone(groupReadingSourceOccurrences(source.occurrences).packages.find(
    (candidate) => candidate.item.module === "rap"
  ));
  return toStudentReadingPracticePayload(packageData);
}

test("four insertion anchors map to frozen paragraph sentence boundaries", () => {
  const payload = rapPayload();
  const question = payload.questions.find((candidate) => candidate.questionType === "rap_sentence_insertion");
  const validation = validateRapInsertionAnchors(payload.passage, question.anchors);

  assert.equal(validation.valid, true);
  assert.equal(validation.anchors.length, 4);
  assert.deepEqual(validation.anchors.map((anchor) => anchor.anchorOrder), [1, 2, 3, 4]);
  assert.equal(insertionAnchorAtBoundary(validation, payload.passage.paragraphs[0].paragraphId, 0).anchorOrder, 1);
  assert.equal(insertionAnchorAtBoundary(validation, payload.passage.paragraphs[0].paragraphId, 1).anchorOrder, 2);
  assert.equal(insertionAnchorAtBoundary(validation, payload.passage.paragraphs[0].paragraphId, 2).anchorOrder, 3);
  assert.equal(insertionAnchorAtBoundary(validation, payload.passage.paragraphs[1].paragraphId, 1).anchorOrder, 4);
  assert.equal(insertionAnchorAtBoundary(validation, payload.passage.paragraphs[0].paragraphId, 3), null);
});

test("malformed insertion anchors fail safely without text or pixel inference", () => {
  const payload = rapPayload();
  const question = payload.questions.find((candidate) => candidate.questionType === "rap_sentence_insertion");
  const missing = validateRapInsertionAnchors(payload.passage, question.anchors.slice(0, 3));
  const wrongBoundary = validateRapInsertionAnchors(payload.passage, question.anchors.map((anchor, index) => (
    index === 1 ? { ...anchor, afterSentenceId: null } : anchor
  )));
  const missingParagraph = validateRapInsertionAnchors(payload.passage, question.anchors.map((anchor, index) => (
    index === 0 ? { ...anchor, paragraphId: "missing" } : anchor
  )));

  assert.equal(missing.valid, false);
  assert.equal(wrongBoundary.valid, false);
  assert.equal(missingParagraph.valid, false);
});

test("sentence selection is limited to sentence identities in the target paragraph", () => {
  const payload = rapPayload();
  const question = payload.questions.find((candidate) => candidate.questionType === "rap_sentence_selection");
  const validation = validateRapSentenceTarget(payload.passage, question.targetParagraphId);
  const target = payload.passage.paragraphs.find((paragraph) => paragraph.paragraphId === question.targetParagraphId);
  const outside = payload.passage.paragraphs.find((paragraph) => paragraph.paragraphId !== question.targetParagraphId);

  assert.equal(validation.valid, true);
  assert.deepEqual(validation.sentenceIds, target.sentences.map((sentence) => sentence.sentenceId));
  assert.equal(isRapSentenceSelectable(validation, target.paragraphId, target.sentences[0].sentenceId), true);
  assert.equal(isRapSentenceSelectable(validation, outside.paragraphId, outside.sentences[0].sentenceId), false);
  assert.equal(validateRapSentenceTarget(payload.passage, "missing").valid, false);
});

test("mixed RAP answers replace independently and survive navigation with one timer anchor", () => {
  const startedAt = 40_000;
  let answers = {};
  let navigation = createReadingNavigation("rap", 4, 4);

  answers = setReadingAnswer(answers, "mc", { kind: "choice", optionId: "o2" });
  navigation = moveReadingNavigation(navigation, 1);
  answers = setReadingAnswer(answers, "insert", { kind: "insertion", anchorId: "a1" });
  answers = setReadingAnswer(answers, "insert", { kind: "insertion", anchorId: "a4" });
  navigation = moveReadingNavigation(navigation, 1);
  answers = setReadingAnswer(answers, "select", { kind: "sentence_selection", sentenceId: "s1" });
  answers = setReadingAnswer(answers, "select", { kind: "sentence_selection", sentenceId: "s2" });
  navigation = moveReadingNavigation(navigation, 1);
  navigation = moveReadingNavigation(navigation, -1);
  navigation = moveReadingNavigation(navigation, -1);

  assert.deepEqual(answers.mc, { kind: "choice", optionId: "o2" });
  assert.deepEqual(answers.insert, { kind: "insertion", anchorId: "a4" });
  assert.deepEqual(answers.select, { kind: "sentence_selection", sentenceId: "s2" });
  assert.equal(navigation.currentIndex, 1);
  assert.equal(calculateReadingElapsedSeconds(startedAt, 51_300), 11);
});

test("sentence insertion uses inline purple square markers and keeps the inserted sentence in paragraph flow", () => {
  const payload = rapPayload();
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const rapSource = source.slice(
    source.indexOf("function RapPracticeWorkspace"),
    source.indexOf("function ChoiceOptionList")
  );

  const insertionSource = rapSource.slice(
    rapSource.indexOf("const insertionBoundary"),
    rapSource.indexOf("const renderSentence")
  );
  const markerButtonSource = insertionSource.slice(
    insertionSource.indexOf('aria-checked="false"'),
    insertionSource.indexOf("<RapInsertionMarker />")
  );
  const markerClassName = markerButtonSource.match(/className="([^"]*)"/)?.[1];

  assert.equal(markerClassName, "mx-[0.3em] inline align-baseline leading-[inherit] text-student-primary");
  assert.doesNotMatch(markerClassName, /(?:^|[:\s])(?:border|outline|ring|shadow)(?:-|$)/);
  assert.match(markerButtonSource, /style=\{rapFramelessInteractionStyle\}/);
  assert.match(insertionSource, /<RapInsertionMarker \/>/);
  assert.match(insertionSource, /\? "font-bold text-student-primary"/);
  assert.match(insertionSource, /\? "font-bold text-student-error line-through decoration-2"/);
  assert.doesNotMatch(insertionSource, /bg-student-(?:primary|error)|text-white/);
  assert.match(insertionSource, /: "font-bold"/);
  assert.match(insertionSource, /const inserted = selected \|\| correctionState !== null/);
  assert.equal((insertionSource.match(/style=\{rapFramelessInteractionStyle\}/g) ?? []).length, 2);
  assert.doesNotMatch(insertionSource, /◆|inline-flex|h-6 w-6/);
  assert.match(source, /data-testid="rap-insertion-marker">■<\/span>/);
  assert.match(source, /className="inline text-student-primary" data-testid="rap-insertion-marker"/);
  assert.match(source, /onAnswerChange\(question\.questionId, \{ kind: "insertion", anchorId: anchor\.anchorId \}\)/);
});

test("sentence insertion right column has only the official three-paragraph hierarchy", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const instructionSource = source.slice(
    source.indexOf('data-testid="rap-insertion-instructions"'),
    source.indexOf('data-testid="rap-sentence-selection-instructions"')
  );

  assert.match(instructionSource, /<p className="font-bold" id="rap-question-stem">/);
  assert.match(instructionSource, /There are four locations <RapInsertionMarker bracketed \/> in the passage that indicate where the following sentence could be added\./);
  assert.match(instructionSource, /<p data-testid="rap-insertion-prompt"/);
  assert.match(instructionSource, /Where would the sentence best fit\? Select a location <RapInsertionMarker bracketed \/> to add the sentence to the passage\./);
  assert.equal((instructionSource.match(/<p(?:\s|>)/g) ?? []).length, 3);
  assert.doesNotMatch(instructionSource, /Sentence to insert|Choose one of the four markers|border-y|<hr/i);
});

test("sentence selection keeps active interaction frameless and makes readonly text selectable", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const rapSource = source.slice(
    source.indexOf("function RapPracticeWorkspace"),
    source.indexOf("function ChoiceOptionList")
  );
  const renderSentenceSource = rapSource.slice(
    rapSource.indexOf("const renderSentence"),
    rapSource.indexOf("return (\n    <ReadingTwoColumnPracticeShell")
  );
  const selectableClassName = renderSentenceSource.match(/className=\{`([^`]*)`\}/)?.[1];
  const selectionInstructionStart = rapSource.indexOf('data-testid="rap-sentence-selection-instructions"');
  const selectionInstructionSource = rapSource.slice(
    selectionInstructionStart,
    rapSource.indexOf(") : (", selectionInstructionStart)
  );

  assert.match(renderSentenceSource, /<span[\s\S]*?data-testid="rap-selectable-sentence"/);
  assert.doesNotMatch(renderSentenceSource, /<button[\s\S]*?data-testid="rap-selectable-sentence"/);
  assert.doesNotMatch(selectableClassName, /(?:^|[:\s])(?:border|outline|ring|shadow)(?:-|$)/);
  assert.match(renderSentenceSource, /style=\{readOnly \? undefined : rapFramelessInteractionStyle\}/);
  assert.match(renderSentenceSource, /readOnly \? "cursor-text select-text" : "cursor-pointer"/);
  assert.match(renderSentenceSource, /role=\{readOnly \? undefined : "radio"\}/);
  assert.match(renderSentenceSource, /aria-checked=\{readOnly \? undefined : selected\}/);
  assert.match(renderSentenceSource, /font-bold text-student-primary/);
  assert.match(renderSentenceSource, /font-bold text-student-error/);
  assert.doesNotMatch(renderSentenceSource, /bg-student-(?:primary|error)|text-white/);
  assert.match(renderSentenceSource, /const highlightedText = correctionState[\s\S]*\? sentence\.text[\s\S]*: renderRapHighlightedText/);
  assert.doesNotMatch(renderSentenceSource, /line-through|decoration-2/);
  assert.match(renderSentenceSource, /: selected[\s\S]*\? "font-bold text-inherit"[\s\S]*: "font-normal text-inherit"/);
  assert.match(source, /onAnswerChange\(question\.questionId, \{ kind: "sentence_selection", sentenceId: sentence\.sentenceId \}\)/);
  assert.match(rapSource, /<p[\s\S]*?paragraph\.sentences\.map[\s\S]*?<\/p>/);
  assert.match(rapSource, /className="font-bold text-student-text" data-testid="rap-sentence-selection-instructions"/);
  assert.match(selectionInstructionSource, /rapSentenceSelectionStem\(question\.stem\)/);
  assert.match(selectionInstructionSource, /rapSentenceSelectionInstruction\(\)/);
  assert.equal((selectionInstructionSource.match(/<p(?:\s|>)/g) ?? []).length, 2);
  assert.doesNotMatch(selectionInstructionSource, /text-student-muted|border-y|<hr/i);
  assert.doesNotMatch(rapSource, /includes\(sentence\.text\)|indexOf\(sentence\.text\)|getBoundingClientRect|split\([^)]*[.!?]/s);
});

test("active sentence selection hides source highlights and keeps selection answer-driven", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const rapSource = source.slice(
    source.indexOf("function RapPracticeWorkspace"),
    source.indexOf("function ChoiceOptionList")
  );
  const ranges = [{ paragraphId: "p1", startOffset: 0, endOffset: 10 }];

  assert.deepEqual(rapVisibleHighlightRanges("rap_sentence_selection", false, ranges), []);
  assert.equal(rapVisibleHighlightRanges("rap_sentence_selection", true, ranges), ranges);
  assert.equal(rapVisibleHighlightRanges("rap_sentence_insertion", false, ranges), ranges);
  assert.equal(rapVisibleHighlightRanges("rap_multiple_choice", false, ranges), ranges);
  assert.match(rapSource, /const selectedSentenceId = answer\?\.kind === "sentence_selection"/);
  assert.match(rapSource, /const selected = selectable && sentence\.sentenceId === selectedSentenceId/);
  assert.match(rapSource, /rapVisibleHighlightRanges\([\s\S]*?question\.questionType,[\s\S]*?readOnly,[\s\S]*?question\.highlightRanges/);
  assert.doesNotMatch(rapSource, /correctSentenceId|correct_sentence_id/);
});

test("sentence-selection instruction is stripped from the stem and rendered once below it", () => {
  const instruction = rapSentenceSelectionInstruction();
  const rawStem = "Identify the sentence in paragraph 1 that illustrates the claim. Select the sentence to make your choice.";
  const stem = rapSentenceSelectionStem(rawStem);

  assert.equal(stem, "Identify the sentence in paragraph 1 that illustrates the claim.");
  assert.equal(rapSentenceSelectionStem(stem), stem);
  assert.equal(`${stem}\n${instruction}`.split(instruction).length - 1, 1);
});

test("special RAP inline interactions explicitly suppress every visual frame source", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const styleStart = source.indexOf("const rapFramelessInteractionStyle");
  const styleSource = source.slice(styleStart, source.indexOf("} as CSSProperties;", styleStart));

  assert.match(styleSource, /appearance: "none"/);
  assert.match(styleSource, /WebkitAppearance: "none"/);
  assert.match(styleSource, /background: "transparent"/);
  assert.match(styleSource, /border: 0/);
  assert.match(styleSource, /borderRadius: 0/);
  assert.match(styleSource, /boxShadow: "none"/);
  assert.match(styleSource, /outline: "none"/);
  assert.match(styleSource, /padding: 0/);
  assert.match(styleSource, /textDecoration: "none"/);
});

test("special RAP payload remains student-safe", () => {
  const payload = rapPayload();
  assert.equal(JSON.stringify(payload).includes("correctAnchorId"), false);
  assert.equal(JSON.stringify(payload).includes("correctSentenceId"), false);
});
