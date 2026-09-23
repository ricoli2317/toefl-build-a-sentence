const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv, readingCsvOccurrenceId } = require("../lib/reading/csvAdapter.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  assertPreparedReadingPackageCanImport,
  buildReadingImportRows,
  executePreparedReadingPackageAtomic,
  importReadingPackageAtomic,
  prepareReadingPackageAtomicImport,
  prepareReadingPackagesForImport
} = require("../lib/reading/importer.ts");
const {
  COMPLETE_THE_WORDS_HEADERS,
  LEGACY_READ_AN_ACADEMIC_PASSAGE_HEADERS,
  READ_AN_ACADEMIC_PASSAGE_HEADERS,
  READ_IN_DAILY_LIFE_HEADERS
} = require("../lib/reading/csvSchemas.ts");
const { detectQuestionType } = require("../lib/questionCsvSchemas.ts");

const templateDir = path.join(__dirname, "../data/reading/csv-templates");
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

function template(file) {
  return parseCsvDocument(fs.readFileSync(path.join(templateDir, file), "utf8"), {
    trimValues: false
  });
}

function adapt(type, document, materials = new Map([[material.materialId, material]])) {
  return adaptReadingCsv({ type, rows: document.rows, sourceFile: "fixture.csv", materials });
}

test("teacher CSV detection recognizes the three fixed Reading headers", () => {
  assert.equal(detectQuestionType(COMPLETE_THE_WORDS_HEADERS), "complete_the_words");
  assert.equal(detectQuestionType(READ_IN_DAILY_LIFE_HEADERS), "read_in_daily_life");
  assert.equal(detectQuestionType(READ_AN_ACADEMIC_PASSAGE_HEADERS), "read_an_academic_passage");
  assert.equal(detectQuestionType(LEGACY_READ_AN_ACADEMIC_PASSAGE_HEADERS), "read_an_academic_passage");
  assert.equal(
    detectQuestionType(template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv").headers),
    "read_an_academic_passage"
  );
  assert.equal(
    detectQuestionType(template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv").headers),
    "read_in_daily_life"
  );
  assert.equal(detectQuestionType([...READ_IN_DAILY_LIFE_HEADERS, "r2_url"]), "unknown");
});

test("CTW template reconstructs multiple paragraphs and slots as one item", () => {
  const result = adapt("complete_the_words", template("TOEFL_Complete_the_Words_TEMPLATE.csv"));
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, "Scientists Study Natural Patterns");
  assert.equal(result.candidates[0].questions[0].payload.paragraphs.length, 2);
  assert.equal(result.candidates[0].questions[0].payload.slots.length, 2);
});

test("CTW create_new requires a valid title with at most five words", () => {
  const valid = groupReadingSourceOccurrences(
    adapt("complete_the_words", template("TOEFL_Complete_the_Words_TEMPLATE.csv")).candidates
  ).packages[0];
  assert.doesNotThrow(() => prepareReadingPackageAtomicImport(valid, {
    expectedLogicalItemAction: "create_new"
  }));

  const missingDocument = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  missingDocument.rows[0].title = "";
  const missing = groupReadingSourceOccurrences(adapt("complete_the_words", missingDocument).candidates).packages[0];
  assert.throws(
    () => prepareReadingPackageAtomicImport(missing, { expectedLogicalItemAction: "create_new" }),
    /new CTW title must not be empty/
  );

  const longDocument = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  longDocument.rows[0].title = "One Two Three Four Five Six";
  const overlong = groupReadingSourceOccurrences(adapt("complete_the_words", longDocument).candidates).packages[0];
  assert.throws(
    () => prepareReadingPackageAtomicImport(overlong, { expectedLogicalItemAction: "create_new" }),
    /at most 5 whitespace-separated words/
  );
});

test("CTW title does not affect fingerprint, duplicate candidates, or logical item ID", () => {
  const firstDocument = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  const secondDocument = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  secondDocument.rows[0].title = "Different Reviewed Topic";
  const firstCandidate = adapt("complete_the_words", firstDocument).candidates[0];
  const secondCandidate = adapt("complete_the_words", secondDocument).candidates[0];
  const first = groupReadingSourceOccurrences([firstCandidate]);
  const second = groupReadingSourceOccurrences([secondCandidate]);
  const together = groupReadingSourceOccurrences([firstCandidate, secondCandidate]);
  assert.equal(first.packages[0].item.dedupFingerprint, second.packages[0].item.dedupFingerprint);
  assert.equal(first.packages[0].item.logicalItemId, second.packages[0].item.logicalItemId);
  assert.deepEqual(first.report.possibleDuplicates, second.report.possibleDuplicates);
  assert.equal(together.packages.length, 1);
  assert.deepEqual(together.report.possibleDuplicates, []);
});

test("CTW invalid slot reference rejects the complete occurrence", () => {
  const document = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  const passage = JSON.parse(document.rows[0].passage_json);
  passage[0].segments[1].slotId = "missing-slot";
  document.rows[0].passage_json = JSON.stringify(passage);
  const result = adapt("complete_the_words", document);
  assert.equal(result.candidates.length, 0);
  assert.match(result.failures[0].reason, /missing source reference|unknown slotId/);
});

test("RDL requires a known bound material with frozen object keys", () => {
  const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  assert.equal(adapt("read_in_daily_life", document).candidates.length, 1);
  assert.match(adapt("read_in_daily_life", document, new Map()).failures[0].reason, /does not exist/);
  const pending = { ...material, bindingStatus: "pending", imageAssetPath: null, hitboxDataPath: null };
  assert.match(
    adapt("read_in_daily_life", document, new Map([[pending.materialId, pending]])).failures[0].reason,
    /not production-ready/
  );
  const urlMaterial = { ...material, imageAssetPath: "https://assets.example.com/material.png" };
  assert.match(
    adapt("read_in_daily_life", document, new Map([[urlMaterial.materialId, urlMaterial]])).failures[0].reason,
    /object key|object-key/
  );
});

test("Admin RDL preflight accepts a registered versioned canonical asset pair", () => {
  const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  const versioned = {
    ...material,
    imageAssetPath: "reading/rdl/RDL-001/release-2026-08/material_final.png",
    hitboxDataPath: "reading/rdl/RDL-001/release-2026-08/selection_map.json"
  };
  const result = adaptReadingCsv({
    type: "read_in_daily_life",
    rows: document.rows,
    sourceFile: "fixture.csv",
    materials: new Map([[versioned.materialId, versioned]]),
    allowRegisteredMaterialStorageKeys: true
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].materials[0].imageAssetPath, versioned.imageAssetPath);
});

test("RDL CSV requires material_type but defers a registered-type mismatch to review", () => {
  const missing = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  missing.rows.forEach((row) => { row.material_type = ""; });
  assert.match(adapt("read_in_daily_life", missing).failures[0].reason, /Missing material_type/);

  const mismatch = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  mismatch.rows.forEach((row) => { row.material_type = "announcement"; });
  const result = adapt("read_in_daily_life", mismatch);
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].materials[0].materialType, "announcement");
});

