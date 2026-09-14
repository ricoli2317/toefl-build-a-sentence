const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv } = require("../lib/reading/csvAdapter.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  assertPreparedReadingPackageCanImport,
  buildReadingImportRows,
  prepareReadingPackagesForImport
} = require("../lib/reading/importer.ts");
const {
  areReadingPackagesHistoricalSemanticEquivalents,
  normalizeCtwSemanticText,
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

function historicalPackage(module, logicalItemId) {
  return JSON.parse(fs.readFileSync(path.join(
    __dirname,
    `../data/reading/import-packages/${module}/${logicalItemId}.json`
  ), "utf8"));
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
    tables,
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

function rebuildCtwRawText(question) {
  const slotById = new Map(question.payload.slots.map((slot) => [slot.slotId, slot]));
  for (const paragraph of question.payload.paragraphs) {
    paragraph.rawText = paragraph.segments.map((segment) =>
      segment.kind === "text" ? segment.text : slotById.get(segment.slotId).displayText
    ).join("");
  }
}

function ctwPresentationBase() {
  return contentVariant(
    packageFrom("complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv"),
    (candidate) => {
      const question = candidate.questions[0];
      const text = question.payload.paragraphs[0].segments.find((segment) =>
        segment.kind === "text" && segment.text.includes("studies nature")
      );
      text.text += " This function—utility and beauty—marks craftsmanship.";
      rebuildCtwRawText(question);
    }
  );
}

function screenshotCtwPackage() {
  const answers = ["for", "food", "water", "clay", "eventually", "decorative", "such", "carefully", "patterns", "painted"];
  const prefixes = ["f", "fo", "wa", "cl", "event", "decor", "su", "care", "patt", "pai"];
  const text = [
    "During the Neolithic period, craftspeople began producing pottery that served both practical and aesthetic purposes. Initially created ",
    " storing ", " and ", ", these ", " vessels ", " featured ", " elements ", " as ",
    " incised ", " and ",
    " designs. This dual function—utility and beauty—marks one of the earliest examples of craftsmanship evolving into artistic expression. The refinement of pottery techniques, including firing and glazing, reflected growing technical skill and cultural values."
  ];
  const packageData = contentVariant(
    packageFrom("complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv"),
    (candidate) => {
      const question = candidate.questions[0];
      const slots = answers.map((answer, index) => {
        const prefix = prefixes[index];
        const missingText = answer.slice(prefix.length);
        return {
          slotId: `screen-slot-${index + 1}`,
          slotOrder: index + 1,
          paragraphId: "screen-paragraph",
          answer,
          prefix,
          displayText: `${prefix}${"_".repeat(Array.from(missingText).length)}`,
          missingText,
          missingLength: Array.from(missingText).length
        };
      });
      const segments = [];
      for (let index = 0; index < slots.length; index += 1) {
        segments.push({ kind: "text", text: text[index] });
        segments.push({ kind: "blank", slotId: slots[index].slotId });
      }
      segments.push({ kind: "text", text: text[text.length - 1] });
      question.payload = {
        paragraphs: [{
          paragraphId: "screen-paragraph",
          paragraphOrder: 1,
          rawText: "",
          segments
        }],
        slots
      };
      question.sourceQuestionStart = 1;
      question.sourceQuestionEnd = 10;
      candidate.source.sourceQuestionStart = 1;
      candidate.source.sourceQuestionEnd = 10;
      rebuildCtwRawText(question);
    }
  );
  const logicalItemId = "reading-ctw-d7d655821c880844faa64ae6";
  packageData.item.logicalItemId = logicalItemId;
  packageData.questions.forEach((question) => { question.logicalItemId = logicalItemId; });
  packageData.occurrences.forEach((occurrence) => { occurrence.logicalItemId = logicalItemId; });
  return packageData;
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

test("CTW exact fingerprint owner blocks reuse when the current masked identity differs", async () => {
  const original = packageFrom("complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv");
  const incoming = incomingVariant(original, () => {});
  const historical = contentVariant(original, (candidate) => {
    const historicalText = candidate.questions[0].payload.paragraphs[0].segments.find(
      (segment) => segment.kind === "text" && segment.text.includes("studies nature")
    );
    historicalText.text += " Canonical wording corrected after the legacy identity was assigned.";
    rebuildCtwRawText(candidate.questions[0]);
  });
  const legacyId = historical.item.logicalItemId;
  const database = historicalDatabase(historical);
  database.tables.reading_logical_items[0].dedup_fingerprint = incoming.item.dedupFingerprint;

  assert.notEqual(historical.item.dedupFingerprint, incoming.item.dedupFingerprint);
  assert.notEqual(readingSemanticFingerprint(historical), readingSemanticFingerprint(incoming));
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableHistoricalSemanticFallback: true
  });
  assert.equal(prepared.reuseKind, "exact_fingerprint");
  assert.equal(prepared.existingItem.logicalItemId, legacyId);
  assert.equal(prepared.packageData.item.logicalItemId, legacyId);
  assert.match(
    prepared.packageData.questions[0].payload.paragraphs[0].rawText,
    /Canonical wording corrected/
  );
  assert.match(prepared.occurrenceConflict, /masked logical identity 不同/);
  assert.throws(
    () => assertPreparedReadingPackageCanImport(prepared),
    /masked logical identity 不同/
  );
});

test("July 7.21B reuses repaired 956ee canonical despite its stale legacy fingerprint", async () => {
  const legacy = historicalPackage("ctw", "reading-ctw-956eea9b8537363f0159a5e3");
  const historical = structuredClone(legacy);
  const historicalQuestion = historical.questions[0];
  historicalQuestion.payload.paragraphs[0].segments.forEach((segment) => {
    if (segment.kind === "text") segment.text = segment.text.replaceAll("’", "'");
  });
  historicalQuestion.payload.slots.forEach((slot) => {
    slot.displayText = `${slot.prefix}${"_".repeat(slot.missingLength)}`;
  });
  rebuildCtwRawText(historicalQuestion);
  historicalQuestion.rawDisplayText = historicalQuestion.payload.paragraphs
    .map((paragraph) => paragraph.rawText)
    .join("\n");

  const currentCanonical = groupReadingSourceOccurrences([
    packageToSourceCandidate(historical)
  ]).packages[0];
  assert.notEqual(currentCanonical.item.dedupFingerprint, historical.item.dedupFingerprint);
  assert.equal(readingSemanticFingerprint(currentCanonical), readingSemanticFingerprint(historical));

  const julyCandidate = packageToSourceCandidate(legacy);
  julyCandidate.sourceOccurrenceId = "reading-csv-occ-7-21b-regression";
  julyCandidate.source.sourceKind = "csv";
  julyCandidate.source.sourceLabel = "7.21B";
  julyCandidate.source.occurrenceDate = "2026-07-21";
  julyCandidate.source.yearMonth = "2026-07";
  julyCandidate.source.sourceModule = "m1";
  julyCandidate.source.sourceOrder = 1;
  const july = groupReadingSourceOccurrences([julyCandidate]).packages[0];
  const database = historicalDatabase(historical);

  const [prepared] = await prepareReadingPackagesForImport(database, [july], {
    enableHistoricalSemanticFallback: true
  });
  assert.equal(prepared.reuseKind, "exact_fingerprint");
  assert.equal(prepared.existingItem.logicalItemId, legacy.item.logicalItemId);
  assert.equal(prepared.packageData.item.logicalItemId, legacy.item.logicalItemId);
  assert.equal(prepared.packageData.item.dedupFingerprint, legacy.item.dedupFingerprint);
  assert.equal(prepared.occurrenceConflict, null);
  assert.equal(prepared.addedOccurrenceCount, 1);
  assert.doesNotThrow(() => buildReadingImportRows(prepared.packageData));
  assert.match(prepared.packageData.questions[0].payload.paragraphs[0].rawText, /Europeans/);
  assert.doesNotMatch(prepared.packageData.questions[0].payload.paragraphs[0].rawText, /European powers/);

  const replayDatabase = historicalDatabase(historical);
  replayDatabase.from = occurrenceAwareFrom(replayDatabase.from, [{
    ...july.occurrences[0],
    logicalItemId: legacy.item.logicalItemId
  }]);
  const [replayed] = await prepareReadingPackagesForImport(replayDatabase, [july], {
    enableHistoricalSemanticFallback: true
  });
  assert.equal(replayed.addedOccurrenceCount, 0);
  assert.equal(replayed.occurrenceConflict, null);
  assert.deepEqual(replayed.possibleDuplicateLogicalItemIds, []);
  assert.equal(replayed.contentReconciliations.length, 0);
  assert.doesNotThrow(() => buildReadingImportRows(replayed.packageData));
});

test("CTW-only normalization canonicalizes Unicode dashes, whitespace, and blank noise", () => {
  for (const variant of ["—", "–", "‐", "‑", "‒", "−", "﹘", "﹣", "－"]) {
    assert.equal(normalizeCtwSemanticText(` function ${variant} utility `), "function-utility");
  }
  assert.equal(normalizeCtwSemanticText("care_____ _\n\t incised"), "care incised");
  assert.equal(normalizeCtwSemanticText("  multiple\n\t spaces  "), "multiple spaces");
});

test("CTW dash presentation variants reuse while the shared Reading normalizer remains unchanged", async () => {
  const historical = ctwPresentationBase();
  for (const dash of ["-", "–", "‐", "‑", "‒", "−", "﹘", "﹣", "－"]) {
    const incoming = incomingVariant(historical, (candidate) => {
      const question = candidate.questions[0];
      question.payload.paragraphs[0].segments.forEach((segment) => {
        if (segment.kind === "text") segment.text = segment.text.replaceAll("—", dash);
      });
      rebuildCtwRawText(question);
    });
    assert.equal(readingSemanticFingerprint(incoming), readingSemanticFingerprint(historical));
    const { prepared } = await historicalMatch(historical, incoming);
    assert.equal(prepared.reuseKind, "semantic");
    assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
  }
});

test("CTW multiple spaces, newlines, and tabs are presentation-only", async () => {
  const historical = ctwPresentationBase();
  const incoming = incomingVariant(historical, (candidate) => {
    const question = candidate.questions[0];
    const text = question.payload.paragraphs[0].segments.find((segment) =>
      segment.kind === "text" && segment.text.includes("function—utility")
    );
    text.text = text.text.replace("function—utility and beauty—marks", "function —\n utility   and\tbeauty — marks");
    rebuildCtwRawText(question);
  });
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
});

test("CTW underscore count and underscore spacing do not change semantic identity", async () => {
  const historical = ctwPresentationBase();
  for (const display of ["scien__", "scien______", "scien_ _ _ _ _"]) {
    const incoming = incomingVariant(historical, (candidate) => {
      const question = candidate.questions[0];
      question.payload.slots[0].displayText = display;
      rebuildCtwRawText(question);
    });
    const { prepared } = await historicalMatch(historical, incoming);
    assert.equal(prepared.reuseKind, "semantic");
    assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
  }
});

test("CTW standalone OCR underscores in adjacent text do not trigger review", async () => {
  const historical = ctwPresentationBase();
  const incoming = incomingVariant(historical, (candidate) => {
    const question = candidate.questions[0];
    const trailingText = question.payload.paragraphs[0].segments.find((segment) =>
      segment.kind === "text" && segment.text.includes("studies nature")
    );
    trailingText.text = ` _  ${trailingText.text}`;
    rebuildCtwRawText(question);
  });
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
});

test("Neolithic 10-answer regression reuses the known historical logical item", async () => {
  const historical = screenshotCtwPackage();
  const incoming = incomingVariant(historical, (candidate) => {
    const question = candidate.questions[0];
    question.payload.paragraphs[0].segments.forEach((segment) => {
      if (segment.kind !== "text") return;
      segment.text = segment.text
        .replaceAll("—", "-")
        .replace(" incised ", " _  incised\n")
        .replace(" designs. This", "   designs.\nThis");
    });
    question.payload.slots.forEach((slot, index) => {
      slot.displayText = `${slot.prefix}${index === 7 ? "_____ _" : "_".repeat(slot.missingLength + 2)}`;
    });
    rebuildCtwRawText(question);
  });
  assert.deepEqual(
    incoming.questions[0].payload.slots.map((slot) => slot.answer),
    ["for", "food", "water", "clay", "eventually", "decorative", "such", "carefully", "patterns", "painted"]
  );
  assert.equal(readingSemanticFingerprint(incoming), readingSemanticFingerprint(historical));
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, "reading-ctw-d7d655821c880844faa64ae6");
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
});

