const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv } = require("../lib/reading/csvAdapter.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  buildReadingContentConflict,
  indexReadingContentConflictResolutions,
  readingContentConflictSummary
} = require("../lib/reading/contentReconciliation.ts");
const { buildReadingCanonicalContentUpdate } = require("../lib/reading/contentCorrection.ts");
const { areReadingPackagesHistoricalSemanticEquivalents } = require("../lib/reading/semantic.ts");
const { attachIncomingOccurrencesToHistoricalPackage } = require("../lib/reading/historicalDedup.ts");
const {
  buildReadingInsertionAnchorSet,
  resolveReadingInsertionPosition
} = require("../lib/reading/reviewPresentation.ts");
const { normalizeInsertionBoundaryText } = require("../lib/reading/insertionBoundary.ts");
const {
  assertPreparedReadingPackageCanImport,
  prepareReadingPackageAtomicImport
} = require("../lib/reading/importer.ts");

const projectRoot = path.join(__dirname, "..");
const templateDir = path.join(projectRoot, "data/reading/csv-templates");
const material = {
  materialId: "RDL-001",
  title: "University Robotics Club Workshop",
  materialType: "flyer",
  source: "fixture",
  sourceDate: "2026-01-01",
  yearMonth: "2026-01",
  bindingStatus: "bound",
  imageAssetPath: "reading/rdl/RDL-001/material_final.png",
  hitboxDataPath: "reading/rdl/RDL-001/selection_map.json"
};

function packageFrom(type, file) {
  const document = parseCsvDocument(fs.readFileSync(path.join(templateDir, file), "utf8"), {
    trimValues: false
  });
  const adapted = adaptReadingCsv({
    type,
    rows: document.rows,
    sourceFile: file,
    materials: new Map([[material.materialId, material]])
  });
  assert.deepEqual(adapted.failures, []);
  return groupReadingSourceOccurrences(adapted.candidates).packages[0];
}

function rdl() {
  return packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
}

function rap() {
  return packageFrom("read_an_academic_passage", "TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
}

function ctw() {
  return packageFrom("complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv");
}

function choice(packageData) {
  return packageData.questions.find((question) =>
    question.questionType === "rdl" || question.questionType === "rap_multiple_choice"
  );
}

test("RDL and RAP identical canonical content has no conflict", () => {
  for (const packageData of [rdl(), rap()]) {
    assert.equal(buildReadingContentConflict(packageData, structuredClone(packageData)), null);
  }
});

test("content review summary follows passage, question, and combined conflict scope", () => {
  assert.equal(readingContentConflictSummary({ passageConflicts: [{}], questionConflicts: [] }),
    "已确认是同一篇文章，但文章内容存在差异。");
  assert.equal(readingContentConflictSummary({ passageConflicts: [], questionConflicts: [{}] }),
    "已确认是同一题组，但题目内容存在差异。");
  assert.equal(readingContentConflictSummary({ passageConflicts: [{}], questionConflicts: [{}] }),
    "已确认是同一题组，但文章和题目内容存在差异。");
});

test("RDL historical reuse carries the normalized display title without replacing canonical questions", () => {
  const historical = rdl();
  historical.item.title = "University robotics club workshop";
  historical.materials[0].title = "University robotics club workshop";
  historical.questions[0].stem = "Historical canonical stem";
  const incoming = rdl();
  incoming.questions[0].stem = "Incoming source stem";
  const reused = attachIncomingOccurrencesToHistoricalPackage(historical, incoming);
  assert.equal(reused.item.title, material.title);
  assert.equal(reused.materials[0].title, material.title);
  assert.equal(reused.questions[0].stem, "Historical canonical stem");
});

test("option reorder and answer-letter change with the same correct text are presentation-only", () => {
  for (const existing of [rdl(), rap()]) {
    const incoming = structuredClone(existing);
    const question = choice(incoming);
    question.payload.options.push(question.payload.options.shift());
    question.payload.options.forEach((option, index) => { option.optionOrder = index + 1; });
    assert.notEqual(
      question.payload.options.find((option) => option.optionId === question.payload.correctOptionId).optionOrder,
      choice(existing).payload.options.find((option) => option.optionId === choice(existing).payload.correctOptionId).optionOrder
    );
    assert.equal(buildReadingContentConflict(existing, incoming), null);
  }
});

test("a truly different correct semantic option is an answer conflict", () => {
  for (const existing of [rdl(), rap()]) {
    const incoming = structuredClone(existing);
    const question = choice(incoming);
    question.payload.correctOptionId = question.payload.options.find(
      (option) => option.optionId !== question.payload.correctOptionId
    ).optionId;
    const conflict = buildReadingContentConflict(existing, incoming);
    assert.equal(conflict.questionConflicts[0].correctAnswerSemanticallyDifferent, true);
    assert.ok(conflict.questionConflicts[0].differences.some((difference) => difference.kind === "correct_answer"));
  }
});

test("true stem and option content edits are question-level conflicts", () => {
  const existing = rdl();
  const stemIncoming = structuredClone(existing);
  choice(stemIncoming).stem = "A genuinely different question stem";
  assert.ok(buildReadingContentConflict(existing, stemIncoming).questionConflicts[0].differences.some(
    (difference) => difference.kind === "stem"
  ));

  const optionIncoming = structuredClone(existing);
  choice(optionIncoming).payload.options[0].text = "A genuinely different option";
  const optionConflict = buildReadingContentConflict(existing, optionIncoming).questionConflicts[0];
  assert.ok(optionConflict.differences.some((difference) => difference.kind === "options"));
  assert.equal(optionConflict.correctAnswerSemanticallyDifferent, false);
});

test("RAP insertion anchor IDs do not matter but semantic insertion location does", () => {
  const existing = rap();
  const idVariant = structuredClone(existing);
  const idQuestion = idVariant.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const correctOrder = idQuestion.payload.anchors.find(
    (anchor) => anchor.anchorId === idQuestion.payload.correctAnchorId
  ).anchorOrder;
  idQuestion.payload.anchors.forEach((anchor) => { anchor.anchorId = `source-anchor-${anchor.anchorOrder}`; });
  idQuestion.payload.correctAnchorId = `source-anchor-${correctOrder}`;
  idQuestion.payload.anchors.reverse();
  assert.equal(buildReadingContentConflict(existing, idVariant), null);

  const locationVariant = structuredClone(existing);
  const locationQuestion = locationVariant.questions.find((question) => question.questionType === "rap_sentence_insertion");
  locationQuestion.payload.correctAnchorId = locationQuestion.payload.anchors.find(
    (anchor) => anchor.anchorId !== locationQuestion.payload.correctAnchorId
  ).anchorId;
  const conflict = buildReadingContentConflict(existing, locationVariant);
  assert.ok(conflict.questionConflicts[0].differences.some(
    (difference) => difference.kind === "correct_insertion_location"
  ));
});

test("RAP insertion anchor order does not matter when the semantic set is unchanged", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  const question = incoming.questions.find((candidate) => candidate.questionType === "rap_sentence_insertion");
  question.payload.anchors.forEach((anchor) => {
    anchor.anchorOrder = 5 - anchor.anchorOrder;
  });
  question.payload.anchors.reverse();

  assert.equal(buildReadingContentConflict(existing, incoming), null);
});

