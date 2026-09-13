const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildCtwLogicalIdentity,
  buildCtwMaskedFramework,
  compareCtwLogicalIdentity,
  normalizeCtwIdentityPassage,
  normalizeCtwMaskedFramework,
  normalizeCtwOrderedAnswers,
  reconstructCompletedCtwPassage
} = require("../lib/reading/ctwLogicalIdentity.ts");

function ctwQuestion({
  textBefore = "Scientists dictate ",
  between = " to ",
  textAfter = " such policies matter.",
  answers = ["access", "resources"],
  prefixes = ["ac", "reso"],
  displays
} = {}) {
  const paragraphId = "question-p01";
  const slots = answers.map((answer, index) => {
    const prefix = prefixes[index] ?? "";
    const missingText = answer.slice(prefix.length);
    return {
      slotId: `slot-${index + 1}`,
      slotOrder: index + 1,
      paragraphId,
      answer,
      prefix,
      displayText: displays?.[index] ?? `${prefix}${"_".repeat(missingText.length)}`,
      missingText,
      missingLength: Array.from(missingText).length
    };
  });
  const segments = [{ kind: "text", text: textBefore }];
  if (slots[0]) segments.push({ kind: "blank", slotId: slots[0].slotId });
  if (slots[1]) {
    segments.push({ kind: "text", text: between });
    segments.push({ kind: "blank", slotId: slots[1].slotId });
  }
  for (const slot of slots.slice(2)) {
    segments.push({ kind: "text", text: " then " });
    segments.push({ kind: "blank", slotId: slot.slotId });
  }
  segments.push({ kind: "text", text: textAfter });
  return {
    questionId: "question",
    logicalItemId: "logical-item",
    questionOrder: 1,
    questionType: "ctw",
    stem: "Fill in the missing letters.",
    rawDisplayText: "presentation-only",
    payload: {
      paragraphs: [{
        paragraphId,
        paragraphOrder: 1,
        rawText: "presentation-only",
        segments
      }],
      slots
    }
  };
}

function comparison(left, right) {
  return compareCtwLogicalIdentity(left, right);
}

function assertSame(left, right) {
  const result = comparison(left, right);
  assert.equal(result.sameLogicalItem, true);
  assert.equal(result.leftIdentity.key, result.rightIdentity.key);
  return result;
}

function assertDifferent(left, right) {
  const result = comparison(left, right);
  assert.equal(result.sameLogicalItem, false);
  assert.notEqual(result.leftIdentity.key, result.rightIdentity.key);
  return result;
}

test("CTW identity masks structured blanks while completed answers remain debug-only", () => {
  const question = ctwQuestion();
  assert.equal(
    reconstructCompletedCtwPassage(question),
    "Scientists dictate access to resources such policies matter."
  );
  assert.deepEqual(normalizeCtwOrderedAnswers(question), ["access", "resources"]);
  assert.deepEqual(buildCtwMaskedFramework(question), [
    "Scientists dictate  <BLANK_1>  to  <BLANK_2>  such policies matter."
  ]);
  assert.deepEqual(normalizeCtwMaskedFramework(buildCtwMaskedFramework(question)), [
    "scientists dictate <BLANK_1> to <BLANK_2> such policies matter"
  ]);
  assertSame(question, structuredClone(question));
});

test("CTW identity ignores prefix and blank-boundary differences but reports prefix conflict", () => {
  const left = ctwQuestion({ prefixes: ["ac", "reso"], displays: ["ac____", "reso_____"] });
  const right = ctwQuestion({ prefixes: ["acc", "reso"], displays: ["acc___", "reso_____"] });
  const result = assertSame(left, right);
  assert.equal(result.nonIdentityConflicts.length, 1);
  assert.equal(result.nonIdentityConflicts[0].kind, "prefix_conflict");
  assert.deepEqual(result.nonIdentityConflicts[0].slots[0], {
    slotOrder: 1,
    differenceKinds: ["prefix"],
    leftPrefix: "ac",
    rightPrefix: "acc",
    leftAnswer: "access",
    rightAnswer: "access",
    leftReviewText: "ac____ → access",
    rightReviewText: "acc___ → access"
  });
});