test("RDL preflight accepts the new canonical meeting-minutes and invitation material types", () => {
  for (const [materialId, materialType, title] of [
    ["RDL-145", "meeting_minutes", "Student Council Meeting"],
    ["RDL-155", "invitation", "Foraging Expedition"]
  ]) {
    const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
    document.rows.forEach((row) => {
      row.material_id = materialId;
      row.material_type = materialType;
      row.title = title;
    });
    const registered = {
      ...material,
      materialId,
      materialType,
      title,
      imageAssetPath: `reading/rdl/${materialId}/material_final.png`,
      hitboxDataPath: `reading/rdl/${materialId}/selection_map.json`
    };

    const result = adapt(
      "read_in_daily_life",
      document,
      new Map([[registered.materialId, registered]])
    );
    assert.deepEqual(result.failures, []);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].materials[0].materialType, materialType);
  }
});

test("RDL CSV replaces an overlong incoming display title with the saved canonical title", () => {
  const longTitle = "Extended Library Hours for Final Exams";
  const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  document.rows.forEach((row) => { row.title = longTitle; });
  const result = adapt("read_in_daily_life", document);
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates[0].title, material.title);
});

test("RDL CSV canonicalizes capitalization and harmless whitespace without changing material identity", () => {
  for (const title of [
    "university robotics club workshop",
    "UNIVERSITY ROBOTICS CLUB WORKSHOP",
    "  University   Robotics Club Workshop  ",
    "University Robotics Club Workshop"
  ]) {
    const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
    document.rows.forEach((row) => { row.title = title; });
    const result = adapt("read_in_daily_life", document);
    assert.deepEqual(result.failures, []);
    assert.equal(result.candidates[0].title, material.title);
    assert.equal(result.candidates[0].materials[0].materialId, material.materialId);
  }
});

test("RDL-087 Study Abroad title capitalization is a nonblocking display normalization", () => {
  const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  document.rows.forEach((row) => {
    row.material_id = "RDL-087";
    row.title = "Study abroad in Valencia";
  });
  const registered = {
    ...material,
    materialId: "RDL-087",
    title: "Study Abroad in Valencia",
    imageAssetPath: "reading/rdl/RDL-087/material_final.png",
    hitboxDataPath: "reading/rdl/RDL-087/selection_map.json"
  };
  const result = adapt("read_in_daily_life", document, new Map([[registered.materialId, registered]]));
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates[0].title, "Study Abroad In Valencia");
  assert.equal(result.candidates[0].materials[0].materialId, "RDL-087");
});

