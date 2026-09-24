const assert = require("node:assert/strict");
const test = require("node:test");

const { parseRdlSelectionMap } = require("../lib/reading/rdlSelection.ts");
const { canonicalSourceTextHash } = require("../lib/lexical/hash.ts");
const { enumerateCtwBlocks } = require("../lib/lexical/enumerators/ctw.server.ts");
const {
  enumerateRdlBlocks,
  rdlInclusiveSelectionToLexicalRange,
  reconstructRdlCanonicalMaterial
} = require("../lib/lexical/enumerators/rdl.server.ts");
const { enumerateRapBlocks } = require("../lib/lexical/enumerators/rap.server.ts");
const { enumerateBasBlocks } = require("../lib/lexical/enumerators/bas.server.ts");
const { enumerateWriteEmailBlocks } = require("../lib/lexical/enumerators/writeEmail.server.ts");
const { enumerateAcademicDiscussionBlocks } = require("../lib/lexical/enumerators/academicDiscussion.server.ts");
const { enumerateCanonicalLexicalBlocks } = require("../lib/lexical/enumerateCanonicalBlocks.server.ts");
const { planCanonicalBlockSync } = require("../lib/lexical/syncCanonicalBlocks.server.ts");
const { normalizeRdlSelectionMapForLexical } = require("../lib/lexical/loadCanonicalInputs.server.ts");
const {
  CanonicalLexicalValidationError,
  assertDeterministicCanonicalEnumeration,
  validateCanonicalLexicalBlocks
} = require("../lib/lexical/validateCanonicalBlock.ts");

function mapLine(lineIndex, breakAfter, words) {
  let globalIndex = mapLine.globalIndex ?? 0;
  mapLine.globalIndex = globalIndex + words.flatMap((word) => word.chars).length;
  return {
    line_index: lineIndex,
    break_after: breakAfter,
    text: words.map((word) => word.text).join(" "),
    bbox: { x: 0, y: lineIndex / 4, width: 1, height: 0.1 },
    words: words.map((word, wordIndex) => ({
      id: `w-${lineIndex}-${wordIndex}`,
      line_index: lineIndex,
      word_index: wordIndex,
      text: word.text,
      bbox: { x: wordIndex / 2, y: lineIndex / 4, width: 0.2, height: 0.1 },
      chars: word.chars.map((char, charIndex) => ({
        id: `c-${lineIndex}-${wordIndex}-${charIndex}`,
        line_index: lineIndex,
        word_index: wordIndex,
        char_index: charIndex,
        global_index: globalIndex++,
        char,
        bbox: { x: 0, y: 0, width: 0.01, height: 0.01 }
      }))
    }))
  };
}

function rdlMap() {
  mapLine.globalIndex = 0;
  return parseRdlSelectionMap({
    schema_version: 2,
    image_file: "material.png",
    image_sha256: "a".repeat(64),
    canvas_width: 100,
    canvas_height: 100,
    coordinate_space: "normalized_top_left_xywh_0_1",
    lines: [
      mapLine(0, "space", [{ text: "A", chars: ["A"] }]),
      mapLine(1, "paragraph", [{ text: "😀", chars: ["😀"] }]),
      mapLine(2, "end", [{ text: "End", chars: ["E", "n", "d"] }])
    ]
  });
}

function tenBasQuestions() {
  return Array.from({ length: 10 }, (_, index) => ({
    sourceQuestionId: `raw-${index + 1}`,
    logicalQuestionOrder: index + 1,
    prompt: `Prompt ${index + 1}`,
    sentenceTemplate: "___.",
    correctOrderText: `answer ${index + 1}`,
    finalSentence: `Answer ${index + 1}.`
  }));
}

test("CTW reconstructs canonical paragraphs from segments and full slot answers", () => {
  const blocks = enumerateCtwBlocks({
    sourceItemId: "reading-ctw-item",
    paragraphs: [{ paragraphId: "p2", paragraphOrder: 2 }, { paragraphId: "p1", paragraphOrder: 1 }],
    segments: [
      { paragraphId: "p1", segmentOrder: 1, segmentType: "text", textContent: "A ", slotId: null },
      { paragraphId: "p1", segmentOrder: 2, segmentType: "blank", textContent: null, slotId: "slot-1" },
      { paragraphId: "p2", segmentOrder: 1, segmentType: "text", textContent: "Second paragraph.", slotId: null }
    ],
    slots: [{ slotId: "slot-1", paragraphId: "p1", answer: "complete" }]
  });
  assert.deepEqual(blocks.map((block) => block.contentBlockId), ["paragraph:p1", "paragraph:p2"]);
  assert.equal(blocks[0].text, "A complete");
  assert.deepEqual(blocks[0].anchors[0], {
    anchorId: "slot-1", anchorKind: "ctw_slot", startOffset: 2, endOffset: 10, expectedText: "complete"
  });
  assert.equal(blocks[0].text.slice(2, 10), "complete");
});