test("CTW identity ignores underscore count, spacing, and standalone underscore noise", () => {
  const canonical = ctwQuestion({ displays: ["ac____", "reso_____"] });
  const countVariant = ctwQuestion({ displays: ["ac________", "reso__"] });
  const spacingVariant = ctwQuestion({ displays: ["ac_ _ _ _", "reso_  _ _"] });
  const standaloneNoise = ctwQuestion({
    textBefore: "Scientists _ dictate ",
    textAfter: " such _ policies matter."
  });
  assertSame(canonical, countVariant);
  assertSame(canonical, spacingVariant);
  assertSame(canonical, standaloneNoise);
});

test("CTW identity ignores commas, periods, colons, and semicolons", () => {
  const canonical = ctwQuestion({ textAfter: " such policies matter" });
  for (const textAfter of [", such policies matter.", ": such policies matter;", "; such policies matter:"]) {
    assertSame(canonical, ctwQuestion({ textAfter }));
  }
});

test("CTW identity ignores em dash, en dash, hyphen, and quotation-mark variants", () => {
  const canonical = ctwQuestion({ textBefore: 'Scientists "often" dictate - ' });
  const variants = [
    ctwQuestion({ textBefore: "Scientists “often” dictate — " }),
    ctwQuestion({ textBefore: "Scientists 'often' dictate – " }),
    ctwQuestion({ textBefore: "Scientists ‘often’ dictate - " })
  ];
  for (const variant of variants) assertSame(canonical, variant);
});

test("CTW identity ignores whitespace, newlines, tabs, and case", () => {
  const canonical = ctwQuestion();
  const variant = ctwQuestion({
    textBefore: "  SCIENTISTS\n\tdictate  ",
    between: "\nTO\t",
    textAfter: "  SUCH\nPOLICIES\tMATTER.  ",
    answers: [" ACCESS ", "RESOURCES"],
    prefixes: ["AC", "RESO"]
  });
  assertSame(canonical, variant);
});

test("CTW identity differs for a lexical passage change", () => {
  assertDifferent(
    ctwQuestion({ textAfter: " such resources matter." }),
    ctwQuestion({ textAfter: " such research matters." })
  );
});

test("CTW identity ignores answer spelling and reports an answer conflict", () => {
  const result = assertSame(
    ctwQuestion({ answers: ["access", "resources"] }),
    ctwQuestion({ answers: ["accept", "resources"] })
  );
  assert.equal(result.nonIdentityConflicts[0].kind, "answer_conflict");
  assert.deepEqual(result.nonIdentityConflicts[0].slots[0].differenceKinds, ["answer"]);
});

test("color and colour share a framework but require answer reconciliation", () => {
  const result = assertSame(
    ctwQuestion({ answers: ["color", "resources"], prefixes: ["col", "reso"] }),
    ctwQuestion({ answers: ["colour", "resources"], prefixes: ["col", "reso"] })
  );
  assert.equal(result.nonIdentityConflicts[0].kind, "answer_conflict");
});

test("prefix plus answer changes become one slot-level content conflict", () => {
  const result = assertSame(
    ctwQuestion({ answers: ["the", "resources"], prefixes: ["t", "reso"] }),
    ctwQuestion({ answers: ["their", "resources"], prefixes: ["th", "reso"] })
  );
  assert.equal(result.nonIdentityConflicts.length, 1);
  assert.equal(result.nonIdentityConflicts[0].kind, "prefix_and_answer_conflict");
  assert.deepEqual(result.nonIdentityConflicts[0].slots[0].differenceKinds, ["prefix", "answer"]);
});

test("CTW identity differs when answer count changes", () => {
  assertDifferent(
    ctwQuestion({ answers: ["access", "resources"] }),
    ctwQuestion({ answers: ["access"], prefixes: ["ac"] })
  );
});