test("same RDL material with a different question group remains a possible duplicate", () => {
  const first = adapt("read_in_daily_life", template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv")).candidates[0];
  const second = structuredClone(first);
  second.sourceOccurrenceId = "different-occurrence";
  second.source.sourceLabel = "EXAMPLE-20260812";
  second.source.occurrenceDate = "2026-08-12";
  second.source.yearMonth = "2026-08";
  second.questions[0].stem = "A meaningfully different question?";
  const grouped = groupReadingSourceOccurrences([first, second]);
  assert.equal(grouped.packages.length, 2);
  assert.equal(grouped.report.possibleDuplicates.length, 1);
});

test("RAP groups all supported question shapes and rejects conflicting passage rows", () => {
  const document = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const valid = adapt("read_an_academic_passage", document);
  assert.equal(valid.candidates.length, 1);
  assert.deepEqual(valid.candidates[0].questions.map((question) => question.questionType), [
    "rap_multiple_choice",
    "rap_sentence_insertion",
    "rap_sentence_selection"
  ]);
  const conflict = structuredClone(document);
  const changed = JSON.parse(conflict.rows[1].passage_json);
  changed[0].sentences[0].text = "Conflicting text.";
  conflict.rows[1].passage_json = JSON.stringify(changed);
  const invalid = adapt("read_an_academic_passage", conflict);
  assert.equal(invalid.candidates.length, 0);
  assert.match(invalid.failures[0].reason, /passage_json conflicts/);
});

test("legacy RAP CSV without passage_highlights_json remains compatible and defaults to empty ranges", () => {
  const document = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  document.headers = document.headers.filter((header) => header !== "passage_highlights_json");
  document.rows.forEach((row) => { delete row.passage_highlights_json; });
  const result = adapt("read_an_academic_passage", document);
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates.length, 1);
  assert.ok(result.candidates[0].questions.every((question) =>
    question.payload.highlightRanges.length === 0
    && question.payload.highlightRangesAuthoritative === false
  ));
});

test("RAP parses distinct per-question and multiple authoritative highlight ranges", () => {
  const document = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const passage = JSON.parse(document.rows[0].passage_json);
  const paragraph = passage[0];
  const ranges = [
    { paragraphId: paragraph.paragraphId, startOffset: 0, endOffset: 5, text: paragraph.text.slice(0, 5) },
    { paragraphId: paragraph.paragraphId, startOffset: 6, endOffset: 11, text: paragraph.text.slice(6, 11) }
  ];
  const other = [{
    paragraphId: paragraph.paragraphId,
    startOffset: 12,
    endOffset: 16,
    text: paragraph.text.slice(12, 16)
  }];
  document.rows[0].passage_highlights_json = JSON.stringify(ranges);
  document.rows[1].passage_highlights_json = JSON.stringify(other);
  document.rows[2].passage_highlights_json = "[]";

  const result = adapt("read_an_academic_passage", document);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.candidates[0].questions[0].payload.highlightRanges, ranges.map(({ text, ...range }) => range));
  assert.deepEqual(result.candidates[0].questions[1].payload.highlightRanges, other.map(({ text, ...range }) => range));
  assert.deepEqual(result.candidates[0].questions[2].payload.highlightRanges, []);
  assert.ok(result.candidates[0].questions.every((question) =>
    question.payload.highlightRangesAuthoritative === true
  ));

  const withoutHighlights = structuredClone(document);
  withoutHighlights.headers = withoutHighlights.headers.filter((header) => header !== "passage_highlights_json");
  withoutHighlights.rows.forEach((row) => { delete row.passage_highlights_json; });
  const withPackage = groupReadingSourceOccurrences(result.candidates).packages[0];
  const withoutPackage = groupReadingSourceOccurrences(
    adapt("read_an_academic_passage", withoutHighlights).candidates
  ).packages[0];
  assert.equal(withPackage.item.logicalItemId, withoutPackage.item.logicalItemId);
  assert.equal(withPackage.item.dedupFingerprint, withoutPackage.item.dedupFingerprint);
});