test("CTW answer differences reconcile within one identity while lexical content stays distinct", async () => {
  const historical = ctwPresentationBase();
  const answerVariant = incomingVariant(historical, (candidate) => {
    const slot = candidate.questions[0].payload.slots[0];
    slot.answer = "scientists";
    slot.missingText = "tists";
    slot.missingLength = 5;
    slot.displayText = "scien_____";
    rebuildCtwRawText(candidate.questions[0]);
  });
  assert.equal(readingSemanticFingerprint(answerVariant), readingSemanticFingerprint(historical));
  const answerMatch = await historicalMatch(historical, answerVariant);
  assert.equal(answerMatch.prepared.reuseKind, "semantic");
  assert.equal(answerMatch.prepared.contentReconciliations.length, 1);
  assert.deepEqual(answerMatch.prepared.possibleDuplicateLogicalItemIds, []);
  assert.equal(
    answerMatch.prepared.contentReconciliations[0].item.questionConflicts[0].ctwSlotConflicts[0].differenceKinds.includes("answer"),
    true
  );

  const lexicalVariant = incomingVariant(historical, (candidate) => {
    const question = candidate.questions[0];
    const text = question.payload.paragraphs[0].segments.find((segment) =>
      segment.kind === "text" && segment.text.includes("studies nature")
    );
    text.text += " An entirely new sentence was added.";
    rebuildCtwRawText(question);
  });
  assert.notEqual(readingSemanticFingerprint(lexicalVariant), readingSemanticFingerprint(historical));
  const lexicalMatch = await historicalMatch(historical, lexicalVariant);
  assert.notEqual(lexicalMatch.prepared.reuseKind, "semantic");
});

