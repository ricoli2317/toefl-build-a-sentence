const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv } = require("../lib/reading/csvAdapter.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { buildReadingImportRows, prepareReadingPackagesForImport } = require("../lib/reading/importer.ts");
const {
  normalizeReadingSemanticText,
  readingPossibleDuplicateFingerprint,
  readingSemanticFingerprint
} = require("../lib/reading/semantic.ts");

const templateDir = path.join(__dirname, "../data/reading/csv-templates");
const fixtureDir = path.join(__dirname, "fixtures/reading");
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

function packagesFromRdlFixture(file, materialCatalog) {
  const document = parseCsvDocument(fs.readFileSync(path.join(fixtureDir, file), "utf8"), {
    trimValues: false
  });
  const adapted = adaptReadingCsv({
    type: "read_in_daily_life",
    rows: document.rows,
    sourceFile: file,
    materials: new Map(materialCatalog.map((item) => [item.materialId, item]))
  });
  assert.deepEqual(adapted.failures, []);
  return groupReadingSourceOccurrences(adapted.candidates).packages;
}

function incomingVariant(historical, mutate) {
  const candidate = packageToSourceCandidate(historical);
  candidate.sourceOccurrenceId = `${candidate.sourceOccurrenceId}-later`;
  candidate.source.sourceLabel = "EXAMPLE-20260830";
  candidate.source.occurrenceDate = "2026-08-30";
  candidate.source.yearMonth = "2026-08";
  mutate(candidate);
  return groupReadingSourceOccurrences([candidate]).packages[0];
}

function contentVariant(packageData, mutate) {
  const candidate = packageToSourceCandidate(packageData);
  mutate(candidate);
  return groupReadingSourceOccurrences([candidate]).packages[0];
}

function packageToSourceCandidate(packageData) {
  return {
    sourceOccurrenceId: packageData.occurrences[0].occurrenceId,
    module: packageData.item.module,
    title: packageData.item.title,
    source: {
      sourceKind: packageData.occurrences[0].sourceKind,
      sourceLabel: packageData.occurrences[0].sourceLabel,
      occurrenceDate: packageData.occurrences[0].occurrenceDate,
      yearMonth: packageData.occurrences[0].yearMonth,
      sourceQuestionFile: packageData.occurrences[0].sourceQuestionFile,
      sourceAnswerFile: packageData.occurrences[0].sourceAnswerFile,
      sourceModule: packageData.occurrences[0].sourceModule,
      sourceOrder: packageData.occurrences[0].sourceOrder,
      sourceQuestionStart: packageData.occurrences[0].sourceQuestionStart,
      sourceQuestionEnd: packageData.occurrences[0].sourceQuestionEnd
    },
    materials: structuredClone(packageData.materials),
    passages: structuredClone(packageData.passages).map(({ logicalItemId, ...passage }) => passage),
    questions: structuredClone(packageData.questions).map((question, index) => ({
      ...question,
      sourceQuestionStart: packageData.occurrences[0].questionSources[index].sourceQuestionStart,
      sourceQuestionEnd: packageData.occurrences[0].questionSources[index].sourceQuestionEnd
    }))
  };
}

function historicalDatabase(...packages) {
  const tables = {};
  for (const packageData of packages) {
    const rows = buildReadingImportRows(packageData);
    for (const [table, values] of Object.entries(rows)) {
      tables[table] = [...(tables[table] ?? []), ...structuredClone(values)];
    }
  }
  const queryCalls = [];
  return {
    queryCalls,
    from(table) {
      return {
        select() {
          return {
            async in(column, values) {
              queryCalls.push({ table, column, values });
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

async function historicalMatch(historical, incoming) {
  const database = historicalDatabase(historical);
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableHistoricalSemanticFallback: true
  });
  return { prepared, database };
}

test("shared semantic text normalization is cautious about punctuation", () => {
  assert.equal(
    normalizeReadingSemanticText("  Students\u2019  \r\n work \u201chere\u201d "),
    'Students\' work "here"'
  );
  assert.notEqual(
    normalizeReadingSemanticText("rocks minerals"),
    normalizeReadingSemanticText("rocks, minerals")
  );
});

test("CTW blank display serialization and smart quotes reuse historical canonical IDs", async () => {
  const historical = contentVariant(
    packageFrom("complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv"),
    (candidate) => { candidate.questions[0].stem = "Complete the student's words."; }
  );
  const incoming = incomingVariant(historical, (candidate) => {
    const question = candidate.questions[0];
    question.stem = "Complete the student\u2019s words.";
    question.payload.paragraphs[0].rawText = question.payload.paragraphs[0].rawText.replace("____", "_ _ _ _");
    question.payload.slots[0].displayText = question.payload.slots[0].displayText.replace("____", "_ _ _ _");
  });
  assert.notEqual(historical.item.dedupFingerprint, incoming.item.dedupFingerprint);
  assert.equal(readingSemanticFingerprint(historical), readingSemanticFingerprint(incoming));
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.equal(prepared.packageData.questions[0].questionId, historical.questions[0].questionId);
  assert.equal(prepared.addedOccurrenceCount, 1);
  assert.equal(buildReadingImportRows(prepared.packageData).reading_logical_items[0].dedup_fingerprint, historical.item.dedupFingerprint);
});

test("CTW answer, prefix, blank-position, and substantive text changes never silently merge", async () => {
  const historical = packageFrom("complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv");
  for (const mutate of [
    (question) => { question.payload.slots[0].answer = "scientists"; },
    (question) => { question.payload.slots[0].prefix = "science"; },
    (question) => { question.payload.paragraphs[0].segments.reverse(); },
    (question) => { question.payload.paragraphs[0].segments[0].text = "Substantive change "; }
  ]) {
    const incoming = incomingVariant(historical, (candidate) => mutate(candidate.questions[0]));
    assert.notEqual(readingSemanticFingerprint(historical), readingSemanticFingerprint(incoming));
    const { prepared } = await historicalMatch(historical, incoming);
    assert.equal(prepared.reuseKind, "new");
  }
  const answerVariant = incomingVariant(historical, (candidate) => {
    candidate.questions[0].payload.slots[0].answer = "scientists";
  });
  assert.equal(
    readingPossibleDuplicateFingerprint(historical),
    readingPossibleDuplicateFingerprint(answerVariant)
  );
  const { prepared } = await historicalMatch(historical, answerVariant);
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, [historical.item.logicalItemId]);
});

test("Dorm Printer RDL option-order-only and correct-letter-only changes reuse the historical logical item", async () => {
  const historical = contentVariant(
    packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv"),
    (candidate) => {
      candidate.title = "Dorm Printer Setup Instructions";
      candidate.materials[0] = {
        ...candidate.materials[0],
        materialId: "RDL-002",
        title: "Dorm Printer Setup Instructions",
        materialType: "instructions",
        imageAssetPath: "reading/rdl/RDL-002/material_final.png",
        hitboxDataPath: "reading/rdl/RDL-002/selection_map.json"
      };
      for (const question of candidate.questions) question.payload.materialId = "RDL-002";
      candidate.questions[0].stem = "What is the student's meeting time?";
    }
  );
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.questions[0].stem = "What is the student\u2019s meeting time?";
    for (const question of candidate.questions) {
      question.payload.options.reverse().forEach((option, index) => { option.optionOrder = index + 1; });
    }
  });
  assert.notEqual(historical.item.dedupFingerprint, incoming.item.dedupFingerprint);
  const { prepared, database } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.equal(prepared.materialMatchKind, "exact_material");
  assert.equal(prepared.packageData.questions[0].payload.correctOptionId, historical.questions[0].payload.correctOptionId);
  assert.equal(buildReadingImportRows(prepared.packageData).reading_logical_items[0].dedup_fingerprint, historical.item.dedupFingerprint);
  assert.equal(database.queryCalls.filter((call) => call.table === "reading_logical_items" && call.column === "module").length, 1);
});

test("RDL same canonical material and identical asset keys reuse the historical logical item", async () => {
  const historical = packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.questions[0].stem = candidate.questions[0].stem.replace("does", "does  ");
  });
  assert.notEqual(historical.item.dedupFingerprint, incoming.item.dedupFingerprint);
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.materialMatchKind, "exact_material");
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
});

