const assert = require("node:assert/strict");
const test = require("node:test");

const {
  auditCtwLogicalIdentities,
  renderCtwLogicalIdentityAuditMarkdown
} = require("../lib/reading/ctwLogicalIdentityAudit.ts");

function question({
  answers = ["access", "resources"],
  prefixes = ["ac", "reso"],
  textBefore = "Hierarchies dictate ",
  between = " to ",
  textAfter = " such as food.",
  slotOrders = answers.map((_, index) => index + 1),
  displays
} = {}) {
  const paragraphId = "p1";
  const slots = answers.map((answer, index) => {
    const prefix = prefixes[index] ?? "";
    const missingText = answer.slice(prefix.length);
    return {
      slotId: `slot-${index + 1}`,
      slotOrder: slotOrders[index],
      paragraphId,
      answer,
      prefix,
      displayText: displays?.[index] ?? `${prefix}${"_".repeat(missingText.length)}`,
      missingText,
      missingLength: missingText.length
    };
  });
  const segments = [{ kind: "text", text: textBefore }];
  if (slots[0]) segments.push({ kind: "blank", slotId: slots[0].slotId });
  if (slots[1]) {
    segments.push({ kind: "text", text: between });
    segments.push({ kind: "blank", slotId: slots[1].slotId });
  }
  segments.push({ kind: "text", text: textAfter });
  return {
    questionId: "question",
    logicalItemId: "logical",
    questionOrder: 1,
    questionType: "ctw",
    stem: "Fill in the missing letters.",
    rawDisplayText: "raw",
    payload: {
      paragraphs: [{ paragraphId, paragraphOrder: 1, rawText: "raw", segments }],
      slots
    }
  };
}

function item(logicalItemId, questionValue = question(), occurrences = []) {
  const copy = structuredClone(questionValue);
  copy.questionId = `${logicalItemId}-q1`;
  copy.logicalItemId = logicalItemId;
  copy.payload.paragraphs[0].paragraphId = `${logicalItemId}-p1`;
  for (const slot of copy.payload.slots) {
    slot.paragraphId = `${logicalItemId}-p1`;
    const oldId = slot.slotId;
    slot.slotId = `${logicalItemId}-${oldId}`;
    for (const segment of copy.payload.paragraphs[0].segments) {
      if (segment.kind === "blank" && segment.slotId === oldId) segment.slotId = slot.slotId;
    }
  }
  return {
    logicalItemId,
    title: null,
    firstSeenDate: "2026-01-01",
    firstSeenSourceLabel: logicalItemId,
    firstSeenSourceOrder: 1,
    oldFingerprint: logicalItemId.padEnd(64, "0").slice(0, 64),
    question: copy,
    occurrences
  };
}

function occurrence(occurrenceId, overrides = {}) {
  return {
    occurrenceId,
    sourceKind: "docx",
    sourceLabel: "6.21A",
    occurrenceDate: "2026-06-21",
    sourceModule: "m2",
    sourceOrder: 18,
    sourceQuestionStart: 1,
    sourceQuestionEnd: 10,
    ...overrides
  };
}

const generatedAt = "2026-09-13T00:00:00.000Z";

test("one CTW identity with one logical item is unique", () => {
  const manifest = auditCtwLogicalIdentities([item("item-a")], generatedAt);
  assert.equal(manifest.totalLogicalItems, 1);
  assert.equal(manifest.uniqueIdentityCount, 1);
  assert.equal(manifest.uniqueLogicalItemCount, 1);
  assert.equal(manifest.duplicateClusterCount, 0);
});

test("two logical items with one CTW identity form one duplicate cluster", () => {
  const manifest = auditCtwLogicalIdentities([item("item-a"), item("item-b")], generatedAt);
  assert.equal(manifest.duplicateClusterCount, 1);
  assert.equal(manifest.duplicateLogicalItemCount, 2);
  assert.equal(manifest.theoreticalLogicalItemReduction, 1);
  assert.deepEqual(manifest.clusters[0].logicalItemIds, ["item-a", "item-b"]);
});

test("three logical items with one CTW identity form one three-member cluster", () => {
  const manifest = auditCtwLogicalIdentities([
    item("item-a"), item("item-b"), item("item-c")
  ], generatedAt);
  assert.equal(manifest.duplicateClusterCount, 1);
  assert.equal(manifest.clusters[0].logicalItemCount, 3);
  assert.equal(manifest.theoreticalLogicalItemReduction, 2);
});