test("RDL preserves break_after and maps flattened characters to UTF-16 canonical offsets", () => {
  const material = reconstructRdlCanonicalMaterial(rdlMap());
  assert.equal(material.text, "A 😀\n\nEnd");
  assert.deepEqual(material.characters.map((character) => character.flatIndex), [0, 1, 2, 3, 4]);
  assert.equal(material.characters[1].startOffset, 2);
  assert.equal(material.characters[1].endOffset, 4);
  assert.equal(material.characters[2].startOffset, 6);
  assert.deepEqual(rdlInclusiveSelectionToLexicalRange(material, 1, 1), { startOffset: 2, endOffset: 4 });
  const blocks = enumerateRdlBlocks({
    sourceItemId: "reading-rdl-item",
    materialId: "RDL-1",
    selectionMap: rdlMap(),
    questions: [{ questionId: "q1", questionOrder: 1, stem: "Stem", options: [{ optionId: "o1", optionOrder: 1, optionText: "Option" }] }]
  });
  assert.equal(blocks[0].text, material.text);
  assert.equal(blocks[0].anchors.find((anchor) => anchor.anchorId === "c-1-0-0").startOffset, 2);
});

test("lexical RDL normalization recovers legacy null break_after and propagates source review", () => {
  const raw = {
    schema_version: 2,
    image_file: "legacy.png",
    image_sha256: "b".repeat(64),
    canvas_width: 100,
    canvas_height: 100,
    coordinate_space: "normalized_top_left_xywh_0_1",
    lines: [mapLine(0, null, [{ text: "Legacy", chars: ["L", "e", "g", "a", "c", "y"] }])]
  };
  const parsed = parseRdlSelectionMap(normalizeRdlSelectionMapForLexical(raw));
  assert.equal(parsed.lines[0].breakAfter, "end");
  assert.equal(parsed.lines[0].words[0].needsReview, true);
  assert.equal(parsed.lines[0].words[0].characters.every((character) => character.needsReview), true);
});

test("RAP uses paragraph_text UTF-16 sentence anchors and independent insertion blocks", () => {
  const blocks = enumerateRapBlocks({
    sourceItemId: "reading-rap-item",
    passageId: "passage-1",
    paragraphs: [{
      paragraphId: "p1", paragraphOrder: 1, paragraphText: "A😀. B.",
      sentences: [{ sentenceId: "s1", sentenceOrder: 1, sentenceText: "A😀." }, { sentenceId: "s2", sentenceOrder: 2, sentenceText: "B." }]
    }, {
      paragraphId: "p2", paragraphOrder: 2, paragraphText: "C.",
      sentences: [{ sentenceId: "s3", sentenceOrder: 1, sentenceText: "C." }]
    }],
    questions: [
      { questionId: "mc", questionOrder: 1, questionType: "rap_multiple_choice", stem: "MC stem", options: [{ optionId: "o", optionOrder: 1, optionText: "Choice" }] },
      { questionId: "selection", questionOrder: 2, questionType: "rap_sentence_selection", stem: "Choose it. Select the sentence to make your choice.", options: [] },
      { questionId: "insert", questionOrder: 3, questionType: "rap_sentence_insertion", stem: "Ignored DB stem", insertSentence: "Insert this.", options: [], insertionAnchors: [
        { anchorId: "a1", anchorOrder: 1, paragraphId: "p1", boundaryIndex: 0, afterSentenceId: null },
        { anchorId: "a2", anchorOrder: 2, paragraphId: "p1", boundaryIndex: 1, afterSentenceId: "s1" },
        { anchorId: "a3", anchorOrder: 3, paragraphId: "p1", boundaryIndex: 2, afterSentenceId: "s2" },
        { anchorId: "a4", anchorOrder: 4, paragraphId: "p2", boundaryIndex: 0, afterSentenceId: null }
      ] }
    ]
  });
  const paragraph = blocks.find((block) => block.contentBlockId === "passage:passage-1:paragraph:p1");
  assert.equal(paragraph.anchors[1].startOffset, 5);
  assert.equal(blocks.find((block) => block.contentBlockId === "question:selection:stem").text, "Choose it.");
  assert.match(blocks.find((block) => block.contentBlockId === "question:insert:instruction").text, /■/);
  assert.equal(blocks.find((block) => block.contentBlockId === "question:insert:insert-sentence").text, "Insert this.");
  assert.throws(() => enumerateRapBlocks({ sourceItemId: "x", passageId: "p", paragraphs: [{ paragraphId: "p", paragraphOrder: 1, paragraphText: "different", sentences: [{ sentenceId: "s", sentenceOrder: 1, sentenceText: "text" }] }], questions: [] }), /does not equal/);
});

test("BAS only accepts canonical Q01-Q10 sources and preserves canonical final_sentence on reconstruction mismatch", () => {
  const blocks = enumerateBasBlocks({ sourceItemId: "item-bas", sourceId: "source-bas", isCanonical: true, questions: tenBasQuestions() });
  assert.equal(blocks.length, 20);
  assert.equal(blocks[0].contentBlockId, "question:q01:prompt");
  assert.equal(blocks[19].contentBlockId, "question:q10:final-sentence");
  assert.throws(() => enumerateBasBlocks({ sourceItemId: "item", sourceId: "noncanonical", isCanonical: false, questions: tenBasQuestions() }), /not canonical/);
  const broken = tenBasQuestions(); broken[0].finalSentence = "Different.";
  const mismatched = enumerateBasBlocks({ sourceItemId: "item", sourceId: "source", isCanonical: true, questions: broken });
  assert.equal(mismatched[1].text, "Different.");
  assert.equal(mismatched[1].anchors[0].metadata.reason, "bas_reconstruction_mismatch");
});