test("RAP correct Location number changes do not conflict when the semantic position is unchanged", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  const question = incoming.questions.find((candidate) => candidate.questionType === "rap_sentence_insertion");
  const correct = question.payload.anchors.find((anchor) => anchor.anchorId === question.payload.correctAnchorId);
  const other = question.payload.anchors.find((anchor) => anchor.anchorOrder === 4);
  [correct.anchorOrder, other.anchorOrder] = [other.anchorOrder, correct.anchorOrder];

  assert.equal(buildReadingContentConflict(existing, incoming), null);
});

test("The Discovery of Vitamins Q35 fixture keeps paragraph 3 end and paragraph 4 start distinct", () => {
  const packageData = rap();
  const passage = packageData.passages[0];
  const paragraphs = [...passage.paragraphs].sort((left, right) => left.paragraphOrder - right.paragraphOrder);
  const leftParagraph = paragraphs[0];
  leftParagraph.paragraphOrder = 3;
  leftParagraph.sentences = [...leftParagraph.sentences]
    .sort((left, right) => left.sentenceOrder - right.sentenceOrder)
    .slice(0, 2);
  const rightParagraph = {
    paragraphId: "fixture-paragraph-2",
    paragraphOrder: 4,
    text: "A following paragraph begins here.",
    rawText: "A following paragraph begins here.",
    sentences: [{ sentenceId: "fixture-paragraph-2-s1", sentenceOrder: 1, text: "A following paragraph begins here." }]
  };
  passage.paragraphs.push(rightParagraph);
  const leftSentences = [...leftParagraph.sentences].sort((left, right) => left.sentenceOrder - right.sentenceOrder);
  const paragraphEnd = resolveReadingInsertionPosition(passage, {
    anchorId: "fixture-end",
    anchorOrder: 1,
    paragraphId: leftParagraph.paragraphId,
    boundaryIndex: leftSentences.length,
    afterSentenceId: leftSentences.at(-1).sentenceId
  });
  const nextParagraphStart = resolveReadingInsertionPosition(passage, {
    anchorId: "fixture-start",
    anchorOrder: 2,
    paragraphId: rightParagraph.paragraphId,
    boundaryIndex: 0,
    afterSentenceId: null
  });

  assert.equal(paragraphEnd.label, `第 ${leftParagraph.paragraphOrder} 段末尾`);
  assert.equal(nextParagraphStart.label, `第 ${rightParagraph.paragraphOrder} 段开头`);
  assert.notEqual(paragraphEnd.semanticKey, nextParagraphStart.semanticKey);
  assert.equal(paragraphEnd.nextSentence.text, rightParagraph.sentences[0].text);
  assert.equal(nextParagraphStart.previousSentence.text, leftSentences.at(-1).text);
  const afterFirstSentence = resolveReadingInsertionPosition(passage, {
    anchorId: "fixture-after-first",
    anchorOrder: 3,
    paragraphId: leftParagraph.paragraphId,
    boundaryIndex: 1,
    afterSentenceId: leftSentences[0].sentenceId
  });
  assert.equal(afterFirstSentence.label, "第 3 段第 1 句之后");
  assert.notEqual(afterFirstSentence.semanticKey, paragraphEnd.semanticKey);
});

test("RAP insertion set diff exposes only unmatched positions and full review keeps all markers", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  const existingQuestion = existing.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const incomingQuestion = incoming.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const changed = incomingQuestion.payload.anchors[0];
  const paragraph = incoming.passages[0].paragraphs.find((candidate) => candidate.paragraphId === changed.paragraphId);
  const nextBoundary = paragraph.sentences.length;
  changed.boundaryIndex = nextBoundary;
  changed.afterSentenceId = nextBoundary === 0 ? null : paragraph.sentences[nextBoundary - 1].sentenceId;
  if (changed.anchorId === incomingQuestion.payload.correctAnchorId) {
    incomingQuestion.payload.correctAnchorId = incomingQuestion.payload.anchors[1].anchorId;
  }
  if (existingQuestion.payload.anchors[0].anchorId === existingQuestion.payload.correctAnchorId) {
    existingQuestion.payload.correctAnchorId = existingQuestion.payload.anchors[1].anchorId;
  }

  const conflict = buildReadingContentConflict(existing, incoming);
  const difference = conflict.questionConflicts.flatMap((question) => question.differences)
    .find((candidate) => candidate.kind === "insertion_anchors");
  assert.equal(difference.insertionPositions.comparisonKind, "set_difference");
  assert.equal(difference.insertionPositions.existingOnly.length, 1);
  assert.equal(difference.insertionPositions.incomingOnly.length, 1);
  assert.deepEqual(difference.insertionPositions.existingDuplicates, []);
  assert.deepEqual(difference.insertionPositions.incomingDuplicates, []);
  assert.notEqual(
    difference.insertionPositions.existingOnly[0].semanticKey,
    difference.insertionPositions.incomingOnly[0].semanticKey
  );
  const existingMarkers = conflict.existingVersion.passage.paragraphs.flatMap((paragraph) => paragraph.markers);
  const incomingMarkers = conflict.incomingVersion.passage.paragraphs.flatMap((paragraph) => paragraph.markers);
  assert.equal(existingMarkers.length, 4);
  assert.equal(incomingMarkers.length, 4);
  assert.deepEqual(existingMarkers.map((marker) => marker.locationNumber).sort(), [1, 2, 3, 4]);
  assert.deepEqual(incomingMarkers.map((marker) => marker.locationNumber).sort(), [1, 2, 3, 4]);
  const markedParagraph = conflict.existingVersion.passage.paragraphs.find((candidate) =>
    candidate.markers.length > 0
  );
  assert.equal(markedParagraph.text, existing.passages[0].paragraphs.find((candidate) =>
    candidate.paragraphOrder === markedParagraph.paragraphOrder
  ).text);
});

test("RAP duplicate semantic anchors are reported separately from set-only differences", () => {
  const incoming = rap();
  const existing = structuredClone(incoming);
  const question = existing.questions.find((candidate) => candidate.questionType === "rap_sentence_insertion");
  const duplicate = question.payload.anchors[2];
  const target = question.payload.anchors[3];
  duplicate.paragraphId = target.paragraphId;
  duplicate.boundaryIndex = target.boundaryIndex;
  duplicate.afterSentenceId = target.afterSentenceId;

  const conflict = buildReadingContentConflict(existing, incoming);
  const difference = conflict.questionConflicts.flatMap((questionConflict) => questionConflict.differences)
    .find((candidate) => candidate.kind === "insertion_anchors");
  assert.deepEqual(difference.insertionPositions.existingOnly, []);
  assert.deepEqual(difference.insertionPositions.incomingOnly.map((position) => [
    position.paragraphOrder,
    position.boundaryIndex,
    position.normalizedOffset
  ]), [[1, 2, 63]]);
  assert.equal(difference.insertionPositions.existingDuplicates.length, 1);
  assert.equal(difference.insertionPositions.existingDuplicates[0].position.boundaryIndex, 3);
  assert.equal(difference.insertionPositions.existingDuplicates[0].position.resolutionStatus, "resolved");
  assert.deepEqual(difference.insertionPositions.existingDuplicates[0].locationNumbers, [3, 4]);
  assert.deepEqual(difference.insertionPositions.incomingDuplicates, []);
  const existingMarkers = conflict.existingVersion.passage.paragraphs.flatMap((paragraph) => paragraph.markers);
  assert.equal(existingMarkers.length, 4);
  assert.deepEqual(existingMarkers.filter((marker) => marker.duplicate).map((marker) => marker.locationNumber), [3, 4]);
});