test("existing CTW occurrence suppresses an already handled answer conflict", async () => {
  const historical = ctwPresentationBase();
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.sourceOccurrenceId = historical.occurrences[0].occurrenceId;
    const slot = candidate.questions[0].payload.slots[0];
    slot.answer = `${slot.answer}s`;
    slot.missingText = `${slot.missingText}s`;
    slot.missingLength += 1;
    slot.displayText = `${slot.prefix}${"_".repeat(slot.missingLength)}`;
    rebuildCtwRawText(candidate.questions[0]);
  });
  const database = historicalDatabase(historical);
  database.from = occurrenceAwareFrom(database.from, historical.occurrences);
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableHistoricalSemanticFallback: true
  });

  assert.equal(prepared.existingItem.logicalItemId, historical.item.logicalItemId);
  assert.equal(prepared.addedOccurrenceCount, 0);
  assert.equal(prepared.occurrenceConflict, null);
  assert.equal(prepared.contentReconciliations.length, 0);
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
});

test("existing CTW occurrence bound to another logical item remains a source conflict", async () => {
  const historical = ctwPresentationBase();
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.sourceOccurrenceId = historical.occurrences[0].occurrenceId;
  });
  const database = historicalDatabase(historical);
  database.from = occurrenceAwareFrom(database.from, [{
    ...historical.occurrences[0],
    logicalItemId: "reading-ctw-wrong-owner"
  }]);
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableHistoricalSemanticFallback: true
  });

  assert.equal(prepared.addedOccurrenceCount, 0);
  assert.match(prepared.occurrenceConflict, /already belongs to logical item reading-ctw-wrong-owner/);
});

