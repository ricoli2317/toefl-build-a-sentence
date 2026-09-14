const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv } = require("../lib/reading/csvAdapter.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  buildReadingContentConflict,
  indexReadingContentConflictResolutions
} = require("../lib/reading/contentReconciliation.ts");
const { buildReadingCanonicalContentUpdate } = require("../lib/reading/contentCorrection.ts");
const { areReadingPackagesHistoricalSemanticEquivalents } = require("../lib/reading/semantic.ts");
const { attachIncomingOccurrencesToHistoricalPackage } = require("../lib/reading/historicalDedup.ts");
const { assertPreparedReadingPackageCanImport } = require("../lib/reading/importer.ts");

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

test("RAP insertion anchor context preserves true content differences", () => {
  const existing = rap();
  const incoming = structuredClone(existing);
  const existingParagraph = existing.passages[0].paragraphs[0];
  const incomingParagraph = incoming.passages[0].paragraphs[0];
  existingParagraph.sentences[0].text = `The brain's "data management" system guides memory.`;
  incomingParagraph.sentences[0].text = `The mind’s “data management” system guides memory.`;

  const conflict = buildReadingContentConflict(existing, incoming);
  assert.ok(conflict.questionConflicts.some((question) =>
    question.differences.some((difference) => difference.kind === "insertion_anchors")
  ));
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
  assert.doesNotMatch(source, /展开完整内容|QuestionVersion|内部题目编号/);
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
});

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