test("Email includes exactly six canonical visible blocks and preserves task instruction text", () => {
  const instruction = "Write to Maya  exactly as shown.";
  const blocks = enumerateWriteEmailBlocks({ sourceItemId: "item-email", sourceQuestionId: "raw-email", isCanonical: true, recipient: "Maya", question: {
    scenario: "Scenario", taskInstruction: instruction, requirement1: "One", requirement2: "Two", requirement3: "Three", subject: "Subject"
  } });
  assert.deepEqual(blocks.map((block) => block.contentBlockId), ["scenario", "task-instruction", "requirement:1", "requirement:2", "requirement:3", "subject"]);
  assert.equal(blocks[1].text, instruction);
  assert.deepEqual(blocks[1].anchors, [{
    anchorId: "recipient:1", anchorKind: "coverage_exclusion", startOffset: 9, endOffset: 13,
    expectedText: "Maya", metadata: { reason: "participant_name", field: "recipient" }
  }]);
  assert.equal(blocks.some((block) => /recipient|closing/i.test(block.contentBlockId)), false);
  const generic = enumerateWriteEmailBlocks({ sourceItemId: "generic-email", sourceQuestionId: "generic", isCanonical: true, recipient: "Customer Service", question: {
    scenario: "Scenario", taskInstruction: "Write an email to customer service.", requirement1: "One", requirement2: "Two", requirement3: "Three", subject: "Subject"
  } });
  assert.equal(generic[1].anchors, undefined);
});

test("Academic Discussion excludes participant UI labels and preserves response whitespace", () => {
  const blocks = enumerateAcademicDiscussionBlocks({ sourceItemId: "item-ad", sourceQuestionId: "raw-ad", isCanonical: true, question: {
    professorPrompt: "Prompt", student1Response: "First\n- bullet", student2Response: "Second\n\n- bullet"
  } });
  assert.deepEqual(blocks.map((block) => block.contentBlockId), ["professor-prompt", "student-response:1", "student-response:2"]);
  assert.equal(blocks[1].text, "First\n- bullet");
  assert.equal(blocks[2].text, "Second\n\n- bullet");
});

test("shared validation enforces UTF-16 slice invariants, duplicate rejection, determinism, and SHA-256", () => {
  const block = { sourceType: "ctw", sourceItemId: "item", contentBlockId: "p", blockKind: "ctw_paragraph", text: "A😀B", anchors: [{ anchorId: "emoji", anchorKind: "ctw_slot", startOffset: 1, endOffset: 3, expectedText: "😀" }] };
  assert.deepEqual(validateCanonicalLexicalBlocks([block]), [block]);
  assert.throws(() => validateCanonicalLexicalBlocks([block, block]), CanonicalLexicalValidationError);
  assert.deepEqual(assertDeterministicCanonicalEnumeration(() => [block]), [block]);
  assert.equal(canonicalSourceTextHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(canonicalSourceTextHash("A😀B"), canonicalSourceTextHash("A😀B"));
});

test("entry point and sync plan classify new, same, changed, removed, and never remove after failed enumeration", () => {
  const blocks = enumerateCanonicalLexicalBlocks({ ctw: [{ sourceItemId: "item", paragraphs: [{ paragraphId: "p", paragraphOrder: 1 }], segments: [{ paragraphId: "p", segmentOrder: 1, segmentType: "text", textContent: "Current", slotId: null }], slots: [] }] });
  const existing = [
    { source_type: "ctw", source_item_id: "item", content_block_id: "paragraph:p", source_text_hash: canonicalSourceTextHash("Old") },
    { source_type: "ctw", source_item_id: "item", content_block_id: "paragraph:removed", source_text_hash: canonicalSourceTextHash("Removed") }
  ];
  const changed = planCanonicalBlockSync({ sourceType: "ctw", sourceItemId: "item", enumeration: { success: true, blocks }, existing });
  assert.deepEqual(changed.map((entry) => entry.action), ["changed", "removed"]);
  const same = planCanonicalBlockSync({ sourceType: "ctw", sourceItemId: "item", enumeration: { success: true, blocks }, existing: [{ ...existing[0], source_text_hash: canonicalSourceTextHash("Current") }] });
  assert.equal(same[0].action, "same");
  const fresh = planCanonicalBlockSync({ sourceType: "ctw", sourceItemId: "item", enumeration: { success: true, blocks }, existing: [] });
  assert.equal(fresh[0].action, "new");
  assert.deepEqual(planCanonicalBlockSync({ sourceType: "ctw", sourceItemId: "item", enumeration: { success: false, error: new Error("read failed") }, existing }), []);
});