test("CTW slot-count changes remain distinct without fuzzy identity fallback", async () => {
  const historical = screenshotCtwPackage();
  const incoming = incomingVariant(historical, (candidate) => {
    const question = candidate.questions[0];
    const removed = question.payload.slots.pop();
    question.payload.paragraphs[0].segments = question.payload.paragraphs[0].segments.filter(
      (segment) => segment.kind !== "blank" || segment.slotId !== removed.slotId
    );
    question.sourceQuestionEnd = 9;
    candidate.source.sourceQuestionEnd = 9;
    rebuildCtwRawText(question);
  });
  assert.notEqual(readingSemanticFingerprint(incoming), readingSemanticFingerprint(historical));
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "new");
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
});

test("CTW masked identity reuses answer/prefix variants and separates framework changes", async () => {
  const historical = packageFrom("complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv");
  const variants = [
    (question) => { question.payload.slots[0].answer = "scientists"; },
    (question) => { question.payload.slots[0].prefix = "science"; },
    (question) => { question.payload.paragraphs[0].segments.reverse(); },
    (question) => { question.payload.paragraphs[0].segments[0].text = "Substantive change "; }
  ];
  for (const [index, mutate] of variants.entries()) {
    const incoming = incomingVariant(historical, (candidate) => mutate(candidate.questions[0]));
    if (index <= 1) assert.equal(readingSemanticFingerprint(historical), readingSemanticFingerprint(incoming));
    else assert.notEqual(readingSemanticFingerprint(historical), readingSemanticFingerprint(incoming));
    const { prepared } = await historicalMatch(historical, incoming);
    assert.equal(prepared.reuseKind, index <= 1 ? "semantic" : "new");
    assert.equal(prepared.contentReconciliations.length, index <= 1 ? 1 : 0);
  }
  const answerVariant = incomingVariant(historical, (candidate) => {
    candidate.questions[0].payload.slots[0].answer = "scientists";
  });
  assert.equal(
    readingPossibleDuplicateFingerprint(historical),
    readingPossibleDuplicateFingerprint(answerVariant)
  );
  const { prepared } = await historicalMatch(historical, answerVariant);
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
  assert.equal(prepared.contentReconciliations.length, 1);
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

test("RDL same material reuses canonical questions despite substantive source differences", async () => {
  const historical = packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.questions[0].stem = "A substantively different question?";
    const question = candidate.questions[0];
    question.payload.correctOptionId = question.payload.options.find(
      (option) => option.optionId !== question.payload.correctOptionId
    ).optionId;
  });
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.materialMatchKind, "exact_material");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.equal(prepared.packageData.questions[0].stem, historical.questions[0].stem);
  assert.equal(
    prepared.packageData.questions[0].payload.correctOptionId,
    historical.questions[0].payload.correctOptionId
  );
  assert.equal(prepared.contentReconciliations.length, 1);
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
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
  assert.throws(() => assertPreparedReadingPackageCanImport(prepared), /需确认/);
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

test("RAP internal IDs and source-question differences do not split one passage", async () => {
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
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.equal(prepared.packageData.questions[0].stem, historical.questions[0].stem);
  assert.equal(prepared.contentReconciliations.length, 1);
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
});

test("RAP identity ignores title when the actual passage is unchanged", async () => {
  const historical = packageFrom("read_an_academic_passage", "TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.title = "A Completely Different Display Title";
    candidate.passages[0].title = "A Completely Different Display Title";
  });
  assert.equal(areReadingPackagesHistoricalSemanticEquivalents(historical, incoming), true);
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
});

test("same RAP occurrence with changed source questions is an idempotent replay without review", async () => {
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
  assert.equal(prepared.occurrenceConflict, null);
  assert.equal(prepared.addedOccurrenceCount, 0);
  assert.equal(prepared.packageData.questions[0].stem, historical.questions[0].stem);
  assert.equal(prepared.contentReconciliations.length, 0);
  assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
});

test("same-material variants in one CSV coalesce without creating a database content review", async () => {
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
  const preparedDifference = await prepareReadingPackagesForImport(
    historicalDatabase(),
    [first, conflicting],
    { enableHistoricalSemanticFallback: true }
  );
  assert.equal(preparedDifference.length, 1);
  assert.equal(preparedDifference[0].reuseKind, "new");
  assert.equal(preparedDifference[0].packageData.questions[0].stem, first.questions[0].stem);
  assert.equal(preparedDifference[0].contentReconciliations.length, 0);
  assert.equal(preparedDifference[0].occurrenceConflict, null);
});