test("7.22A M2 Q11, Q13, Q14, and Q15 retain separate source highlights", () => {
  const document = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const expected = new Map([
    [11, "foster"],
    [13, "When children collaborate in theater, music ensembles, or group visual arts projects, they build a sense of belonging and shared purpose—key components of motivation and engagement, factors known to influence academic achievement."],
    [14, "studies"],
    [15, "mixed findings"]
  ]);
  const paragraphTexts = [
    "Arts programs foster curiosity and sustained attention.",
    `Researchers observed that ${expected.get(13)} Later work considered assessment quality.`,
    "Several studies compared program designs and reported mixed findings across schools."
  ];
  const paragraphs = paragraphTexts.map((text, index) => ({
    paragraphId: `p${index + 1}`,
    paragraphOrder: index + 1,
    text,
    rawText: text,
    sentences: [{ sentenceId: `p${index + 1}s1`, sentenceOrder: 1, text }]
  }));
  const targets = [
    { sourceNumber: 11, questionOrder: 1, paragraph: paragraphs[0], text: expected.get(11) },
    { sourceNumber: 12, questionOrder: 2, paragraph: paragraphs[0], text: null },
    { sourceNumber: 13, questionOrder: 3, paragraph: paragraphs[1], text: expected.get(13) },
    { sourceNumber: 14, questionOrder: 4, paragraph: paragraphs[2], text: expected.get(14) },
    { sourceNumber: 15, questionOrder: 5, paragraph: paragraphs[2], text: expected.get(15) }
  ];
  document.rows = targets.map((target) => {
    const row = structuredClone(document.rows[0]);
    const startOffset = target.text === null ? 0 : Array.from(target.paragraph.text.slice(
      0,
      target.paragraph.text.indexOf(target.text)
    )).length;
    return {
      ...row,
      source_label: "7.22A",
      occurrence_date: "2026-07-22",
      year_month: "2026-07",
      source_module: "m2",
      source_order: "1",
      source_group_id: "reading-2026-07-22-a-m2-rap-p01",
      source_question_number: String(target.sourceNumber),
      question_order: String(target.questionOrder),
      question_stem: `Question ${target.sourceNumber}`,
      passage_id: "reading-2026-07-22-a-m2-rap-p01",
      passage_title: "The Arts and Academic Achievement",
      passage_json: JSON.stringify(paragraphs),
      passage_highlights_json: JSON.stringify(target.text === null ? [] : [{
        paragraphId: target.paragraph.paragraphId,
        startOffset,
        endOffset: startOffset + Array.from(target.text).length,
        text: target.text
      }])
    };
  });

  const result = adapt("read_an_academic_passage", document);
  assert.deepEqual(result.failures, []);
  const candidate = result.candidates[0];
  assert.equal(candidate.questions.length, 5);
  const paragraphById = new Map(candidate.passages[0].paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph]));
  for (const question of candidate.questions) {
    const sourceNumber = question.sourceQuestionStart;
    if (!expected.has(sourceNumber)) {
      assert.deepEqual(question.payload.highlightRanges, []);
      continue;
    }
    const [range] = question.payload.highlightRanges;
    const paragraph = paragraphById.get(range.paragraphId);
    assert.equal(
      Array.from(paragraph.text).slice(range.startOffset, range.endOffset).join(""),
      expected.get(sourceNumber)
    );
  }
  assert.equal(new Set(candidate.questions.filter((question) => question.payload.highlightRanges.length > 0).map((question) =>
    JSON.stringify(question.payload.highlightRanges)
  )).size, 4);
});

test("RAP keeps its complete original passage title even when it exceeds five words", () => {
  const document = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const longTitle = "A Complete Academic Passage Title With Seven Words";
  document.rows.forEach((row) => { row.passage_title = longTitle; });
  const result = adapt("read_an_academic_passage", document);
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates[0].title, longTitle);
  assert.equal(result.candidates[0].passages[0].title, longTitle);
});

test("RAP invalid insertion answer and cross-paragraph sentence selection reject the group", () => {
  const insertion = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  insertion.rows[1].correct_anchor_id = "missing-anchor";
  assert.match(adapt("read_an_academic_passage", insertion).failures[0].reason, /invalid insertion answer|correctAnchorId/);

  const selection = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  selection.rows[2].correct_sentence_id = "missing-sentence";
  assert.match(
    adapt("read_an_academic_passage", selection).failures[0].reason,
    /missing source reference|correctSentenceId/
  );
});

test("stable source identity is filename-independent and duplicate upload is deterministic", () => {
  const identity = {
    type: "complete_the_words",
    sourceLabel: "7.5A",
    sourceModule: "m1",
    sourceOrder: 2,
    sourceGroupId: "g-2"
  };
  assert.equal(readingCsvOccurrenceId(identity), readingCsvOccurrenceId(identity));
  const document = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  const a = adaptReadingCsv({ type: identity.type, rows: document.rows, sourceFile: "a.csv" });
  const b = adaptReadingCsv({ type: identity.type, rows: document.rows, sourceFile: "renamed.csv" });
  assert.equal(a.candidates[0].sourceOccurrenceId, b.candidates[0].sourceOccurrenceId);
  assert.equal(
    groupReadingSourceOccurrences(a.candidates).packages[0].item.logicalItemId,
    groupReadingSourceOccurrences(b.candidates).packages[0].item.logicalItemId
  );
});

test("later and earlier exact occurrences stay one logical item and move first_seen backward", () => {
  const base = adapt("complete_the_words", template("TOEFL_Complete_the_Words_TEMPLATE.csv")).candidates[0];
  const july = structuredClone(base);
  july.sourceOccurrenceId = "july";
  july.source.sourceLabel = "7.5A";
  july.source.occurrenceDate = "2026-07-05";
  july.source.yearMonth = "2026-07";
  const august = structuredClone(base);
  august.sourceOccurrenceId = "august";
  august.source.sourceLabel = "8.12A";
  august.source.occurrenceDate = "2026-08-12";
  august.source.yearMonth = "2026-08";
  const june = structuredClone(base);
  june.sourceOccurrenceId = "june";
  june.source.sourceLabel = "6.20A";
  june.source.occurrenceDate = "2026-06-20";
  june.source.yearMonth = "2026-06";
  const grouped = groupReadingSourceOccurrences([july, august, june]);
  assert.equal(grouped.packages.length, 1);
  assert.equal(grouped.packages[0].occurrences.length, 3);
  assert.equal(grouped.packages[0].item.firstSeenDate, "2026-06-20");
  assert.equal("displayNumber" in grouped.packages[0].item, false);
});

