const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildCtwPackageLogicalIdentity } = require("../lib/reading/ctwLogicalIdentity.server.ts");
const { buildReadingCanonicalContentUpdate } = require("../lib/reading/contentCorrection.ts");
const { buildReadingDuplicateReviewPlans } = require("../lib/reading/duplicateResolution.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { buildReadingImportRows, prepareReadingPackagesForImport } = require("../lib/reading/importer.ts");

const historicalPath = path.join(
  __dirname,
  "../data/reading/import-packages/ctw/reading-ctw-e12835c96f7207294b51eadd.json"
);

function historicalAccessPackage() {
  const packageData = JSON.parse(fs.readFileSync(historicalPath, "utf8"));
  packageData.item.title = "Resource Access Policies";
  return packageData;
}

function packageToCandidate(packageData, { label, date, sourceOrder = 8, mutate = () => {} }) {
  const occurrence = packageData.occurrences[0];
  const candidate = {
    sourceOccurrenceId: `${occurrence.occurrenceId}-${label}`,
    module: "ctw",
    title: null,
    source: {
      sourceKind: occurrence.sourceKind,
      sourceLabel: label,
      occurrenceDate: date,
      yearMonth: date.slice(0, 7),
      sourceQuestionFile: occurrence.sourceQuestionFile,
      sourceAnswerFile: occurrence.sourceAnswerFile,
      sourceModule: "m2",
      sourceOrder,
      sourceQuestionStart: occurrence.sourceQuestionStart,
      sourceQuestionEnd: occurrence.sourceQuestionEnd
    },
    materials: [],
    passages: [],
    questions: packageData.questions.map((question, index) => ({
      ...structuredClone(question),
      sourceQuestionStart: occurrence.questionSources[index].sourceQuestionStart,
      sourceQuestionEnd: occurrence.questionSources[index].sourceQuestionEnd
    }))
  };
  mutate(candidate.questions[0]);
  rebuildRawText(candidate.questions[0]);
  return candidate;
}

function rebuildRawText(question) {
  const slots = new Map(question.payload.slots.map((slot) => [slot.slotId, slot]));
  for (const paragraph of question.payload.paragraphs) {
    paragraph.rawText = paragraph.segments.map((segment) =>
      segment.kind === "text" ? segment.text : slots.get(segment.slotId).displayText
    ).join("");
  }
}

function setAccessPrefix(question, prefix) {
  const slot = question.payload.slots.find((candidate) => candidate.answer === "access");
  slot.prefix = prefix;
  slot.missingText = slot.answer.slice(prefix.length);
  slot.missingLength = slot.missingText.length;
  slot.displayText = `${prefix}${"_".repeat(slot.missingLength)}`;
}

function addResourcesComma(question) {
  const resources = question.payload.slots.find((slot) => slot.answer === "resources");
  const segments = question.payload.paragraphs[0].segments;
  const index = segments.findIndex((segment) =>
    segment.kind === "blank" && segment.slotId === resources.slotId
  );
  segments[index + 1].text = segments[index + 1].text.replace(/^\s*such\b/, ", such");
}

function historicalDatabase(...packages) {
  const tables = {};
  for (const packageData of packages) {
    for (const [table, rows] of Object.entries(buildReadingImportRows(packageData))) {
      tables[table] = [...(tables[table] ?? []), ...structuredClone(rows)];
    }
  }
  return {
    from(table) {
      return {
        select() {
          return {
            async in(column, values) {
              return {
                data: (tables[table] ?? []).filter((row) => values.includes(row[column])),
                error: null
              };
            }
          };
        }
      };
    }
  };
}

async function prepareAgainstHistorical(incoming, historical = historicalAccessPackage()) {
  const [prepared] = await prepareReadingPackagesForImport(
    historicalDatabase(historical),
    [incoming],
    { enableCtwFingerprintFallback: true, enableHistoricalSemanticFallback: true }
  );
  return prepared;
}

function prepared(packageData, candidates) {
  return {
    packageData,
    existingItem: null,
    reuseKind: "new",
    batchSemanticReuseCount: 0,
    possibleDuplicateLogicalItemIds: candidates.map((candidate) => candidate.item.logicalItemId),
    possibleDuplicateCandidates: candidates,
    contentReconciliations: [],
    historicalDuplicateLogicalItemIds: [],
    materialMatchKind: "not_applicable",
    addedOccurrenceCount: packageData.occurrences.length,
    occurrenceConflict: null
  };
}

test("real access boundary reuses historical identity and becomes a prefix content conflict", async () => {
  const historical = historicalAccessPackage();
  const incoming = groupReadingSourceOccurrences([
    packageToCandidate(historical, {
      label: "7.5A",
      date: "2026-07-05",
      mutate: (question) => setAccessPrefix(question, "acc")
    })
  ]).packages[0];
  assert.notEqual(incoming.item.dedupFingerprint, historical.item.dedupFingerprint);
  assert.equal(
    buildCtwPackageLogicalIdentity(incoming).key,
    buildCtwPackageLogicalIdentity(historical).key
  );

  const result = await prepareAgainstHistorical(incoming, historical);
  assert.equal(result.existingItem.logicalItemId, historical.item.logicalItemId);
  assert.deepEqual(result.possibleDuplicateLogicalItemIds, []);
  assert.equal(buildReadingDuplicateReviewPlans([result]).length, 0);
  assert.equal(result.contentReconciliations.length, 1);
  assert.deepEqual(
    result.contentReconciliations[0].item.questionConflicts[0].differences.map((item) => item.kind),
    ["ctw_slot_content"]
  );
  assert.deepEqual(
    result.contentReconciliations[0].item.questionConflicts[0].ctwSlotConflicts.map((item) => item.slotOrder),
    [1]
  );

  const corrected = buildReadingCanonicalContentUpdate(historical, incoming);
  assert.equal(corrected.item.logicalItemId, historical.item.logicalItemId);
  assert.equal(corrected.item.dedupFingerprint, historical.item.dedupFingerprint);
  assert.equal(corrected.questions[0].payload.slots[0].prefix, "acc");
});

test("real resources comma variant reuses with no duplicate or content conflict", async () => {
  const historical = historicalAccessPackage();
  const incoming = groupReadingSourceOccurrences([
    packageToCandidate(historical, {
      label: "7.21A",
      date: "2026-07-21",
      sourceOrder: 1,
      mutate: addResourcesComma
    })
  ]).packages[0];
  const result = await prepareAgainstHistorical(incoming, historical);
  assert.equal(result.existingItem.logicalItemId, historical.item.logicalItemId);
  assert.equal(result.contentReconciliations.length, 0);
  assert.equal(buildReadingDuplicateReviewPlans([result]).length, 0);
});

test("prefix plus punctuation reports only the prefix conflict", async () => {
  const historical = historicalAccessPackage();
  const incoming = groupReadingSourceOccurrences([
    packageToCandidate(historical, {
      label: "7.5A",
      date: "2026-07-05",
      mutate(question) {
        setAccessPrefix(question, "acc");
        addResourcesComma(question);
      }
    })
  ]).packages[0];
  const result = await prepareAgainstHistorical(incoming, historical);
  assert.deepEqual(
    result.contentReconciliations[0].item.questionConflicts[0].differences.map((item) => item.kind),
    ["ctw_slot_content"]
  );
});

test("current-batch prefix and punctuation variants coalesce before provisional candidates exist", () => {
  const historical = historicalAccessPackage();
  const base = packageToCandidate(historical, {
    label: "6.21A",
    date: "2026-06-21",
    sourceOrder: 18
  });
  const prefix = packageToCandidate(historical, {
    label: "7.5A",
    date: "2026-07-05",
    mutate: (question) => setAccessPrefix(question, "acc")
  });
  const punctuation = packageToCandidate(historical, {
    label: "7.21A",
    date: "2026-07-21",
    sourceOrder: 1,
    mutate: addResourcesComma
  });
  assert.equal(groupReadingSourceOccurrences([base, prefix]).packages.length, 1);
  assert.equal(groupReadingSourceOccurrences([base, punctuation]).packages.length, 1);
  const grouped = groupReadingSourceOccurrences([prefix, punctuation]);
  assert.equal(grouped.packages.length, 1);
  assert.equal(grouped.packages[0].occurrences.length, 2);
  assert.equal(grouped.report.possibleDuplicates.length, 0);
});

test("lexical text changes identity while answer and slot-array serialization do not", () => {
  const historical = historicalAccessPackage();
  const base = packageToCandidate(historical, { label: "base", date: "2026-07-05" });
  const variants = [
    packageToCandidate(historical, {
      label: "lexical",
      date: "2026-07-06",
      mutate(question) { question.payload.paragraphs[0].segments.at(-1).text += " New lexical content."; }
    }),
    packageToCandidate(historical, {
      label: "answer",
      date: "2026-07-07",
      mutate(question) { question.payload.slots[0].answer = "accept"; }
    }),
    packageToCandidate(historical, {
      label: "order",
      date: "2026-07-08",
      mutate(question) {
        question.payload.slots.reverse();
      }
    })
  ];
  const baseIdentity = buildCtwPackageLogicalIdentity(groupReadingSourceOccurrences([base]).packages[0]).key;
  const keys = variants.map((candidate) =>
    buildCtwPackageLogicalIdentity(groupReadingSourceOccurrences([candidate]).packages[0]).key
  );
  assert.notEqual(keys[0], baseIdentity);
  assert.equal(keys[1], baseIdentity);
  assert.equal(keys[2], baseIdentity);
});

test("same-identity candidates cannot reach duplicate review as separate logical targets", () => {
  const historical = historicalAccessPackage();
  const candidateA = structuredClone(historical);
  const candidateB = structuredClone(historical);
  candidateA.item.logicalItemId = "candidate-a";
  candidateB.item.logicalItemId = "candidate-b";
  const incomingCandidate = packageToCandidate(historical, {
    label: "different",
    date: "2026-08-01",
    mutate(question) { question.payload.slots[0].answer = "accept"; }
  });
  const incoming = groupReadingSourceOccurrences([incomingCandidate]).packages[0];
  assert.throws(
    () => buildReadingDuplicateReviewPlans([prepared(incoming, [candidateA, candidateB])]),
    (error) => error.code === "READING_CTW_IDENTITY_CLUSTER_INVARIANT"
  );

  const sameIncoming = groupReadingSourceOccurrences([
    packageToCandidate(historical, {
      label: "7.5A",
      date: "2026-07-05",
      mutate: (question) => setAccessPrefix(question, "acc")
    })
  ]).packages[0];
  assert.throws(
    () => buildReadingDuplicateReviewPlans([prepared(sameIncoming, [candidateA])]),
    (error) => error.code === "READING_CTW_IDENTITY_CLUSTER_INVARIANT"
  );
});