test("prefix conflict is reported without changing cluster identity", () => {
  const manifest = auditCtwLogicalIdentities([
    item("item-a", question({ prefixes: ["ac", "reso"] })),
    item("item-b", question({ prefixes: ["acc", "reso"] }))
  ], generatedAt);
  assert.equal(manifest.duplicateClusterCount, 1);
  assert.equal(manifest.prefixConflictClusterCount, 1);
  assert.deepEqual(manifest.clusters[0].prefixConflicts[0], {
    kind: "prefix_conflict",
    slotOrder: 1,
    answer: "access",
    versions: [
      { logicalItemId: "item-a", prefix: "ac", sources: [] },
      { logicalItemId: "item-b", prefix: "acc", sources: [] }
    ]
  });
});

test("punctuation-only completed passage differences stay in one cluster", () => {
  const manifest = auditCtwLogicalIdentities([
    item("item-a", question({ textAfter: " such as food." })),
    item("item-b", question({ textAfter: ", such as food;" }))
  ], generatedAt);
  assert.equal(manifest.duplicateClusterCount, 1);
  assert.equal(manifest.punctuationOnlyClusterCount, 1);
  assert.ok(manifest.clusters[0].conflictKinds.includes("punctuation_difference"));
});

test("different full answer shares identity and is audited as an answer conflict", () => {
  const manifest = auditCtwLogicalIdentities([
    item("item-a", question({ answers: ["access", "resources"] })),
    item("item-b", question({ answers: ["accept", "resources"] }))
  ], generatedAt);
  assert.equal(manifest.uniqueIdentityCount, 1);
  assert.equal(manifest.duplicateClusterCount, 1);
  assert.equal(manifest.answerConflictClusterCount, 1);
  assert.equal(manifest.clusters[0].slotContentConflicts[0].kind, "answer_conflict");
});

test("same answers in a different order create a different identity", () => {
  const left = question();
  const right = question({ slotOrders: [2, 1] });
  const manifest = auditCtwLogicalIdentities([
    item("item-a", left), item("item-b", right)
  ], generatedAt);
  assert.equal(manifest.uniqueIdentityCount, 2);
  assert.equal(manifest.duplicateClusterCount, 0);
});

test("completed paragraph lexical difference creates a different identity", () => {
  const manifest = auditCtwLogicalIdentities([
    item("item-a", question({ textBefore: "Hierarchies dictate " })),
    item("item-b", question({ textBefore: "Researchers dictate " }))
  ], generatedAt);
  assert.equal(manifest.uniqueIdentityCount, 2);
  assert.equal(manifest.duplicateClusterCount, 0);
});

test("duplicate occurrence source mapping is detected across logical items", () => {
  const manifest = auditCtwLogicalIdentities([
    item("item-a", question(), [occurrence("occurrence-a")]),
    item("item-b", question(), [occurrence("occurrence-b")])
  ], generatedAt);
  assert.equal(manifest.duplicateOccurrenceMappingCount, 1);
  assert.equal(manifest.duplicateOccurrenceMappingRecordCount, 1);
  assert.equal(manifest.clusters[0].duplicateOccurrenceMappings[0].sourceMappingKey, "6.21A|m2|18|1|10");
});

test("known access boundary regression clusters ac____ and acc___ and exposes sources", () => {
  const manifest = auditCtwLogicalIdentities([
    item(
      "reading-ctw-version-a",
      question({ prefixes: ["ac", "reso"], displays: ["ac____", "reso_____"] }),
      [occurrence("occurrence-a", { sourceLabel: "6.21A" })]
    ),
    item(
      "reading-ctw-version-b",
      question({ prefixes: ["acc", "reso"], displays: ["acc___", "reso_____,"] }),
      [occurrence("occurrence-b", { sourceLabel: "7.21A", occurrenceDate: "2026-07-21" })]
    )
  ], generatedAt);
  assert.equal(manifest.duplicateClusterCount, 1);
  assert.equal(manifest.prefixConflictClusterCount, 1);
  assert.equal(manifest.clusters[0].prefixConflicts[0].answer, "access");
  assert.deepEqual(
    manifest.clusters[0].prefixConflicts[0].versions.map((version) => ({
      prefix: version.prefix,
      source: version.sources[0].sourceLabel
    })),
    [{ prefix: "ac", source: "6.21A" }, { prefix: "acc", source: "7.21A" }]
  );
  assert.match(renderCtwLogicalIdentityAuditMarkdown(manifest), /Slot 1: prefix_conflict/);
  assert.match(renderCtwLogicalIdentityAuditMarkdown(manifest), /ac____ → access/);
});