test("atomic importer sends one complete package to one RPC", async () => {
  const packageData = groupReadingSourceOccurrences(
    adapt("complete_the_words", template("TOEFL_Complete_the_Words_TEMPLATE.csv")).candidates
  ).packages[0];
  let calls = 0;
  const supabase = {
    rpc: async (name, args) => {
      calls += 1;
      assert.equal(name, "import_reading_package_atomic");
      assert.equal(args.p_rows.reading_logical_items.length, 1);
      assert.equal(args.p_rows.reading_logical_items[0].title, "Scientists Study Natural Patterns");
      assert.equal(args.p_rows.reading_ctw_slots.length, 2);
      assert.equal(args.p_rows.expected_logical_item_action, "create_new");
      return {
        data: {
          logical_item_action: "create_new",
          inserted_occurrence_count: 1,
          existing_occurrence_count: 0,
          inserted_question_count: 1,
          updated_question_count: 0
        },
        error: null
      };
    }
  };
  const result = await importReadingPackageAtomic(supabase, packageData, {
    createdBy: "teacher",
    expectedLogicalItemAction: "create_new"
  });
  assert.equal(calls, 1);
  assert.equal(result.logicalItemAction, "create_new");
  assert.equal(result.insertedOccurrenceCount, 1);
});

test("commit executes the exact validated atomic payload without rebuilding it", async () => {
  const packageData = groupReadingSourceOccurrences(
    adapt("read_an_academic_passage", template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv")).candidates
  ).packages[0];
  const prepared = prepareReadingPackageAtomicImport(packageData, {
    createdBy: "teacher",
    expectedLogicalItemAction: "create_new"
  });
  let submittedRows;
  await executePreparedReadingPackageAtomic({
    async rpc(_name, args) {
      submittedRows = args.p_rows;
      return {
        data: {
          logical_item_action: "create_new",
          inserted_occurrence_count: 1,
          existing_occurrence_count: 0,
          inserted_question_count: packageData.questions.length,
          updated_question_count: 0
        },
        error: null
      };
    }
  }, prepared);
  assert.strictEqual(submittedRows, prepared.rows);
  assert.deepEqual(submittedRows.reading_logical_items, buildReadingImportRows(packageData).reading_logical_items.map(
    (row) => ({ ...row, created_by: "teacher" })
  ));
});

test("atomic database failures retain nested PostgreSQL diagnostics", async () => {
  const packageData = groupReadingSourceOccurrences(
    adapt("read_an_academic_passage", template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv")).candidates
  ).packages[0];
  let calls = 0;
  await assert.rejects(
    () => importReadingPackageAtomic({
      async rpc() {
        calls += 1;
        return {
          data: null,
          error: {
            code: "23503",
            message: "insert or update violates foreign key constraint",
            details: "Key (question_id) is not present",
            hint: "Check question identity"
          }
        };
      }
    }, packageData),
    (error) => error.cause.code === "23503"
      && error.cause.details === "Key (question_id) is not present"
      && error.cause.hint === "Check question identity"
  );
  assert.equal(calls, 1);
});

test("legacy CTW logical ID with the same fingerprint reuses all canonical identities", async () => {
  const incoming = ctwPackageAt({ label: "260305B", date: "2026-03-05", groupId: "ctw-260305b-m1" });
  const legacyId = "legacy-ctw-123";
  const database = readingImportDatabase({
    logicalItems: [logicalRow(incoming, legacyId, "2026-01-21", "260121A")],
    questions: [{ logical_item_id: legacyId, question_id: "legacy-q-1", question_order: 1, question_type: "ctw" }],
    paragraphs: incoming.questions[0].payload.paragraphs.map((paragraph) => ({
      question_id: "legacy-q-1",
      paragraph_id: `legacy-p-${paragraph.paragraphOrder}`,
      paragraph_order: paragraph.paragraphOrder
    })),
    slots: incoming.questions[0].payload.slots.map((slot) => ({
      question_id: "legacy-q-1",
      slot_id: `legacy-slot-${slot.slotOrder}`,
      slot_order: slot.slotOrder,
      paragraph_id: `legacy-p-${incoming.questions[0].payload.paragraphs.find(
        (paragraph) => paragraph.paragraphId === slot.paragraphId
      ).paragraphOrder}`
    }))
  });

  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableCtwFingerprintFallback: true
  });
  assert.equal(prepared.existingItem.logicalItemId, legacyId);
  assert.deepEqual(
    database.queryCalls.slice(0, 3).map(({ table, operation, column }) => [table, operation, column]),
    [
      ["reading_source_occurrences", "in", "occurrence_id"],
      ["reading_logical_items", "in", "logical_item_id"],
      ["reading_logical_items", "in", "dedup_fingerprint"]
    ]
  );
  assert.equal(prepared.packageData.item.logicalItemId, legacyId);
  assert.equal(prepared.packageData.questions[0].questionId, "legacy-q-1");
  assert.deepEqual(
    prepared.packageData.questions[0].payload.paragraphs.map((paragraph) => paragraph.paragraphId),
    ["legacy-p-1", "legacy-p-2"]
  );
  assert.deepEqual(
    prepared.packageData.questions[0].payload.slots.map((slot) => slot.slotId),
    ["legacy-slot-1", "legacy-slot-2"]
  );
  assert.equal(prepared.addedOccurrenceCount, 1);
  assert.equal(prepared.occurrenceConflict, null);
  assert.deepEqual(preparedMetrics(prepared), {
    logicalNewItemCount: 0,
    logicalAutoMergeCount: 1,
    occurrenceInsertedCount: 1
  });

  const result = await importReadingPackageAtomic(database, prepared.packageData);
  assert.equal(result.logicalItemId, legacyId);
  assert.equal(result.insertedQuestionCount, 0);
  assert.equal(database.rpcCalls.length, 1);
  assert.equal(database.rpcCalls[0].p_rows.reading_logical_items[0].logical_item_id, legacyId);
  assert.equal(database.rpcCalls[0].p_rows.reading_source_occurrences[0].logical_item_id, legacyId);
  assert.equal(database.rpcCalls[0].p_rows.reading_question_occurrences[0].question_id, "legacy-q-1");
});