test("a two-sentence paragraph canonicalizes after sentence 2 and paragraph end to one boundary", () => {
  const packageData = rap();
  const passage = packageData.passages[0];
  const paragraph = passage.paragraphs[0];
  paragraph.sentences = paragraph.sentences.slice(0, 2);
  const afterSecond = {
    anchorId: "after-second",
    anchorOrder: 1,
    paragraphId: paragraph.paragraphId,
    boundaryIndex: 2,
    afterSentenceId: paragraph.sentences[1].sentenceId
  };
  const paragraphEnd = { ...afterSecond, anchorId: "paragraph-end", anchorOrder: 2 };
  const set = buildReadingInsertionAnchorSet(passage, [afterSecond, paragraphEnd]);

  assert.equal(set.uniquePositions.length, 1);
  assert.equal(set.uniquePositions[0].normalizedOffset, set.uniquePositions[0].normalizedParagraphLength);
  assert.equal(set.uniquePositions[0].label, "第 1 段末尾");
  assert.deepEqual(set.duplicates[0].locationNumbers, [1, 2]);
});

test("8.9B Q30 resolves physical boundaries across different sentence segmentation", () => {
  const { existing, incoming } = computationalChemistryQ30Packages();
  const conflict = buildReadingContentConflict(existing, incoming);
  const difference = conflict.questionConflicts.flatMap((question) => question.differences)
    .find((candidate) => candidate.kind === "insertion_anchors");
  assert.deepEqual(difference.insertionPositions.existingOnly.map((position) => ({
    paragraphOrder: position.paragraphOrder,
    boundaryIndex: position.boundaryIndex,
    normalizedOffset: position.normalizedOffset,
    left: position.normalizedLeftContext
  })), [{
    paragraphOrder: 4,
    boundaryIndex: 1,
    normalizedOffset: 59,
    left: "Computational predictions must be validated experimentally,"
  }]);
  assert.deepEqual(difference.insertionPositions.incomingOnly.map((position) => [
    position.paragraphOrder,
    position.boundaryIndex,
    position.normalizedOffset
  ]), [[3, 3, 175]]);
  assert.deepEqual(difference.insertionPositions.existingDuplicates, []);
  assert.deepEqual(difference.insertionPositions.incomingDuplicates, []);
  assert.equal(conflict.questionConflicts[0].correctAnswerSemanticallyDifferent, false);
  assert.ok(conflict.questionConflicts[0].differences.every((item) =>
    item.kind !== "correct_insertion_location"
  ));

  const existingMarkers = conflict.existingVersion.passage.paragraphs.flatMap((paragraph) => paragraph.markers);
  const incomingMarkers = conflict.incomingVersion.passage.paragraphs.flatMap((paragraph) => paragraph.markers);
  assert.equal(existingMarkers.length, 4);
  assert.equal(incomingMarkers.length, 4);
  assert.deepEqual(existingMarkers.map((marker) => marker.comparisonStatus), ["common", "existing_only", "common", "common"]);
  assert.deepEqual(incomingMarkers.map((marker) => marker.comparisonStatus), ["incoming_only", "common", "common", "common"]);
  assert.deepEqual(existingMarkers.map((marker) => marker.textOffset), [0, 59, 117, 203]);
  assert.deepEqual(incomingMarkers.map((marker) => marker.textOffset), [175, 0, 117, 203]);
  assert.equal(existingMarkers[2].semanticKey, incomingMarkers[2].semanticKey);
  assert.notEqual(existingMarkers[1].semanticKey, incomingMarkers[2].semanticKey);
});

test("8.9B Q30 canonical correction remaps source anchors by physical boundary", () => {
  const { existing, incoming } = computationalChemistryQ30Packages();
  const incomingQuestion = incoming.questions.find(
    (question) => question.questionType === "rap_sentence_insertion"
  );
  const incomingParagraph4 = incoming.passages[0].paragraphs.find(
    (paragraph) => paragraph.paragraphOrder === 4
  );
  incomingQuestion.payload.highlightRanges = [{
    paragraphId: incomingParagraph4.paragraphId,
    startOffset: 0,
    endOffset: 13
  }];

  const corrected = buildReadingCanonicalContentUpdate(existing, incoming);
  const correctedQuestion = corrected.questions.find(
    (question) => question.questionType === "rap_sentence_insertion"
  );
  const canonicalParagraph4 = corrected.passages[0].paragraphs.find(
    (paragraph) => paragraph.paragraphOrder === 4
  );
  const canonicalSentences = corrected.passages[0].paragraphs.flatMap(
    (paragraph) => paragraph.sentences
  );

  assert.equal(corrected.item.logicalItemId, existing.item.logicalItemId);
  assert.deepEqual(correctedQuestion.payload.anchors.map((anchor) => ({
    paragraphOrder: corrected.passages[0].paragraphs.find(
      (paragraph) => paragraph.paragraphId === anchor.paragraphId
    ).paragraphOrder,
    boundaryIndex: anchor.boundaryIndex,
    afterSentenceOrder: anchor.afterSentenceId === null
      ? null
      : canonicalSentences.find(
          (sentence) => sentence.sentenceId === anchor.afterSentenceId
        ).sentenceOrder
  })), [
    { paragraphOrder: 3, boundaryIndex: 3, afterSentenceOrder: 3 },
    { paragraphOrder: 4, boundaryIndex: 0, afterSentenceOrder: null },
    { paragraphOrder: 4, boundaryIndex: 2, afterSentenceOrder: 2 },
    { paragraphOrder: 4, boundaryIndex: 3, afterSentenceOrder: 3 }
  ]);
  assert.equal(
    correctedQuestion.payload.anchors.find(
      (anchor) => anchor.anchorId === correctedQuestion.payload.correctAnchorId
    ).boundaryIndex,
    0
  );
  assert.deepEqual(correctedQuestion.payload.highlightRanges, [{
    paragraphId: canonicalParagraph4.paragraphId,
    startOffset: 0,
    endOffset: 13
  }]);
  assert.doesNotThrow(() => prepareReadingPackageAtomicImport(corrected, {
    replaceCanonicalContent: true,
    expectedLogicalItemAction: "reuse_existing"
  }));
});