test("University Photography Club compares every batch occurrence only with the DB canonical", async () => {
  const historical = historicalPackage("rdl", "reading-rdl-93162d8f9d1db0491ad81016");
  const alternate = rdlSourceVariant(historical, "8.9A", "2026-08-09", (candidate) => {
    candidate.questions[1].payload.options[1].text = "A sale of used photography equipment";
  });
  const canonicalMatch = rdlSourceVariant(historical, "8.18B", "2026-08-18", () => {});
  const [prepared] = await prepareReadingPackagesForImport(
    historicalDatabase(historical),
    [alternate, canonicalMatch],
    { enableHistoricalSemanticFallback: true }
  );

  assert.equal(prepared.existingItem.logicalItemId, historical.item.logicalItemId);
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.deepEqual(
    prepared.packageData.occurrences.map((occurrence) => occurrence.sourceLabel),
    ["8.9A", "8.18B"]
  );
  assert.equal(prepared.contentReconciliations.length, 1);
  const reconciliation = prepared.contentReconciliations[0];
  assert.deepEqual(reconciliation.item.sources.map((source) => source.sourceLabel), ["8.9A"]);
  const optionDifference = reconciliation.item.questionConflicts[0].differences.find(
    (difference) => difference.kind === "options"
  );
  assert.equal(optionDifference.existing, "A sale of used photo equipment");
  assert.equal(optionDifference.incoming, "A sale of used photography equipment");
  assert.ok(!prepared.contentReconciliations.some((candidate) =>
    candidate.item.questionConflicts.some((question) => question.differences.some((difference) =>
      difference.existing === "A sale of used photography equipment"
      && difference.incoming === "A sale of used photo equipment"
    ))
  ));
});

test("identical RDL source variants aggregate their source labels against one DB canonical field", async () => {
  const historical = historicalPackage("rdl", "reading-rdl-93162d8f9d1db0491ad81016");
  const variants = [
    ["8.9A", "2026-08-09"],
    ["8.20B", "2026-08-20"]
  ].map(([label, date]) => rdlSourceVariant(historical, label, date, (candidate) => {
    candidate.questions[1].payload.options[1].text = "A sale of used photography equipment";
  }));
  const [prepared] = await prepareReadingPackagesForImport(
    historicalDatabase(historical),
    variants,
    { enableHistoricalSemanticFallback: true }
  );

  assert.equal(prepared.contentReconciliations.length, 1);
  assert.deepEqual(
    prepared.contentReconciliations[0].item.sources.map((source) => source.sourceLabel),
    ["8.9A", "8.20B"]
  );
});

function rdlSourceVariant(historical, sourceLabel, occurrenceDate, mutate) {
  const candidate = packageToSourceCandidate(historical);
  candidate.sourceOccurrenceId = `reading-source-${sourceLabel.toLowerCase().replaceAll(".", "-")}-m1-rdl-01`;
  candidate.source.sourceLabel = sourceLabel;
  candidate.source.occurrenceDate = occurrenceDate;
  candidate.source.yearMonth = occurrenceDate.slice(0, 7);
  candidate.source.sourceOrder = 1;
  mutate(candidate);
  return groupReadingSourceOccurrences([candidate]).packages[0];
}

const historicalRdlClusters = [
  ["Mini Fridge Repair Chat", [
    "reading-rdl-148c9722abd9aaa17f9726fd",
    "reading-rdl-8a2b06d3d54b3dbbc242334d",
    "reading-rdl-bf33fe2c2695a9b1bffcbb13"
  ]],
  ["Global Cultures Documentary", [
    "reading-rdl-4e019fb07512c8980a703524",
    "reading-rdl-618bf4056104c302387d73c6",
    "reading-rdl-6cd25d7e2010341609c5c804"
  ]],
  ["Dental Appointment", [
    "reading-rdl-6c6546f79c781b9849ca098d",
    "reading-rdl-d7cff4d1c3f5fbdc819182c0"
  ]],
  ["Concert Planning Chat", [
    "reading-rdl-75ae12fd735b71b1b761a4d6",
    "reading-rdl-79a7fed6dab3ea6be215f43a"
  ]],
  ["Sign Language Interpreter Needed", [
    "reading-rdl-84169206138631781d46b7f7",
    "reading-rdl-f2d78b3e065372b894c1b5cf"
  ]],
  ["University Photography Club", [
    "reading-rdl-93162d8f9d1db0491ad81016",
    "reading-rdl-ea4eba6be59eb0d54561689d"
  ]]
];