test("standard existing CTW logical item accepts a new occurrence without creating a logical item", async () => {
  const incoming = ctwPackageAt({ label: "260305B", date: "2026-03-05", groupId: "ctw-260305b-m1" });
  incoming.item.title = "Incoming Replacement Title";
  const database = readingImportDatabase({
    logicalItems: [logicalRow(incoming, incoming.item.logicalItemId, "2026-01-21", "260121A", "Existing Canonical Title")],
    questions: [{
      logical_item_id: incoming.item.logicalItemId,
      question_id: incoming.questions[0].questionId,
      question_order: 1,
      question_type: "ctw"
    }]
  });
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableCtwFingerprintFallback: true
  });
  assert.equal(prepared.existingItem.logicalItemId, incoming.item.logicalItemId);
  assert.equal(prepared.packageData.item.title, "Existing Canonical Title");
  assert.equal(prepared.addedOccurrenceCount, 1);
  assert.equal(prepared.occurrenceConflict, null);
  assert.deepEqual(preparedMetrics(prepared), {
    logicalNewItemCount: 0,
    logicalAutoMergeCount: 1,
    occurrenceInsertedCount: 1
  });
  const atomic = prepareReadingPackageAtomicImport(prepared.packageData, {
    expectedLogicalItemAction: "reuse_existing"
  });
  assert.equal(atomic.rows.reading_logical_items[0].title, "Existing Canonical Title");
  const result = await executePreparedReadingPackageAtomic(database, atomic);
  assert.equal(result.insertedQuestionCount, 0);
  assert.equal(database.rpcCalls.length, 1);
});

test("existing CTW canonical title wins when the incoming CSV title is missing", async () => {
  const incoming = ctwPackageAt({ label: "260306A", date: "2026-03-06", groupId: "ctw-260306a-m1" });
  incoming.item.title = null;
  const database = readingImportDatabase({
    logicalItems: [logicalRow(incoming, incoming.item.logicalItemId, "2026-01-21", "260121A", "Existing Canonical Title")],
    questions: [{
      logical_item_id: incoming.item.logicalItemId,
      question_id: incoming.questions[0].questionId,
      question_order: 1,
      question_type: "ctw"
    }]
  });
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableCtwFingerprintFallback: true
  });
  assert.equal(prepared.packageData.item.title, "Existing Canonical Title");
  assert.equal(
    prepareReadingPackageAtomicImport(prepared.packageData, {
      expectedLogicalItemAction: "reuse_existing"
    }).rows.reading_logical_items[0].title,
    "Existing Canonical Title"
  );
});