test("CTW identity differs when the same answers are in a different order", () => {
  const left = ctwQuestion({ answers: ["access", "resources"], prefixes: ["ac", "reso"] });
  const right = structuredClone(left);
  right.payload.slots[0].slotOrder = 2;
  right.payload.slots[1].slotOrder = 1;
  assert.equal(reconstructCompletedCtwPassage(left), reconstructCompletedCtwPassage(right));
  assertDifferent(left, right);
});

test("CTW identity differs when one blank moves to another text position", () => {
  const left = ctwQuestion({ textBefore: "The ", between: " fox jumped over the ", textAfter: " dog." });
  const right = ctwQuestion({ textBefore: "The fox ", between: " jumped over the ", textAfter: " dog." });
  assertDifferent(left, right);
});

test("CTW identity differs when a completed passage word is added or removed", () => {
  assertDifferent(
    ctwQuestion({ textAfter: " such policies matter." }),
    ctwQuestion({ textAfter: " policies matter." })
  );
});

test("historical access boundary regression: ac____ and acc___ are the same identity", () => {
  const packagePath = path.join(
    __dirname,
    "../data/reading/import-packages/ctw/reading-ctw-e12835c96f7207294b51eadd.json"
  );
  const historical = JSON.parse(fs.readFileSync(packagePath, "utf8")).questions[0];
  const boundaryVariant = structuredClone(historical);
  const access = boundaryVariant.payload.slots.find((slot) => slot.answer === "access");
  assert.ok(access);
  access.prefix = "acc";
  access.displayText = "acc_ _ _";
  access.missingText = "ess";
  access.missingLength = 3;

  const result = assertSame(historical, boundaryVariant);
  assert.equal(result.nonIdentityConflicts[0].kind, "prefix_conflict");
  assert.equal(result.nonIdentityConflicts[0].slots[0].leftPrefix, "ac");
  assert.equal(result.nonIdentityConflicts[0].slots[0].rightPrefix, "acc");
});

test("historical resources punctuation regression: reso_____ such and reso_____, such are the same identity", () => {
  const packagePath = path.join(
    __dirname,
    "../data/reading/import-packages/ctw/reading-ctw-e12835c96f7207294b51eadd.json"
  );
  const historical = JSON.parse(fs.readFileSync(packagePath, "utf8")).questions[0];
  const punctuationVariant = structuredClone(historical);
  const segments = punctuationVariant.payload.paragraphs[0].segments;
  const resourcesSlot = punctuationVariant.payload.slots.find((slot) => slot.answer === "resources");
  const blankIndex = segments.findIndex(
    (segment) => segment.kind === "blank" && segment.slotId === resourcesSlot.slotId
  );
  assert.ok(blankIndex >= 0 && segments[blankIndex + 1].kind === "text");
  segments[blankIndex + 1].text = segments[blankIndex + 1].text.replace(" such ", ", such ");

  assertSame(historical, punctuationVariant);
  assert.deepEqual(comparison(historical, punctuationVariant).nonIdentityConflicts, []);
});

test("CTW key is exactly derived from normalized masked paragraphs and blank sequence", () => {
  const question = ctwQuestion();
  const presentationVariant = structuredClone(question);
  presentationVariant.stem = "Different stem";
  presentationVariant.rawDisplayText = "totally different raw display";
  presentationVariant.payload.paragraphs[0].rawText = "different raw paragraph";
  presentationVariant.payload.slots.forEach((slot) => {
    slot.displayText = "_";
    slot.missingText = "wrong presentation serialization";
    slot.missingLength = 999;
  });
  assert.deepEqual(buildCtwLogicalIdentity(question), buildCtwLogicalIdentity(presentationVariant));
  assert.deepEqual(Object.keys(buildCtwLogicalIdentity(question)).sort(), [
    "blankCount", "key", "normalizedMaskedParagraphs", "orderedBlankSequence", "version"
  ]);
});

test("CTW passage normalization removes all Unicode punctuation without mutating source", () => {
  const source = "  Resources, such—‘examples’ [matter]!\nNext:\tline? _  ";
  assert.equal(normalizeCtwIdentityPassage(source), "resources such examples matter next line");
  assert.equal(source, "  Resources, such—‘examples’ [matter]!\nNext:\tline? _  ");
});