test("same paragraph and boundary index do not match when sentence segmentation moves the text boundary", () => {
  const { existing, incoming } = computationalChemistryQ30Packages();
  const existingQuestion = existing.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const incomingQuestion = incoming.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const existingPosition = resolveReadingInsertionPosition(existing.passages[0], existingQuestion.payload.anchors[1]);
  const incomingPosition = resolveReadingInsertionPosition(incoming.passages[0], incomingQuestion.payload.anchors[2]);

  assert.equal(existingPosition.paragraphOrder, 4);
  assert.equal(incomingPosition.paragraphOrder, 4);
  assert.equal(existingPosition.boundaryIndex, 1);
  assert.equal(incomingPosition.boundaryIndex, 1);
  assert.equal(existingPosition.normalizedOffset, 59);
  assert.equal(incomingPosition.normalizedOffset, 117);
  assert.notEqual(existingPosition.semanticKey, incomingPosition.semanticKey);
});

test("different boundary indexes match when segmentation resolves to the same physical text boundary", () => {
  const { existing, incoming } = computationalChemistryQ30Packages();
  const existingQuestion = existing.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const incomingQuestion = incoming.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const existingPosition = resolveReadingInsertionPosition(existing.passages[0], existingQuestion.payload.anchors[2]);
  const incomingPosition = resolveReadingInsertionPosition(incoming.passages[0], incomingQuestion.payload.anchors[2]);

  assert.equal(existingPosition.boundaryIndex, 2);
  assert.equal(incomingPosition.boundaryIndex, 1);
  assert.equal(existingPosition.normalizedOffset, 117);
  assert.equal(existingPosition.semanticKey, incomingPosition.semanticKey);
});

test("physical insertion boundaries normalize harmless punctuation and whitespace representations", () => {
  assert.equal(
    normalizeInsertionBoundaryText("A  result—called “stable”…\nNext"),
    normalizeInsertionBoundaryText('A result-called "stable"... Next')
  );
  const existing = rap();
  const incoming = structuredClone(existing);
  const existingParagraph = existing.passages[0].paragraphs[0];
  const incomingParagraph = incoming.passages[0].paragraphs[0];
  existingParagraph.text = "A  careful result—called “stable”… Next observation.";
  existingParagraph.sentences = [
    { sentenceId: "existing-s1", sentenceOrder: 1, text: "A  careful result—called “stable”…" },
    { sentenceId: "existing-s2", sentenceOrder: 2, text: "Next observation." }
  ];
  incomingParagraph.text = 'A careful result-called "stable"... Next observation.';
  incomingParagraph.sentences = [
    { sentenceId: "incoming-s1", sentenceOrder: 1, text: 'A careful result-called "stable"...' },
    { sentenceId: "incoming-s2", sentenceOrder: 2, text: "Next observation." }
  ];
  const existingPosition = resolveReadingInsertionPosition(existing.passages[0], {
    anchorId: "existing-anchor",
    anchorOrder: 4,
    paragraphId: existingParagraph.paragraphId,
    boundaryIndex: 1,
    afterSentenceId: "existing-s1"
  });
  const incomingPosition = resolveReadingInsertionPosition(incoming.passages[0], {
    anchorId: "incoming-anchor",
    anchorOrder: 1,
    paragraphId: incomingParagraph.paragraphId,
    boundaryIndex: 1,
    afterSentenceId: "incoming-s1"
  });

  assert.equal(existingPosition.resolutionStatus, "resolved");
  assert.equal(incomingPosition.resolutionStatus, "resolved");
  assert.equal(existingPosition.semanticKey, incomingPosition.semanticKey);
});

test("non-unique sentence text remains unresolved instead of guessing a physical boundary", () => {
  const packageData = rap();
  const paragraph = packageData.passages[0].paragraphs[0];
  paragraph.text = "Repeated sentence. Repeated sentence. Final sentence.";
  paragraph.sentences = [
    { sentenceId: "repeat-1", sentenceOrder: 1, text: "Repeated sentence." },
    { sentenceId: "repeat-2", sentenceOrder: 2, text: "Repeated sentence." },
    { sentenceId: "final", sentenceOrder: 3, text: "Final sentence." }
  ];
  const position = resolveReadingInsertionPosition(packageData.passages[0], {
    anchorId: "ambiguous",
    anchorOrder: 1,
    paragraphId: paragraph.paragraphId,
    boundaryIndex: 1,
    afterSentenceId: "repeat-1"
  });

  assert.equal(position.resolutionStatus, "unresolved");
  assert.equal(position.textOffset, null);
  assert.match(position.resolutionReason, /not unique/);
});

test("The Discovery of Vitamins Q35 keeps only Location 1 different", () => {
  const { existing, incoming } = vitaminsQ35Packages();
  const conflict = buildReadingContentConflict(existing, incoming);
  const difference = conflict.questionConflicts.flatMap((question) => question.differences)
    .find((candidate) => candidate.kind === "insertion_anchors");

  assert.deepEqual(difference.insertionPositions.existingOnly.map((position) => [
    position.paragraphOrder,
    position.boundaryIndex,
    position.normalizedOffset
  ]), [[3, 2, 240]]);
  assert.deepEqual(difference.insertionPositions.incomingOnly.map((position) => [
    position.paragraphOrder,
    position.boundaryIndex,
    position.normalizedOffset
  ]), [[3, 1, 165]]);
  const existingMarkers = conflict.existingVersion.passage.paragraphs.flatMap((paragraph) => paragraph.markers);
  const incomingMarkers = conflict.incomingVersion.passage.paragraphs.flatMap((paragraph) => paragraph.markers);
  assert.deepEqual(existingMarkers.map((marker) => marker.comparisonStatus), ["existing_only", "common", "common", "common"]);
  assert.deepEqual(incomingMarkers.map((marker) => marker.comparisonStatus), ["incoming_only", "common", "common", "common"]);
});

test("7.22C normal insertion regression retains four unique boundaries and paragraph-end labeling", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  for (const packageData of [existing, incoming]) {
    const passage = packageData.passages[0];
    const paragraph = passage.paragraphs[0];
    paragraph.sentences.push({
      sentenceId: `${paragraph.paragraphId}-s05`,
      sentenceOrder: 5,
      text: "A fifth sentence closes the paragraph."
    });
    paragraph.text = `${paragraph.text} A fifth sentence closes the paragraph.`;
    paragraph.rawText = paragraph.text;
    const question = packageData.questions.find((candidate) => candidate.questionType === "rap_sentence_insertion");
    question.payload.anchors = [2, 3, 4, 5].map((boundaryIndex, index) => ({
      anchorId: `${question.questionId}-722c-${index + 1}`,
      anchorOrder: index + 1,
      paragraphId: paragraph.paragraphId,
      boundaryIndex,
      afterSentenceId: paragraph.sentences[boundaryIndex - 1].sentenceId
    }));
    question.payload.correctAnchorId = question.payload.anchors[3].anchorId;
  }
  const insertion = existing.questions.find((candidate) => candidate.questionType === "rap_sentence_insertion");
  const set = buildReadingInsertionAnchorSet(existing.passages[0], insertion.payload.anchors);

  assert.deepEqual(set.uniquePositions.map((position) => position.boundaryIndex), [2, 3, 4, 5]);
  assert.equal(new Set(set.uniquePositions.map((position) => position.semanticKey)).size, 4);
  assert.equal(set.uniquePositions.every((position) => position.resolutionStatus === "resolved"), true);
  assert.equal(set.uniquePositions.at(-1).label, "第 1 段末尾");
  assert.deepEqual(set.duplicates, []);
  assert.equal(buildReadingContentConflict(existing, incoming), null);
});