test("RDL logical semantics ignore storage path representations after exact canonical material resolution", async () => {
  const canonical = packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  const representations = [
    {
      imageAssetPath: "reading/rdl/RDL-001/releases/2026-08/material_final.png",
      hitboxDataPath: "reading/rdl/RDL-001/releases/2026-08/selection_map.json"
    },
    {
      imageAssetPath: "/reading/rdl/RDL-001/material_final.png",
      hitboxDataPath: "/reading/rdl/RDL-001/selection_map.json"
    },
    {
      imageAssetPath: "https://assets.example.test/reading/rdl/RDL-001/material_final.png",
      hitboxDataPath: "https://assets.example.test/reading/rdl/RDL-001/selection_map.json"
    }
  ];
  for (const representation of representations) {
    const historical = structuredClone(canonical);
    Object.assign(historical.materials[0], representation);
    const incoming = incomingVariant(canonical, (candidate) => {
      for (const question of candidate.questions) {
        question.payload.options.reverse().forEach((option, index) => { option.optionOrder = index + 1; });
      }
    });
    const { prepared } = await historicalMatch(historical, incoming);
    assert.equal(prepared.materialMatchKind, "exact_material");
    assert.equal(prepared.reuseKind, "semantic");
    assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
    assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
  }
});