const historicalRapClusters = [
  ["Radio Astronomy", [
    "reading-rap-00d1af757b20b7f4f6440076",
    "reading-rap-5e0859fbc2e185e743d11c4b",
    "reading-rap-f1ccfc79e358e55f2ee63181"
  ]],
  ["Benefits of Music Education", [
    "reading-rap-08b62a981873c3e2eef76ff4",
    "reading-rap-6c60773bbb66e0a8dc6adcc0"
  ]],
  ["Data Visualization in Action", [
    "reading-rap-199501db577904fb79815267",
    "reading-rap-65673b292aab5d2297ddb13f",
    "reading-rap-c0a09dd368b968fd01c859ed"
  ]],
  ["Hidden Structures in Discrete Geometry", [
    "reading-rap-1f5a2a094976c7046412177a",
    "reading-rap-c2f68bcc6afcbbe710f5c87d",
    "reading-rap-f50dd6e4cd831e6155bb31ac"
  ]],
  ["Value Theory", [
    "reading-rap-2662811490d7e1cb8ef50753",
    "reading-rap-7066f8dd9b44a5d1e065719d",
    "reading-rap-80e0d016a21881694ab06335",
    "reading-rap-af2f63bf59d1743d597f47f4"
  ]],
  ["Theater Lighting Innovations", [
    "reading-rap-28b2cecf31bfee0a244d1a09",
    "reading-rap-5a8c27c074aa0513d04f572b"
  ]],
  ["Noise Control in Urban Areas", [
    "reading-rap-2b14b33aacc064d75314fa53",
    "reading-rap-7945215d82567f1f6f2af63a"
  ]],
  ["Quantum Computing duplicate subset", [
    "reading-rap-356930309b8c015008667f85",
    "reading-rap-bad55ea4a5cad4980668095d",
    "reading-rap-dbb5edec85e50734f930693e"
  ]],
  ["Veganism in the United States", [
    "reading-rap-3c7da315889dceed32412dcf",
    "reading-rap-f9e62e69f26b24ec00d4aa76"
  ]],
  ["The Power of Music", [
    "reading-rap-6522c75a66bfa0f293e67432",
    "reading-rap-e9f22c72c388b25c9ccc03d8"
  ]],
  ["Social Networks and Influence", [
    "reading-rap-668702bfa1634d0e0a73a4d1",
    "reading-rap-7447d5926c9979015af28e99",
    "reading-rap-8371c3948e75cac783023b5c",
    "reading-rap-8ef2e4aefe74c7b7cdc2b9e1"
  ]],
  ["Free Will and Determinism", [
    "reading-rap-872c6a298ccb4eea664f4812",
    "reading-rap-fdeb6000ce9ff3558cc559b5"
  ]],
  ["Urban Resilience", [
    "reading-rap-bd88c39e1718f0046a3df188",
    "reading-rap-e7ce2874e8c366c253f0bed0"
  ]],
  ["Carthage's Trade Network", [
    "reading-rap-43fe10b35ebdf733d430c751",
    "reading-rap-c3233ad427c0e207ebb6a110",
    "reading-rap-fcb877e86ce9cff28b0635f8"
  ]]
];

test("all 6 audited RDL historical clusters reuse a stable existing survivor", async (t) => {
  for (const [name, ids] of historicalRdlClusters) {
    await t.test(name, async () => {
      const historical = ids.map((id) => {
        const packageData = historicalPackage("rdl", id);
        packageData.item.title = name;
        packageData.materials[0].title = name;
        return packageData;
      });
      const incoming = incomingVariant(historical.at(-1), (candidate) => {
        candidate.questions[0].stem = `${candidate.questions[0].stem}.`;
      });
      assert.ok(historical.every((item) =>
        areReadingPackagesHistoricalSemanticEquivalents(incoming, item)
      ));
      const [prepared] = await prepareReadingPackagesForImport(
        historicalDatabase(...historical),
        [incoming],
        { enableHistoricalSemanticFallback: true }
      );
      const expectedSurvivor = [...historical].sort((left, right) =>
        left.item.firstSeenDate.localeCompare(right.item.firstSeenDate)
        || left.item.logicalItemId.localeCompare(right.item.logicalItemId)
      )[0];
      assert.equal(prepared.reuseKind, "semantic");
      assert.equal(prepared.existingItem.logicalItemId, expectedSurvivor.item.logicalItemId);
      assert.equal(prepared.packageData.item.logicalItemId, expectedSurvivor.item.logicalItemId);
      assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
      assert.equal(prepared.addedOccurrenceCount, 1);
    });
  }
});

test("all 14 audited RAP historical clusters reuse and never create a third logical item", async (t) => {
  for (const [name, ids] of historicalRapClusters) {
    await t.test(name, async () => {
      const historical = ids.map((id) => historicalPackage("rap", id));
      const incoming = incomingVariant(historical.at(-1), (candidate) => {
        candidate.questions[0].stem = `${candidate.questions[0].stem}.`;
      });
      assert.ok(historical.every((item) =>
        areReadingPackagesHistoricalSemanticEquivalents(incoming, item)
      ));
      const [prepared] = await prepareReadingPackagesForImport(
        historicalDatabase(...historical),
        [incoming],
        { enableHistoricalSemanticFallback: true }
      );
      const expectedSurvivor = [...historical].sort((left, right) =>
        left.item.firstSeenDate.localeCompare(right.item.firstSeenDate)
        || left.item.logicalItemId.localeCompare(right.item.logicalItemId)
      )[0];
      assert.equal(prepared.reuseKind, "semantic");
      assert.equal(prepared.existingItem.logicalItemId, expectedSurvivor.item.logicalItemId);
      assert.equal(prepared.packageData.item.logicalItemId, expectedSurvivor.item.logicalItemId);
      assert.deepEqual(prepared.possibleDuplicateLogicalItemIds, []);
      assert.equal(prepared.addedOccurrenceCount, 1);
    });
  }
});

