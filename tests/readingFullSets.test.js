const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildReadingFullSetCatalog,
  buildReadingFullSets,
  readingFullSetIdentity,
  ReadingFullSetIdentityError
} = require("../lib/reading/fullSets.ts");

const projectRoot = path.join(__dirname, "..");

function jsonFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(target) : entry.name.endsWith(".json") ? [target] : [];
  }).sort();
}

function repositoryOccurrenceInputs() {
  return jsonFiles(path.join(projectRoot, "data/reading/import-packages")).flatMap((file) => {
    const packageData = JSON.parse(fs.readFileSync(file, "utf8"));
    return packageData.occurrences.map((occurrence) => ({
      occurrenceId: occurrence.occurrenceId,
      logicalItemId: occurrence.logicalItemId,
      taskType: packageData.item.module,
      occurrenceDate: occurrence.occurrenceDate,
      sourceLabel: occurrence.sourceLabel,
      sourceModule: occurrence.sourceModule,
      sourceOrder: occurrence.sourceOrder,
      sourceQuestionStart: occurrence.sourceQuestionStart,
      sourceQuestionEnd: occurrence.sourceQuestionEnd,
      scoringPointCount: packageData.item.scoredItemCount
    }));
  });
}

const occurrenceInputs = repositoryOccurrenceInputs();
const fullSets = buildReadingFullSets(occurrenceInputs);

function sourceInputs(sourceLabel) {
  return structuredClone(occurrenceInputs.filter((occurrence) => occurrence.sourceLabel === sourceLabel));
}

test("Full Set identity preserves real source suffixes and never invents A", () => {
  assert.deepEqual(
    readingFullSetIdentity({ occurrenceDate: "2026-06-01", sourceLabel: "6.1A" }),
    { fullSetId: "20260601A", title: "20260601A" }
  );
  assert.deepEqual(
    readingFullSetIdentity({ occurrenceDate: "2026-06-01", sourceLabel: "6.1C" }),
    { fullSetId: "20260601C", title: "20260601C" }
  );
  assert.deepEqual(
    readingFullSetIdentity({ occurrenceDate: "2026-06-09", sourceLabel: "6.9" }),
    { fullSetId: "20260609", title: "20260609" }
  );
});

test("Full Set identity rejects a source label whose month/day disagrees with the occurrence date", () => {
  assert.throws(
    () => readingFullSetIdentity({ occurrenceDate: "2026-06-01", sourceLabel: "6.2A" }),
    (error) => error instanceof ReadingFullSetIdentityError && error.code === "SOURCE_IDENTITY_MISMATCH"
  );
});

test("20260601A is a complete Pattern 1 set in original source order", () => {
  const fullSet = fullSets.find((item) => item.fullSetId === "20260601A");
  assert.ok(fullSet);
  assert.equal(fullSet.validation.valid, true);
  assert.equal(fullSet.module1.pattern, "pattern_1");
  assert.equal(fullSet.module1.scoringPointCount, 35);
  assert.equal(fullSet.module1.timeLimitSeconds, 1230);
  assert.equal(fullSet.module2.scoringPointCount, 15);
  assert.equal(fullSet.module2.timeLimitSeconds, 540);
  assert.deepEqual(
    fullSet.module1.occurrences.map((occurrence) => occurrence.sourceOrder),
    [...fullSet.module1.occurrences].map((occurrence) => occurrence.sourceOrder).sort((left, right) => left - right)
  );
});

test("20260609 is a complete Pattern 2 set", () => {
  const fullSet = fullSets.find((item) => item.fullSetId === "20260609");
  assert.ok(fullSet);
  assert.equal(fullSet.validation.valid, true);
  assert.equal(fullSet.module1.pattern, "pattern_2");
  assert.equal(fullSet.module1.scoringPointCount, 35);
  assert.equal(fullSet.module1.timeLimitSeconds, 1110);
  assert.equal(fullSet.module2.scoringPointCount, 15);
  assert.equal(fullSet.module2.timeLimitSeconds, 540);
});

test("public Full Set catalog keeps C suffixes and excludes incomplete 20260602", () => {
  const catalog = buildReadingFullSetCatalog(fullSets);
  assert.ok(catalog.some((item) => item.fullSetId === "20260601C"));
  assert.ok(catalog.some((item) => item.fullSetId === "20260607C"));
  assert.equal(catalog.some((item) => item.fullSetId === "20260602"), false);
  assert.deepEqual(
    catalog.filter((item) => item.occurrenceDate === "2026-06-01").map((item) => item.sourceLabel),
    ["6.1A", "6.1B", "6.1C"]
  );
});

test("20260602 is invalid because M1 questions 1-10 are missing", () => {
  const fullSet = fullSets.find((item) => item.fullSetId === "20260602");
  assert.ok(fullSet);
  assert.equal(fullSet.validation.valid, false);
  assert.equal(fullSet.validation.module1Valid, false);
  assert.equal(fullSet.validation.questionCoverageValid, false);
  assert.ok(fullSet.validation.reasons.includes("M1_MISSING_QUESTIONS"));
  assert.equal(fullSet.module1.scoringPointCount, 25);
});

test("validator rejects duplicate source order and overlapping source ranges", () => {
  const inputs = sourceInputs("6.1A");
  const firstCtw = inputs.find((occurrence) => occurrence.sourceModule === "m1" && occurrence.sourceOrder === 1);
  const secondCtw = inputs.find((occurrence) => occurrence.sourceModule === "m1" && occurrence.sourceOrder === 2);
  assert.ok(firstCtw && secondCtw);
  secondCtw.sourceOrder = firstCtw.sourceOrder;
  secondCtw.sourceQuestionStart = 5;
  secondCtw.sourceQuestionEnd = 14;
  const [fullSet] = buildReadingFullSets(inputs);
  assert.equal(fullSet.validation.valid, false);
  assert.ok(fullSet.validation.reasons.includes("DUPLICATE_SOURCE_ORDER"));
  assert.ok(fullSet.validation.reasons.includes("SOURCE_RANGE_OVERLAP"));
});

test("validator derives RDL length from scoring points and rejects any other size", () => {
  const inputs = sourceInputs("6.1A");
  const rdl = inputs.find((occurrence) => occurrence.taskType === "rdl");
  assert.ok(rdl);
  rdl.scoringPointCount = 4;
  const [fullSet] = buildReadingFullSets(inputs);
  assert.equal(fullSet.validation.valid, false);
  assert.ok(fullSet.validation.reasons.includes("INVALID_RDL_LENGTH"));
});

test("current repository Full Set regression is 46 valid, 1 invalid, with 27/19 patterns", () => {
  const valid = fullSets.filter((fullSet) => fullSet.validation.valid);
  const invalid = fullSets.filter((fullSet) => !fullSet.validation.valid);
  assert.equal(fullSets.length, 47);
  assert.equal(valid.length, 46);
  assert.equal(invalid.length, 1);
  assert.equal(valid.filter((fullSet) => fullSet.module1.pattern === "pattern_1").length, 27);
  assert.equal(valid.filter((fullSet) => fullSet.module1.pattern === "pattern_2").length, 19);
  assert.deepEqual(invalid.map((fullSet) => fullSet.fullSetId), ["20260602"]);
});