test("RDL same material with a different question set is possible duplicate, not semantic reuse", async () => {
  const historical = packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.questions[0].stem = "A substantively different question?";
  });
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "new");
  assert.equal(prepared.materialMatchKind, "exact_material");
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, [historical.item.logicalItemId]);
});

test("RDL unresolved material similarity remains possible material duplicate and never auto-merges", async () => {
  const historical = packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.materials[0] = {
      ...candidate.materials[0],
      materialId: "RDL-099",
      imageAssetPath: "reading/rdl/RDL-099/material_final.png",
      hitboxDataPath: "reading/rdl/RDL-099/selection_map.json"
    };
    for (const question of candidate.questions) question.payload.materialId = "RDL-099";
  });
  const database = historicalDatabase(historical);
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableHistoricalSemanticFallback: true,
    rdlMaterialCatalog: [historical.materials[0]]
  });
  assert.equal(prepared.reuseKind, "new");
  assert.equal(prepared.materialMatchKind, "possible_material_duplicate");
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, [historical.item.logicalItemId]);
});

test("7.15A RDL-013 and RDL-014 reuse historical logical items across versioned asset keys", async () => {
  const incomingMaterials = [
    {
      materialId: "RDL-013",
      title: "Tasty Bites",
      materialType: "review",
      source: "fixture",
      sourceDate: "2026-05-10",
      yearMonth: "2026-05",
      bindingStatus: "bound",
      imageAssetPath: "reading/rdl/RDL-013/material_final.png",
      hitboxDataPath: "reading/rdl/RDL-013/selection_map.json"
    },
    {
      materialId: "RDL-014",
      title: "Revitalizing Ridgeview Campus Life",
      materialType: "newspaper_article",
      source: "fixture",
      sourceDate: "2026-05-10",
      yearMonth: "2026-05",
      bindingStatus: "bound",
      imageAssetPath: "reading/rdl/RDL-014/material_final.png",
      hitboxDataPath: "reading/rdl/RDL-014/selection_map.json"
    }
  ];
  const historicalFiles = [
    "reading-rdl-590c3732c15f9453625de6d7.json",
    "reading-rdl-4173e5fbe41ba56d482f6c87.json"
  ];
  const historical = historicalFiles.map((file, index) => {
    const packageData = JSON.parse(fs.readFileSync(path.join(
      __dirname,
      "../data/reading/import-packages/rdl",
      file
    ), "utf8"));
    const material = incomingMaterials[index];
    packageData.item.title = material.title;
    packageData.materials[0] = {
      ...packageData.materials[0],
      title: material.title,
      materialType: material.materialType,
      imageAssetPath: `reading/rdl/${material.materialId}/version-2026-08-30/material_final.png`,
      hitboxDataPath: `reading/rdl/${material.materialId}/version-2026-08-30/selection_map.json`
    };
    return packageData;
  });
  const incoming = packagesFromRdlFixture(
    "TOEFL_Reading_2026_07_15A_DEDUP_TEST_PRODUCTION_RDL.csv",
    incomingMaterials
  );
  const prepared = await prepareReadingPackagesForImport(
    historicalDatabase(...historical),
    incoming,
    { enableHistoricalSemanticFallback: true, rdlMaterialCatalog: incomingMaterials }
  );
  assert.equal(prepared.length, 2);
  assert.ok(prepared.every((item) => item.materialMatchKind === "exact_material"));
  assert.ok(prepared.every((item) => item.reuseKind === "semantic"));
  assert.ok(prepared.every((item) => item.existingItem));
  assert.ok(prepared.every((item) => item.addedOccurrenceCount === 1));
  assert.ok(prepared.every((item) => item.possibleDuplicateLogicalItemIds.length === 0));
  assert.ok(prepared.every((item) => item.occurrenceConflict === null));
});