test("Value Theory reuses across comma/period, trailing colon, quote, and utility OCR variants", async () => {
  const historical = historicalPackage("rap", "reading-rap-af2f63bf59d1743d597f47f4");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.passages[0].paragraphs[0].text = candidate.passages[0].paragraphs[0].text.replace(",", ".");
    candidate.questions[0].stem = `${candidate.questions[0].stem.replaceAll('"', "“")}:`;
    const utility = candidate.questions[1].payload.options.find((option) => /utility/i.test(option.text));
    assert.ok(utility);
    utility.text = utility.text.replace(/utility/i, "utillity");
  });
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
});

test("highlight-only and option-order compound variants reuse for three audited RAP clusters", async (t) => {
  for (const [name, id] of [
    ["Benefits of Music Education", "reading-rap-08b62a981873c3e2eef76ff4"],
    ["The Power of Music", "reading-rap-6522c75a66bfa0f293e67432"],
    ["Free Will and Determinism", "reading-rap-872c6a298ccb4eea664f4812"]
  ]) {
    await t.test(name, async () => {
      const base = historicalPackage("rap", id);
      const historical = contentVariant(base, (candidate) => {
        const question = candidate.questions.find((item) =>
          item.questionType === "rap_multiple_choice" && /[“"][^”"]+[”"]/.test(item.stem)
        );
        assert.ok(question);
        const target = question.stem.match(/[“"]([^”"]+)[”"]/)?.[1];
        assert.ok(target);
        const paragraph = candidate.passages[0].paragraphs.find((item) => item.text.includes(target));
        assert.ok(paragraph);
        const startOffset = paragraph.text.indexOf(target);
        question.payload.highlightRanges = [{
          paragraphId: paragraph.paragraphId,
          startOffset,
          endOffset: startOffset + target.length
        }];
      });
      const incoming = incomingVariant(base, (candidate) => {
        for (const question of candidate.questions) {
          if (question.questionType !== "rap_multiple_choice") continue;
          question.payload.options.reverse().forEach((option, index) => { option.optionOrder = index + 1; });
        }
      });
      const { prepared } = await historicalMatch(historical, incoming);
      assert.equal(prepared.reuseKind, "semantic");
      assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
    });
  }
});

test("Quantum answer-key variant shares passage identity while Social Networks title-only match stays distinct", () => {
  const quantumAnswerVariant = historicalPackage("rap", "reading-rap-356930309b8c015008667f85");
  const quantumDuplicate = historicalPackage("rap", "reading-rap-bad55ea4a5cad4980668095d");
  assert.equal(
    areReadingPackagesHistoricalSemanticEquivalents(quantumAnswerVariant, quantumDuplicate),
    true
  );

  const socialDifferent = historicalPackage("rap", "reading-rap-5817366a9ff4cc9c334fb39a");
  const socialDuplicate = historicalPackage("rap", "reading-rap-668702bfa1634d0e0a73a4d1");
  assert.equal(
    areReadingPackagesHistoricalSemanticEquivalents(socialDifferent, socialDuplicate),
    false
  );
});

test("Quantum Computing 5.3B, 6.2, and 6.6A reuse one logical without overwriting its answer", async () => {
  const historical = [
    "reading-rap-bad55ea4a5cad4980668095d",
    "reading-rap-356930309b8c015008667f85",
    "reading-rap-dbb5edec85e50734f930693e"
  ].map((id) => historicalPackage("rap", id));
  const source62 = historical.find((item) => item.item.logicalItemId === "reading-rap-356930309b8c015008667f85");
  const incoming = incomingVariant(source62, () => {});
  const [prepared] = await prepareReadingPackagesForImport(
    historicalDatabase(...historical),
    [incoming],
    { enableHistoricalSemanticFallback: true }
  );
  const survivor = historical.find((item) => item.item.firstSeenSourceLabel === "5.3B");
  const canonicalInsertion = survivor.questions.find((item) => item.questionType === "rap_sentence_insertion");
  const incomingInsertion = source62.questions.find((item) => item.questionType === "rap_sentence_insertion");
  const canonicalCorrect = canonicalInsertion.payload.anchors.find(
    (anchor) => anchor.anchorId === canonicalInsertion.payload.correctAnchorId
  );
  const incomingCorrect = incomingInsertion.payload.anchors.find(
    (anchor) => anchor.anchorId === incomingInsertion.payload.correctAnchorId
  );

  assert.equal(incomingCorrect.boundaryIndex, 4);
  assert.equal(canonicalCorrect.boundaryIndex, 3);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.existingItem.logicalItemId, survivor.item.logicalItemId);
  assert.equal(prepared.packageData.item.logicalItemId, survivor.item.logicalItemId);
  const retainedInsertion = prepared.packageData.questions.find(
    (item) => item.questionType === "rap_sentence_insertion"
  );
  const retainedCorrect = retainedInsertion.payload.anchors.find(
    (anchor) => anchor.anchorId === retainedInsertion.payload.correctAnchorId
  );
  assert.equal(retainedCorrect.boundaryIndex, 3);
  assert.equal(prepared.contentReconciliations.length, 1);
  assert.equal(prepared.addedOccurrenceCount, 1);
});

test("same passage with an unmappable question count is a blocker, not a new logical item", async () => {
  const historical = historicalPackage("rap", "reading-rap-bad55ea4a5cad4980668095d");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.questions.pop();
  });
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.existingItem.logicalItemId, historical.item.logicalItemId);
  assert.match(prepared.occurrenceConflict, /题目内容存在异常，需要核对.*question count/);
  assert.throws(() => assertPreparedReadingPackageCanImport(prepared), /题目内容存在异常，需要核对/);
});