test("reimporting the identical CTW occurrence is idempotent", async () => {
  const incoming = ctwPackageAt({ label: "260121A", date: "2026-01-21", groupId: "ctw-260121a-m1" });
  const database = readingImportDatabase({
    logicalItems: [logicalRow(incoming, incoming.item.logicalItemId, "2026-01-21", "260121A")],
    questions: [{
      logical_item_id: incoming.item.logicalItemId,
      question_id: incoming.questions[0].questionId,
      question_order: 1,
      question_type: "ctw"
    }],
    occurrences: [{
      occurrence_id: incoming.occurrences[0].occurrenceId,
      logical_item_id: incoming.item.logicalItemId
    }]
  });
  const [prepared] = await prepareReadingPackagesForImport(database, [incoming], {
    enableCtwFingerprintFallback: true
  });
  assert.equal(prepared.existingItem.logicalItemId, incoming.item.logicalItemId);
  assert.equal(prepared.addedOccurrenceCount, 0);
  assert.equal(prepared.occurrenceConflict, null);
  assert.deepEqual(preparedMetrics(prepared), {
    logicalNewItemCount: 0,
    logicalAutoMergeCount: 1,
    occurrenceInsertedCount: 0
  });
  const result = await importReadingPackageAtomic(database, prepared.packageData);
  assert.equal(result.insertedQuestionCount, 0);
  assert.equal(database.rpcCalls.length, 1);
});

test("the same CTW occurrence with a different blank order fails before the atomic RPC", async () => {
  const original = ctwPackageAt({ label: "260121A", date: "2026-01-21", groupId: "ctw-260121a-m1" });
  const changed = ctwPackageAt({
    label: "260121A",
    date: "2026-01-21",
    groupId: "ctw-260121a-m1",
    mutatePassage(paragraphs) {
      paragraphs[0].rawText = "A studies scien____ nature.";
      paragraphs[0].segments = [
        { kind: "text", text: "A studies " },
        { kind: "blank", slotId: "s1" },
        { kind: "text", text: " nature." }
      ];
    }
  });
  assert.notEqual(original.item.dedupFingerprint, changed.item.dedupFingerprint);
  assert.equal(original.occurrences[0].occurrenceId, changed.occurrences[0].occurrenceId);
  const database = readingImportDatabase({
    logicalItems: [logicalRow(original, original.item.logicalItemId, "2026-01-21", "260121A")],
    occurrences: [{
      occurrence_id: original.occurrences[0].occurrenceId,
      logical_item_id: original.item.logicalItemId
    }]
  });
  const [prepared] = await prepareReadingPackagesForImport(database, [changed], {
    enableCtwFingerprintFallback: true
  });
  assert.equal(prepared.existingItem, null);
  assert.match(prepared.occurrenceConflict, /refusing to rebind/);
  assert.throws(
    () => assertPreparedReadingPackageCanImport(prepared),
    /already belongs to logical item.*refusing to rebind/
  );
  assert.equal(database.rpcCalls.length, 0);
});

test("the same CTW passage with a different blank template stays two logical items", () => {
  const first = ctwCandidateAt({ label: "260121A", date: "2026-01-21", groupId: "ctw-260121a-m1" });
  const second = ctwCandidateAt({
    label: "260305B",
    date: "2026-03-05",
    groupId: "ctw-260305b-m1",
    mutatePassage(paragraphs) {
      paragraphs[0].rawText = "A studies scien____ nature.";
      paragraphs[0].segments = [
        { kind: "text", text: "A studies " },
        { kind: "blank", slotId: "s1" },
        { kind: "text", text: " nature." }
      ];
    }
  });
  const grouped = groupReadingSourceOccurrences([first, second]);
  assert.equal(grouped.packages.length, 2);
  assert.notEqual(grouped.packages[0].item.dedupFingerprint, grouped.packages[1].item.dedupFingerprint);
  assert.equal(grouped.report.possibleDuplicates.length, 0);
});

test("all three templates generate identical business keys on a second upload", () => {
  const cases = [
    ["complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv"],
    ["read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv"],
    ["read_an_academic_passage", "TOEFL_Read_an_Academic_Passage_TEMPLATE.csv"]
  ];
  for (const [type, file] of cases) {
    const first = groupReadingSourceOccurrences(adapt(type, template(file)).candidates).packages[0];
    const second = groupReadingSourceOccurrences(adapt(type, template(file)).candidates).packages[0];
    assert.deepEqual(businessKeys(buildReadingImportRows(first)), businessKeys(buildReadingImportRows(second)));
  }
});

test("atomic migration is idempotent and preserves the earlier first-seen tuple", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../supabase/reading_csv_import.sql"), "utf8");
  assert.match(sql, /create or replace function public\.import_reading_package_atomic/);
  assert.match(sql, /logical_item_action/);
  assert.match(sql, /inserted_occurrence_count/);
  assert.match(sql, /existing_occurrence_count/);
  assert.match(sql, /on conflict \(logical_item_id\) do update/);
  assert.match(sql, /when v_module = 'ctw' and v_logical_item_existed then reading_logical_items\.title/);
  assert.match(sql, /reading-dedup:/);
  assert.match(sql, /READING_DEDUP_FINGERPRINT_IDENTITY_INCONSISTENCY/);
  assert.match(sql, /expected_logical_item_action/);
  assert.match(sql, /first_seen_date = excluded\.first_seen_date/);
  assert.match(sql, /numeric source-label/);
  assert.match(sql, /on conflict \(occurrence_id\) do update/);
  assert.match(sql, /on conflict \(occurrence_id, question_id\) do update/);
  assert.match(sql, /material_id, title, material_type, source/);
});