test("RAP option-order-only and correct-letter-only changes reuse historical passage/questions", async () => {
  const historical = contentVariant(
    packageFrom("read_an_academic_passage", "TOEFL_Read_an_Academic_Passage_TEMPLATE.csv"),
    (candidate) => { candidate.questions[0].stem = "What is Earth's tidal force?"; }
  );
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.questions[0].stem = "What is Earth\u2019s tidal force?";
    const multipleChoice = candidate.questions.find((question) => question.questionType === "rap_multiple_choice");
    multipleChoice.payload.options.reverse().forEach((option, index) => { option.optionOrder = index + 1; });
  });
  assert.notEqual(historical.item.dedupFingerprint, incoming.item.dedupFingerprint);
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.deepEqual(
    prepared.packageData.questions.map((question) => question.questionId),
    historical.questions.map((question) => question.questionId)
  );
  assert.equal(buildReadingImportRows(prepared.packageData).reading_logical_items[0].dedup_fingerprint, historical.item.dedupFingerprint);
});

test("RAP internal passage/anchor IDs do not affect semantics, but different questions do", async () => {
  const historical = packageFrom("read_an_academic_passage", "TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const idVariant = structuredClone(historical);
  const insertion = idVariant.questions.find((question) => question.questionType === "rap_sentence_insertion");
  const priorCorrect = insertion.correctAnchorId ?? insertion.payload.correctAnchorId;
  const correctOrder = insertion.payload.anchors.find((anchor) => anchor.anchorId === priorCorrect).anchorOrder;
  insertion.payload.anchors.forEach((anchor) => { anchor.anchorId = `different-${anchor.anchorOrder}`; });
  insertion.payload.correctAnchorId = `different-${correctOrder}`;
  assert.equal(readingSemanticFingerprint(historical), readingSemanticFingerprint(idVariant));

  const incoming = incomingVariant(historical, (candidate) => {
    candidate.questions[0].stem = "A different academic question?";
  });
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "new");
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, [historical.item.logicalItemId]);
});

test("same occurrence with semantically changed content remains a fail-safe conflict", async () => {
  const historical = packageFrom("read_an_academic_passage", "TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.sourceOccurrenceId = historical.occurrences[0].occurrenceId;
    candidate.questions[0].stem = "Different content for the same occurrence";
  });
  const database = historicalDatabase(historical);
  database.from = occurrenceAwareFrom(database.from, historical.occurrences);
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableHistoricalSemanticFallback: true
  });
  assert.match(prepared.occurrenceConflict, /refusing to rebind/);
});

test("semantic variants in one CSV coalesce before import, while conflicting shared occurrences fail", async () => {
  const first = packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  const optionOrderVariant = incomingVariant(first, (candidate) => {
    for (const question of candidate.questions) {
      question.payload.options.reverse().forEach((option, index) => { option.optionOrder = index + 1; });
    }
  });
  const preparedSemantic = await prepareReadingPackagesForImport(
    historicalDatabase(),
    [first, optionOrderVariant],
    { enableHistoricalSemanticFallback: true }
  );
  assert.equal(preparedSemantic.length, 1);
  assert.equal(preparedSemantic[0].batchSemanticReuseCount, 1);
  assert.equal(preparedSemantic[0].packageData.occurrences.length, 2);

  const conflicting = incomingVariant(first, (candidate) => {
    candidate.sourceOccurrenceId = first.occurrences[0].occurrenceId;
    candidate.questions[0].stem = "Substantively different current-batch content";
  });
  const preparedConflict = await prepareReadingPackagesForImport(
    historicalDatabase(),
    [first, conflicting],
    { enableHistoricalSemanticFallback: true }
  );
  assert.equal(preparedConflict.length, 2);
  assert.ok(preparedConflict.every((prepared) => /current CSV/.test(prepared.occurrenceConflict)));
});

function occurrenceAwareFrom(originalFrom, occurrences) {
  return (table) => {
    if (table !== "reading_source_occurrences") return originalFrom(table);
    return {
      select() {
        return {
          async in(column, values) {
            return {
              data: occurrences
                .map((item) => ({ occurrence_id: item.occurrenceId, logical_item_id: item.logicalItemId }))
                .filter((row) => values.includes(row[column])),
              error: null
            };
          }
        };
      }
    };
  };
}