test("substantively different RAP passage stays distinct even when its title is unchanged", async () => {
  const historical = historicalPackage("rap", "reading-rap-6522c75a66bfa0f293e67432");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.passages[0].paragraphs[0].text =
      "This is a substantively different academic passage about volcanic geology and tectonic plates.";
  });
  assert.equal(areReadingPackagesHistoricalSemanticEquivalents(historical, incoming), false);
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "new");
  assert.equal(prepared.existingItem, null);
});

test("same RAP passage remains one identity despite answer and semantic-position discrepancies", () => {
  const multipleChoice = historicalPackage("rap", "reading-rap-6522c75a66bfa0f293e67432");
  const differentAnswer = contentVariant(multipleChoice, (candidate) => {
    const question = candidate.questions.find((item) => item.questionType === "rap_multiple_choice");
    const alternative = question.payload.options.find((option) => option.optionId !== question.payload.correctOptionId);
    question.payload.correctOptionId = alternative.optionId;
  });
  assert.equal(areReadingPackagesHistoricalSemanticEquivalents(multipleChoice, differentAnswer), true);

  const selection = historicalPackage("rap", "reading-rap-199501db577904fb79815267");
  const differentSelection = contentVariant(selection, (candidate) => {
    const question = candidate.questions.find((item) => item.questionType === "rap_sentence_selection");
    const paragraph = candidate.passages[0].paragraphs.find(
      (item) => item.paragraphId === question.payload.targetParagraphId
    );
    const alternative = paragraph.sentences.find(
      (sentence) => sentence.sentenceId !== question.payload.correctSentenceId
    );
    question.payload.correctSentenceId = alternative.sentenceId;
  });
  assert.equal(areReadingPackagesHistoricalSemanticEquivalents(selection, differentSelection), true);
});

test("same RDL material is reused instead of becoming a possible duplicate", async () => {
  const historical = packageFrom("read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  const incoming = incomingVariant(historical, (candidate) => {
    candidate.questions[0].stem = "A substantively different question?";
  });
  const { prepared } = await historicalMatch(historical, incoming);
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.doesNotThrow(() => assertPreparedReadingPackageCanImport(prepared));
});

test("multiple same-passage candidates choose the stable survivor despite question differences", async () => {
  const base = historicalPackage("rap", "reading-rap-af2f63bf59d1743d597f47f4");
  const candidateA = contentVariant(base, (candidate) => {
    const option = candidate.questions[1].payload.options.find((item) => /utility/i.test(item.text));
    option.text = option.text.replace(/utility/i, "xxility");
  });
  const candidateB = contentVariant(base, (candidate) => {
    const option = candidate.questions[1].payload.options.find((item) => /utility/i.test(item.text));
    option.text = option.text.replace(/utility/i, "utilitz");
  });
  const incoming = incomingVariant(base, (candidate) => {
    candidate.questions[0].stem = `${candidate.questions[0].stem}.`;
  });
  assert.equal(areReadingPackagesHistoricalSemanticEquivalents(incoming, candidateA), true);
  assert.equal(areReadingPackagesHistoricalSemanticEquivalents(incoming, candidateB), true);
  assert.equal(areReadingPackagesHistoricalSemanticEquivalents(candidateA, candidateB), true);

  const [prepared] = await prepareReadingPackagesForImport(
    historicalDatabase(candidateA, candidateB),
    [incoming],
    { enableHistoricalSemanticFallback: true }
  );
  const expected = [candidateA, candidateB].sort((left, right) =>
    left.item.firstSeenDate.localeCompare(right.item.firstSeenDate)
    || left.item.logicalItemId.localeCompare(right.item.logicalItemId)
  )[0];
  assert.equal(prepared.reuseKind, "semantic");
  assert.equal(prepared.existingItem.logicalItemId, expected.item.logicalItemId);
  assert.equal(prepared.packageData.item.logicalItemId, expected.item.logicalItemId);
  assert.equal(prepared.historicalDuplicateLogicalItemIds.length, 1);
  assert.equal(prepared.contentReconciliations.length, 1);
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