for (const [name, straight, curly] of [
  ["apostrophes", "The brain's memory system guides recall.", "The brain’s memory system guides recall."],
  ["double quotes", 'The "data management" system guides memory.', "The “data management” system guides memory."]
]) {
  test(`RAP insertion anchor context treats straight and curly ${name} as presentation-only`, () => {
    const existing = rap();
    const incoming = structuredClone(existing);
    const existingParagraph = existing.passages[0].paragraphs[0];
    const incomingParagraph = incoming.passages[0].paragraphs[0];
    existingParagraph.sentences[0].text = straight;
    incomingParagraph.sentences[0].text = curly;
    existingParagraph.text = existingParagraph.text.replace("Ocean tides rise and fall.", straight);
    incomingParagraph.text = incomingParagraph.text.replace("Ocean tides rise and fall.", curly);

    assert.equal(buildReadingContentConflict(existing, incoming), null);
  });
}

test("RAP insertion comparison keeps unresolvable sentence-to-paragraph mappings in review", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  const existingParagraph = existing.passages[0].paragraphs[0];
  const incomingParagraph = incoming.passages[0].paragraphs[0];
  existingParagraph.sentences[0].text = `The brain's "data management" system guides memory.`;
  incomingParagraph.sentences[0].text = `The mind’s “data management” system guides memory.`;

  const conflict = buildReadingContentConflict(existing, incoming);
  assert.ok(conflict);
  const difference = conflict.questionConflicts.flatMap((question) => question.differences)
    .find((candidate) => candidate.kind === "insertion_anchors");
  assert.ok(difference);
  assert.equal(difference.insertionPositions.existingOnly[0].resolutionStatus, "unresolved");
  assert.equal(difference.insertionPositions.incomingOnly[0].resolutionStatus, "unresolved");
});

test("RAP sentence IDs do not matter but selected sentence content does", () => {
  const existing = rap();
  const idVariant = structuredClone(existing);
  const selection = idVariant.questions.find((question) => question.questionType === "rap_sentence_selection");
  const paragraph = idVariant.passages[0].paragraphs.find(
    (candidate) => candidate.paragraphId === selection.payload.targetParagraphId
  );
  const selectedOrder = paragraph.sentences.find(
    (sentence) => sentence.sentenceId === selection.payload.correctSentenceId
  ).sentenceOrder;
  paragraph.sentences.forEach((sentence) => { sentence.sentenceId = `source-sentence-${sentence.sentenceOrder}`; });
  const insertion = idVariant.questions.find((question) => question.questionType === "rap_sentence_insertion");
  insertion.payload.anchors.forEach((anchor) => {
    if (anchor.afterSentenceId) {
      const order = Number(anchor.afterSentenceId.match(/s(\d+)$/)?.[1]);
      anchor.afterSentenceId = `source-sentence-${order}`;
    }
  });
  selection.payload.correctSentenceId = `source-sentence-${selectedOrder}`;
  paragraph.sentences.reverse();
  assert.equal(buildReadingContentConflict(existing, idVariant), null);

  const contentVariant = structuredClone(existing);
  const contentSelection = contentVariant.questions.find((question) => question.questionType === "rap_sentence_selection");
  const contentParagraph = contentVariant.passages[0].paragraphs.find(
    (candidate) => candidate.paragraphId === contentSelection.payload.targetParagraphId
  );
  contentSelection.payload.correctSentenceId = contentParagraph.sentences.find(
    (sentence) => sentence.sentenceId !== contentSelection.payload.correctSentenceId
  ).sentenceId;
  const conflict = buildReadingContentConflict(existing, contentVariant);
  assert.ok(conflict.questionConflicts[0].differences.some(
    (difference) => difference.kind === "selected_sentence"
  ));
});

test("7.1A RAP insertion marker and RDL P.M. capitalization are non-substantive", () => {
  const rapExisting = rap();
  const rapIncoming = structuredClone(rapExisting);
  const existingInsertion = rapExisting.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const incomingInsertion = rapIncoming.questions.find((question) => question.questionType === "rap_sentence_insertion");
  existingInsertion.stem = "There are four locations ■ in the passage that indicate where the sentence could be added.";
  incomingInsertion.stem = "There are four locations in the passage that indicate where the sentence could be added.";
  assert.equal(buildReadingContentConflict(rapExisting, rapIncoming), null);

  const rdlExisting = rdl();
  const rdlIncoming = structuredClone(rdlExisting);
  choice(rdlExisting).stem = "At 5:30 P.M., what does Angela imply?";
  choice(rdlIncoming).stem = "At 5:30 p.m., what does Angela imply?";
  assert.equal(buildReadingContentConflict(rdlExisting, rdlIncoming), null);
});

test("identity reuse and content conflict remain separate concepts", () => {
  const existing = rdl();
  const incoming = structuredClone(existing);
  choice(incoming).stem = "A different source transcription";
  assert.equal(areReadingPackagesHistoricalSemanticEquivalents(existing, incoming), true);
  assert.ok(buildReadingContentConflict(existing, incoming));
});

test("CTW prefix, answer, and combined changes each produce one slot-level conflict", () => {
  for (const variant of ["prefix", "answer", "both"]) {
    const existing = ctw();
    const incoming = structuredClone(existing);
    const slot = incoming.questions[0].payload.slots[0];
    if (variant !== "answer") slot.prefix = `${slot.prefix}c`;
    if (variant !== "prefix") slot.answer = `${slot.answer}s`;
    slot.displayText = `${slot.prefix}_ _ _ _`;
    const conflict = buildReadingContentConflict(existing, incoming);
    assert.deepEqual(conflict.questionConflicts[0].differences.map((item) => item.kind), ["ctw_slot_content"]);
    assert.equal(conflict.questionConflicts[0].ctwSlotConflicts.length, 1);
    assert.equal(conflict.questionConflicts[0].ctwSlotConflicts[0].slotOrder, 1);
    assert.deepEqual(
      conflict.questionConflicts[0].ctwSlotConflicts[0].differenceKinds,
      variant === "prefix" ? ["prefix"] : variant === "answer" ? ["answer"] : ["prefix", "answer"]
    );
  }
});

test("CTW punctuation and display serialization differences never produce content review", () => {
  const existing = ctw();
  const incoming = structuredClone(existing);
  incoming.questions[0].payload.slots.forEach((slot) => { slot.displayText = `${slot.prefix}_ _ _`; });
  incoming.questions[0].payload.paragraphs[0].segments.find((segment) => segment.kind === "text").text += ",";
  assert.equal(buildReadingContentConflict(existing, incoming), null);
});