function businessKeys(rows) {
  const definitions = {
    reading_logical_items: ["logical_item_id"],
    reading_source_occurrences: ["occurrence_id"],
    reading_materials: ["material_id"],
    reading_passages: ["passage_id"],
    reading_passage_paragraphs: ["passage_id", "paragraph_id"],
    reading_passage_sentences: ["passage_id", "sentence_id"],
    reading_questions: ["question_id"],
    reading_question_options: ["question_id", "option_id"],
    reading_ctw_paragraphs: ["question_id", "paragraph_id"],
    reading_ctw_slots: ["question_id", "slot_id"],
    reading_ctw_segments: ["question_id", "paragraph_id", "segment_order"],
    reading_rap_insertion_anchors: ["question_id", "anchor_id"],
    reading_question_occurrences: ["occurrence_id", "question_id"]
  };
  return Object.fromEntries(Object.entries(definitions).map(([table, fields]) => [
    table,
    rows[table].map((row) => fields.map((field) => row[field]).join(":"))
  ]));
}

function ctwCandidateAt({ label, date, groupId, mutateSlots, mutatePassage }) {
  const document = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  const row = document.rows[0];
  row.source_label = label;
  row.occurrence_date = date;
  row.year_month = date.slice(0, 7);
  row.source_module = "m1";
  row.source_order = "1";
  row.source_group_id = groupId;
  if (mutateSlots) {
    const slots = JSON.parse(row.slots_json);
    mutateSlots(slots);
    row.slots_json = JSON.stringify(slots);
  }
  if (mutatePassage) {
    const paragraphs = JSON.parse(row.passage_json);
    mutatePassage(paragraphs);
    row.passage_json = JSON.stringify(paragraphs);
  }
  const result = adapt("complete_the_words", document);
  assert.deepEqual(result.failures, []);
  return result.candidates[0];
}

function ctwPackageAt(input) {
  return groupReadingSourceOccurrences([ctwCandidateAt(input)]).packages[0];
}

function logicalRow(packageData, logicalItemId, firstSeenDate, firstSeenSourceLabel, title = packageData.item.title) {
  return {
    logical_item_id: logicalItemId,
    module: "ctw",
    title,
    dedup_fingerprint: packageData.item.dedupFingerprint,
    first_seen_date: firstSeenDate,
    first_seen_source_label: firstSeenSourceLabel,
    first_seen_source_order: 1
  };
}

function preparedMetrics(prepared) {
  return {
    logicalNewItemCount: prepared.existingItem ? 0 : 1,
    logicalAutoMergeCount: prepared.existingItem ? 1 : 0,
    occurrenceInsertedCount: prepared.addedOccurrenceCount
  };
}

function readingImportDatabase({ logicalItems = [], questions = [], paragraphs = [], slots = [], occurrences = [] }) {
  const tables = {
    reading_logical_items: logicalItems,
    reading_questions: questions,
    reading_ctw_paragraphs: paragraphs,
    reading_ctw_slots: slots,
    reading_source_occurrences: occurrences
  };
  const rpcCalls = [];
  const queryCalls = [];
  return {
    rpcCalls,
    queryCalls,
    from(table) {
      return {
        select() {
          return {
            async in(column, values) {
              queryCalls.push({ table, operation: "in", column, values });
              return {
                data: (tables[table] ?? []).filter((row) => values.includes(row[column])),
                error: null
              };
            },
            async eq(column, value) {
              queryCalls.push({ table, operation: "eq", column, value });
              return {
                data: (tables[table] ?? []).filter((row) => row[column] === value),
                error: null
              };
            }
          };
        }
      };
    },
    async rpc(name, args) {
      assert.equal(name, "import_reading_package_atomic");
      rpcCalls.push(args);
      const questionIds = new Set(questions.map((question) => question.question_id));
      const existingQuestionCount = args.p_rows.reading_questions.filter((question) =>
        questionIds.has(question.question_id)
      ).length;
      return {
        data: {
          logical_item_action: logicalItems.some((item) =>
            item.logical_item_id === args.p_rows.reading_logical_items[0].logical_item_id
          ) ? "reuse_existing" : "create_new",
          inserted_occurrence_count: args.p_rows.reading_source_occurrences.filter((occurrence) =>
            !occurrences.some((existing) => existing.occurrence_id === occurrence.occurrence_id)
          ).length,
          existing_occurrence_count: args.p_rows.reading_source_occurrences.filter((occurrence) =>
            occurrences.some((existing) => existing.occurrence_id === occurrence.occurrence_id)
          ).length,
          inserted_question_count: args.p_rows.reading_questions.length - existingQuestionCount,
          updated_question_count: existingQuestionCount
        },
        error: null
      };
    }
  };
}