test("unresolved content conflict is blocked and resolutions are explicit", () => {
  const existing = rdl();
  const incoming = structuredClone(existing);
  choice(incoming).stem = "A different source transcription";
  const item = buildReadingContentConflict(existing, incoming);
  assert.throws(() => assertPreparedReadingPackageCanImport({
    occurrenceConflict: null,
    unresolvedContentConflictCount: 1
  }), /题目内容冲突待确认/);
  const indexed = indexReadingContentConflictResolutions([item], [{
    resolutionId: item.resolutionId,
    action: "keep_existing"
  }]);
  assert.equal(indexed.get(item.resolutionId).action, "keep_existing");
});

test("source correction preserves canonical IDs and applies incoming answer content", () => {
  const existing = rdl();
  const incoming = structuredClone(existing);
  incoming.item.logicalItemId = "incoming-logical";
  incoming.questions.forEach((question) => { question.logicalItemId = incoming.item.logicalItemId; });
  const incomingChoice = choice(incoming);
  incomingChoice.stem = "Corrected source stem";
  incomingChoice.payload.correctOptionId = incomingChoice.payload.options[1].optionId;
  const corrected = buildReadingCanonicalContentUpdate(existing, incoming);
  assert.equal(corrected.item.logicalItemId, existing.item.logicalItemId);
  assert.equal(corrected.questions[0].questionId, existing.questions[0].questionId);
  assert.equal(corrected.questions[0].stem, "Corrected source stem");
  assert.equal(corrected.questions[0].payload.correctOptionId, existing.questions[0].payload.options[1].optionId);
});

test("RAP question-only correction tolerates harmless historical sentence segmentation drift", () => {
  const existing = rap();
  const existingChoice = choice(existing);
  existing.questions = [existingChoice];
  existing.item.questionCount = 1;
  existing.item.scoredItemCount = 1;
  existing.occurrences.forEach((occurrence) => {
    occurrence.questionSources = occurrence.questionSources.filter(
      (source) => source.questionId === existingChoice.questionId
    );
    occurrence.sourceQuestionStart = occurrence.questionSources[0].sourceQuestionStart;
    occurrence.sourceQuestionEnd = occurrence.questionSources[0].sourceQuestionEnd;
  });
  const incoming = structuredClone(existing);
  incoming.item.logicalItemId = "incoming-segmentation-variant";
  incoming.passages.forEach((passage) => { passage.logicalItemId = incoming.item.logicalItemId; });
  incoming.questions.forEach((question) => { question.logicalItemId = incoming.item.logicalItemId; });
  incoming.occurrences.forEach((occurrence) => { occurrence.logicalItemId = incoming.item.logicalItemId; });

  const paragraph = incoming.passages[0].paragraphs.find((candidate) => candidate.sentences.length >= 2);
  const [first, second, ...remaining] = paragraph.sentences;
  paragraph.sentences = [
    { ...first, text: `${first.text} ${second.text}` },
    ...remaining.map((sentence, index) => ({ ...sentence, sentenceOrder: index + 2 }))
  ];
  const changedChoice = choice(incoming);
  changedChoice.payload.options[0].text += " corrected";

  const conflict = buildReadingContentConflict(existing, incoming);
  assert.equal(conflict.passageConflicts.length, 0);
  assert.deepEqual(conflict.questionConflicts.map((question) => question.questionOrder), [changedChoice.questionOrder]);
  const corrected = buildReadingCanonicalContentUpdate(existing, incoming);
  assert.deepEqual(
    corrected.passages[0].paragraphs.map((candidate) => candidate.sentences.length),
    existing.passages[0].paragraphs.map((candidate) => candidate.sentences.length)
  );
  assert.equal(choice(corrected).payload.options[0].text, changedChoice.payload.options[0].text);
  assert.equal(corrected.questions.length, 1);
  assert.doesNotThrow(() => prepareReadingPackageAtomicImport(corrected, {
    replaceCanonicalContent: true,
    expectedLogicalItemAction: "reuse_existing"
  }));
});

test("atomic correction payload explicitly requests canonical replacement", async () => {
  const { importReadingPackageAtomic } = require("../lib/reading/importer.ts");
  const calls = [];
  await importReadingPackageAtomic({
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data: {
          logical_item_action: "reuse_existing",
          inserted_occurrence_count: 1,
          existing_occurrence_count: 0,
          inserted_question_count: 0,
          updated_question_count: 1
        },
        error: null
      };
    }
  }, rdl(), { replaceCanonicalContent: true });
  assert.equal(calls[0].args.p_rows.replace_canonical_content, true);
  const sql = fs.readFileSync(path.join(projectRoot, "supabase/reading_csv_import.sql"), "utf8");
  assert.match(sql, /if v_replace_canonical_content then/);
  assert.match(sql, /v_id_owner_fingerprint <> v_dedup_fingerprint[\s\S]*and not v_replace_canonical_content then/);
  assert.match(sql, /on conflict \(material_id\) do update set[\s\S]*title = excluded\.title/);
});

test("content conflict UI defaults to compact fixed-direction review with local feedback", () => {
  const source = fs.readFileSync(path.join(
    projectRoot,
    "components/import/ReadingContentConflictList.tsx"
  ), "utf8");
  assert.match(source, /同题内容差异待确认/);
  assert.match(source, /系统已确认这是同一道题/);
  assert.match(source, /第 \{slot\.slotOrder\} 空内容不同/);
  assert.match(source, /<ReadingInlineVersionValue title="题库版本" segments=\{slot\.inlineDiff\.existing\}/);
  assert.match(source, /<ReadingInlineVersionValue title="来源 CSV" segments=\{slot\.inlineDiff\.incoming\}/);
  assert.match(source, /保留题库版本/);
  assert.match(source, /使用来源版本更新题库/);
  assert.doesNotMatch(source, /当前版本|另一来源版本|existingVersionOrigin/);
  assert.match(source, /已选择：/);
  assert.match(source, /修改选择/);
  assert.match(source, /重新查看/);
  assert.match(source, /ReadingInlineVersionValue/);
  assert.match(source, /展开完整内容/);
  assert.match(source, /ReadingFullContentComparison/);
  assert.doesNotMatch(source, /内部题目编号/);
});

test("sentence-selection fixed instruction is not part of semantic stem identity", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  const selection = incoming.questions.find((question) => question.questionType === "rap_sentence_selection");
  selection.stem += " Select the sentence to make your choice.";
  assert.equal(buildReadingContentConflict(existing, incoming), null);
});

test("conflict payload contains only changed fields and a minimal inline diff", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  const question = choice(incoming);
  const changedOption = question.payload.options.find((option) => option.optionId !== question.payload.correctOptionId);
  changedOption.text = `${changedOption.text}r`;
  const conflict = buildReadingContentConflict(existing, incoming);
  assert.equal(conflict.passageConflicts.length, 0);
  assert.equal(conflict.questionConflicts.length, 1);
  assert.equal(conflict.questionConflicts[0].differences.length, 1);
  const changed = conflict.questionConflicts[0].differences[0];
  assert.equal(changed.kind, "options");
  assert.equal("existing" in conflict.questionConflicts[0], false);
  assert.deepEqual(changed.inlineDiff.incoming.filter((segment) => segment.changed), [
    { text: "r", changed: true }
  ]);
});

test("true OCR edits remain conflicts while case-only option edits disappear", () => {
  const existing = rap();
  const caseOnly = structuredClone(existing);
  choice(caseOnly).payload.options[0].text = choice(caseOnly).payload.options[0].text.toUpperCase();
  assert.equal(buildReadingContentConflict(existing, caseOnly), null);

  for (const [left, right] of [
    ["movementr", "movement"],
    ["paragraph 32", "paragraph 3?"],
    ["perlold", "period"]
  ]) {
    const base = rap();
    const incoming = structuredClone(base);
    choice(base).payload.options[0].text = left;
    choice(incoming).payload.options[0].text = right;
    const difference = buildReadingContentConflict(base, incoming).questionConflicts[0].differences[0];
    assert.equal(difference.kind, "options");
    assert.ok(difference.inlineDiff.existing.some((segment) => segment.changed));
    assert.ok(difference.inlineDiff.incoming.some((segment) => segment.changed));
  }
});

test("unchanged RAP passage and four unchanged questions stay out of one-question review", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  incoming.questions[2].stem = "A genuinely changed third question";
  const conflict = buildReadingContentConflict(existing, incoming);
  assert.equal(conflict.passageConflicts.length, 0);
  assert.deepEqual(conflict.questionConflicts.map((question) => question.questionOrder), [3]);
});

test("real 7.11A Q35 malformed source remains a duplicate-boundary error instead of being folded to three", () => {
  const adapted = adaptReadingCsv({
    type: "read_an_academic_passage",
    rows: real711aInsertionRows(false),
    sourceFile: "TOEFL_Reading_2026_07_RAP.csv"
  });
  assert.equal(adapted.failures.length, 1);
  assert.match(adapted.failures[0].reason, /duplicate insertion boundary/);
  assert.doesNotMatch(adapted.failures[0].reason, /exactly four legal anchors/);
});

test("real 7.11A Q35 marker-aware segmentation produces four legal unique anchors", () => {
  const adapted = adaptReadingCsv({
    type: "read_an_academic_passage",
    rows: real711aInsertionRows(true),
    sourceFile: "TOEFL_Reading_2026_07_RAP.csv"
  });
  assert.deepEqual(adapted.failures, []);
  const packageData = groupReadingSourceOccurrences(adapted.candidates).packages[0];
  const insertion = packageData.questions.find((question) => question.questionType === "rap_sentence_insertion");
  assert.equal(insertion.payload.anchors.length, 4);
  assert.equal(new Set(insertion.payload.anchors.map((anchor) =>
    `${anchor.paragraphId}:${anchor.boundaryIndex}`)).size, 4);
  assert.deepEqual(insertion.payload.anchors.map((anchor) => anchor.boundaryIndex), [0, 1, 2, 3]);
  const targetSentences = packageData.passages[0].paragraphs[0].sentences;
  assert.deepEqual(insertion.payload.anchors.map((anchor) => anchor.afterSentenceId), [
    null,
    targetSentences[0].sentenceId,
    targetSentences[1].sentenceId,
    targetSentences[2].sentenceId
  ]);
  assert.equal(insertion.payload.correctAnchorId, insertion.payload.anchors[0].anchorId);
  const prepared = prepareReadingPackageAtomicImport(packageData, {
    expectedLogicalItemAction: "create_new"
  });
  const anchorRows = prepared.rows.reading_rap_insertion_anchors.filter(
    (anchor) => anchor.question_id === insertion.questionId
  );
  assert.deepEqual(anchorRows.map((anchor) => anchor.boundary_index), [0, 1, 2, 3]);
  assert.equal(
    prepared.rows.reading_questions.find((question) => question.question_id === insertion.questionId).correct_anchor_id,
    anchorRows[0].anchor_id
  );
});

function computationalChemistryQ30Packages() {
  const existing = rap();
  const incoming = structuredClone(existing);
  const existingPassage = existing.passages[0];
  const incomingPassage = incoming.passages[0];
  const baseParagraph = existingPassage.paragraphs[0];
  const makeParagraph = (order, sentenceTexts) => {
    const paragraphId = `${existingPassage.passageId}-fixture-p${order}`;
    return {
      paragraphId,
      paragraphOrder: order,
      text: sentenceTexts.join(" "),
      rawText: sentenceTexts.join(" "),
      sentences: sentenceTexts.map((text, index) => ({
        sentenceId: `${paragraphId}-s${index + 1}`,
        sentenceOrder: index + 1,
        text
      }))
    };
  };
  const paragraph2 = makeParagraph(2, ["Paragraph two sentence one."]);
  const paragraph3 = makeParagraph(3, [
    "Moreover, computational chemistry optimizes drug properties.",
    "Researchers can predict changes in efficacy and safety.",
    "Repeating and refining this process fine-tunes candidates.",
    "For example, modifying a molecule can enhance stability."
  ]);
  const paragraph4Text = "Computational predictions must be validated experimentally, as computer models can sometimes produce false positives. Accurately simulating the human body's complex environment remains a formidable task.";
  const existingParagraph4 = makeParagraph(4, [
    "Computational predictions must be validated experimentally,",
    "as computer models can sometimes produce false positives.",
    "Accurately simulating the human body's complex environment remains a formidable task."
  ]);
  existingParagraph4.text = paragraph4Text;
  existingParagraph4.rawText = paragraph4Text;
  const incomingParagraph4 = makeParagraph(4, [
    "Computational predictions must be validated experimentally, as computer models can sometimes produce false positives.",
    "Accurately simulating the human body's complex environment remains a formidable task."
  ]);
  incomingParagraph4.text = paragraph4Text;
  incomingParagraph4.rawText = paragraph4Text;
  baseParagraph.paragraphOrder = 1;
  incomingPassage.paragraphs[0].paragraphOrder = 1;
  existingPassage.paragraphs.push(paragraph2, paragraph3, existingParagraph4);
  incomingPassage.paragraphs.push(
    structuredClone(paragraph2),
    structuredClone(paragraph3),
    incomingParagraph4
  );

  const existingQuestion = existing.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const incomingQuestion = incoming.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const anchor = (id, order, paragraph, boundaryIndex) => ({
    anchorId: id,
    anchorOrder: order,
    paragraphId: paragraph.paragraphId,
    boundaryIndex,
    afterSentenceId: boundaryIndex === 0 ? null : paragraph.sentences[boundaryIndex - 1].sentenceId
  });
  existingQuestion.payload.anchors = [
    anchor("db-location-1", 1, existingParagraph4, 0),
    anchor("db-location-2", 2, existingParagraph4, 1),
    anchor("db-location-3", 3, existingParagraph4, 2),
    anchor("db-location-4", 4, existingParagraph4, 3)
  ];
  existingQuestion.payload.correctAnchorId = "db-location-1";
  incomingQuestion.payload.anchors = [
    anchor("csv-location-1", 1, paragraph3, 3),
    anchor("csv-location-2", 2, incomingParagraph4, 0),
    anchor("csv-location-3", 3, incomingParagraph4, 1),
    anchor("csv-location-4", 4, incomingParagraph4, 2)
  ];
  incomingQuestion.payload.correctAnchorId = "csv-location-2";
  incoming.occurrences[0].sourceLabel = "8.9B";
  incoming.item.firstSeenSourceLabel = "8.9B";
  const source = incoming.occurrences[0].questionSources.find((item) => item.questionId === incomingQuestion.questionId);
  source.sourceQuestionStart = 30;
  source.sourceQuestionEnd = 30;
  incoming.occurrences[0].sourceQuestionEnd = 30;
  return { existing, incoming };
}

function vitaminsQ35Packages() {
  const existing = rap();
  const incoming = structuredClone(existing);
  const existingPassage = existing.passages[0];
  const incomingPassage = incoming.passages[0];
  const makeParagraph = (passage, order, sentenceTexts) => {
    const paragraphId = `${passage.passageId}-vitamins-p${order}`;
    return {
      paragraphId,
      paragraphOrder: order,
      text: sentenceTexts.join(" "),
      rawText: sentenceTexts.join(" "),
      sentences: sentenceTexts.map((text, index) => ({
        sentenceId: `${paragraphId}-s${index + 1}`,
        sentenceOrder: index + 1,
        text
      }))
    };
  };
  const paragraph3Texts = [
    "Thiamine was indeed an amine whose absence can cause beriberi, but Funk's extract likely contained a mixture of substances, and his chemical analysis was incomplete.",
    "Only later did researchers successfully isolate thiamine in its pure form."
  ];
  const paragraph4Texts = [
    "Additional life-essential nutrients were soon discovered.",
    "The problem was that many of them were not amines.",
    "The final e was thus dropped from vitamine to make the term less misleading."
  ];
  const existingParagraph3 = makeParagraph(existingPassage, 3, paragraph3Texts);
  const existingParagraph4 = makeParagraph(existingPassage, 4, paragraph4Texts);
  const incomingParagraph3 = makeParagraph(incomingPassage, 3, paragraph3Texts);
  const incomingParagraph4 = makeParagraph(incomingPassage, 4, paragraph4Texts);
  existingPassage.paragraphs = [existingParagraph3, existingParagraph4];
  incomingPassage.paragraphs = [incomingParagraph3, incomingParagraph4];
  const existingQuestion = existing.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const incomingQuestion = incoming.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const anchor = (id, order, paragraph, boundaryIndex) => ({
    anchorId: id,
    anchorOrder: order,
    paragraphId: paragraph.paragraphId,
    boundaryIndex,
    afterSentenceId: boundaryIndex === 0 ? null : paragraph.sentences[boundaryIndex - 1].sentenceId
  });
  existingQuestion.payload.anchors = [
    anchor("vitamins-db-1", 1, existingParagraph3, 2),
    anchor("vitamins-db-2", 2, existingParagraph4, 0),
    anchor("vitamins-db-3", 3, existingParagraph4, 1),
    anchor("vitamins-db-4", 4, existingParagraph4, 2)
  ];
  incomingQuestion.payload.anchors = [
    anchor("vitamins-csv-1", 1, incomingParagraph3, 1),
    anchor("vitamins-csv-2", 2, incomingParagraph4, 0),
    anchor("vitamins-csv-3", 3, incomingParagraph4, 1),
    anchor("vitamins-csv-4", 4, incomingParagraph4, 2)
  ];
  existingQuestion.payload.correctAnchorId = "vitamins-db-4";
  incomingQuestion.payload.correctAnchorId = "vitamins-csv-4";
  return { existing, incoming };
}

function real711aInsertionRows(markerAware) {
  const file = "TOEFL_Read_an_Academic_Passage_TEMPLATE.csv";
  const template = parseCsvDocument(fs.readFileSync(path.join(templateDir, file), "utf8"), {
    trimValues: false
  }).rows;
  const multipleChoice = template.find((row) => row.question_type === "rap_multiple_choice");
  const insertionTemplate = template.find((row) => row.question_type === "rap_sentence_insertion");
  const paragraphId = "reading-2026-07-11-a-m1-rap-p02-p04";
  const passageId = "reading-2026-07-11-a-m1-rap-p02";
  const fragments = markerAware
    ? [
        "Computational predictions must be validated experimentally,",
        "as computer models can sometimes produce false positives.",
        "Accurately simulating the human body's complex environment remains a formidable task."
      ]
    : [
        "Computational predictions must be validated experimentally, as computer models can sometimes produce false positives.",
        "Accurately simulating the human body's complex environment remains a formidable task."
      ];
  const passage = [{
    paragraphId,
    paragraphOrder: 1,
    text: fragments.join(" "),
    rawText: fragments.join(" "),
    sentences: fragments.map((text, index) => ({
      sentenceId: `${paragraphId}-s${String(index + 1).padStart(2, "0")}`,
      sentenceOrder: index + 1,
      text
    }))
  }];
  const anchors = [
    { anchorId: `${paragraphId}-q35-a01`, anchorOrder: 1, paragraphId, boundaryIndex: 0, afterSentenceId: null },
    { anchorId: `${paragraphId}-q35-a02`, anchorOrder: 2, paragraphId, boundaryIndex: 1, afterSentenceId: `${paragraphId}-s01` },
    markerAware
      ? { anchorId: `${paragraphId}-q35-a03`, anchorOrder: 3, paragraphId, boundaryIndex: 2, afterSentenceId: `${paragraphId}-s02` }
      : { anchorId: `${paragraphId}-q35-a03`, anchorOrder: 3, paragraphId, boundaryIndex: 1, afterSentenceId: `${paragraphId}-s01` },
    { anchorId: `${paragraphId}-q35-a04`, anchorOrder: 4, paragraphId, boundaryIndex: markerAware ? 3 : 2, afterSentenceId: `${paragraphId}-s${markerAware ? "03" : "02"}` }
  ];
  const rows = [1, 2, 3, 4].map((order) => ({
    ...multipleChoice,
    question_order: String(order),
    source_question_number: String(30 + order)
  }));
  rows.push({
    ...insertionTemplate,
    question_order: "5",
    source_question_number: "35",
    question_stem: "There are four locations ■ in the passage that indicate where the following sentence could be added.",
    raw_display_text: "35. There are four locations ■ in the passage that indicate where the following sentence could be added.",
    insert_sentence: "Despite these advancements, challenges remain.",
    insertion_anchors_json: JSON.stringify(anchors),
    correct_anchor_id: anchors[0].anchorId
  });
  return rows.map((row) => ({
    ...row,
    source_label: "7.11A",
    occurrence_date: "2026-07-11",
    year_month: "2026-07",
    source_module: "m1",
    source_order: "6",
    source_group_id: "7.11A-m1-rap-q31-35",
    passage_id: passageId,
    passage_title: "Computational Chemistry in Drug Discovery",
    passage_json: JSON.stringify(passage),
    passage_highlights_json: "[]"
  }));
}
