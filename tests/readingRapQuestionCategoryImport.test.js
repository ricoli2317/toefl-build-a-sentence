const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
// Optional explicit local runtime path for checkouts with shared node_modules.
// CSV/payload tests always run; only offline engine tests need this dependency.
let PGlite;
if (process.env.READING_IMPORT_SQL_TEST_PGLITE) {
  ({ PGlite } = require(path.resolve(process.env.READING_IMPORT_SQL_TEST_PGLITE)));
} else {
  try { ({ PGlite } = require("@electric-sql/pglite")); }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
}
const engineTest = (name, fn) => test(name, { skip: !PGlite && "Install @electric-sql/pglite or set READING_IMPORT_SQL_TEST_PGLITE to a local runtime" }, fn);

const { parseCsvDocument } = require("../lib/csv.ts");
const { detectQuestionType, compareHeaders } = require("../lib/questionCsvSchemas.ts");
const { adaptReadingCsv } = require("../lib/reading/csvAdapter.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { READING_QUESTION_CATEGORIES } = require("../lib/reading/questionCategory.ts");
const { READ_AN_ACADEMIC_PASSAGE_HEADERS } = require("../lib/reading/csvSchemas.ts");
const { validateReadingImportPackage } = require("../lib/reading/validation.ts");
const {
  assertPreparedReadingPackageCanImport,
  buildReadingImportRows,
  importReadingPackage,
  importReadingPackageAtomic,
  prepareReadingPackageAtomicImport,
  prepareReadingPackagesForImport
} = require("../lib/reading/importer.ts");
const { readingSemanticFingerprint, readingPossibleDuplicateFingerprint } = require("../lib/reading/semantic.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const patchSql = read("supabase/reading_rap_question_category_import_20261011.sql");
const verifySql = read("supabase/reading_rap_question_category_import_verify_20261011.sql");
const material = {
  materialId: "RDL-001", title: "University Robotics Club Workshop", materialType: "flyer",
  instruction: "Read a flyer.", source: "fixture", sourceDate: "2026-01-01", yearMonth: "2026-01",
  bindingStatus: "bound", imageAssetPath: "reading/rdl/RDL-001/material_final.png",
  hitboxDataPath: "reading/rdl/RDL-001/selection_map.json"
};

function document(product = "Read_an_Academic_Passage") {
  return parseCsvDocument(read(`data/reading/csv-templates/TOEFL_${product}_TEMPLATE.csv`), { trimValues: false });
}

// Reparse real CSV bytes after every test mutation, not just in-memory records.
function csvRoundTrip(doc) {
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [doc.headers.join(","), ...doc.rows.map((row) => doc.headers.map((header) => quote(row[header])).join(","))].join("\n");
  return parseCsvDocument(csv, { trimValues: false });
}

function adapt(doc, type = "read_an_academic_passage") {
  return adaptReadingCsv({
    type, rows: csvRoundTrip(doc).rows, sourceFile: "synthetic-new-only.csv",
    materials: new Map([[material.materialId, material]])
  });
}

function packageFrom(doc = document(), type) {
  const result = adapt(doc, type);
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates.length, 1);
  return groupReadingSourceOccurrences(result.candidates).packages[0];
}

function assertRejected(doc, pattern) {
  const result = adapt(doc);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, pattern);
}

test("RAP schema recognizes question_category and rejects a missing header", () => {
  const doc = document();
  assert.deepEqual(doc.headers, [...READ_AN_ACADEMIC_PASSAGE_HEADERS]);
  assert.equal(detectQuestionType(doc.headers), "read_an_academic_passage");
  const missing = doc.headers.filter((header) => header !== "question_category");
  assert.equal(detectQuestionType(missing), "unknown");
  assert.deepEqual(compareHeaders(missing, READ_AN_ACADEMIC_PASSAGE_HEADERS).missingFields, ["question_category"]);
  doc.headers = missing;
  assertRejected(doc, /question_order=1 source_question_number=21: Missing question_category/);
});

test("all fixed 10 categories pass CSV, adapter, grouping, validation and questionRow with the appropriate structure", () => {
  assert.equal(READING_QUESTION_CATEGORIES.length, 10);
  for (const category of READING_QUESTION_CATEGORIES) {
    const doc = document();
    const type = category === "选句题" ? "rap_sentence_selection"
      : category === "句子插入题" ? "rap_sentence_insertion" : "rap_multiple_choice";
    doc.rows = [doc.rows.find((row) => row.question_type === type)];
    doc.rows[0].question_order = "1";
    doc.rows[0].question_category = category;
    const candidate = adapt(doc).candidates[0];
    assert.equal(candidate.questions[0].questionCategory, category);
    const packageData = packageFrom(doc);
    validateReadingImportPackage(packageData, { requireRapQuestionCategory: true });
    assert.equal(packageData.questions[0].questionCategory, category);
    const prepared = prepareReadingPackageAtomicImport(packageData, { expectedLogicalItemAction: "create_new" });
    assert.equal(prepared.rows.reading_questions[0].question_category, category);
    assert.equal(prepared.rows.reading_questions[0].question_type, type);
  }
});

test("missing cells, empty/whitespace and illegal categories reject the entire RAP group and identify the question", () => {
  for (const value of [undefined, "", "   ", "未知分类", "事实信息", "Vocabulary", "NULL"]) {
    const doc = document();
    doc.rows[1].question_category = value;
    assertRejected(doc, /CSV row 3 question_order=2 source_question_number=22: (Missing|invalid) question_category/);
  }
});

test("selection and insertion require their exact structural category; ordinary choices reject both", () => {
  for (const [index, requiredCategory, type] of [
    [1, "句子插入题", "rap_sentence_insertion"],
    [2, "选句题", "rap_sentence_selection"]
  ]) {
    for (const category of READING_QUESTION_CATEGORIES.filter((value) => value !== requiredCategory)) {
      const doc = document();
      doc.rows[index].question_category = category;
      assertRejected(doc, new RegExp(`question=.*-q0${index + 1}.*questionCategory: ${type} requires question_category ${requiredCategory}`));
    }
  }
  for (const category of ["选句题", "句子插入题"]) {
    const doc = document();
    doc.rows[0].question_category = category;
    assertRejected(doc, /question=.*-q01.*rap_multiple_choice cannot use structural question_category/);
  }
});

test("new-canonical validation rejects lost/invalid intermediate categories without inferring defaults", () => {
  for (const value of [undefined, null, "", "   ", "未知分类", 7]) {
    const packageData = packageFrom();
    packageData.questions[0].questionCategory = value;
    assert.throws(() => validateReadingImportPackage(packageData, { requireRapQuestionCategory: true }), /question=.*-q01.*questionCategory/);
    assert.throws(() => prepareReadingPackageAtomicImport(packageData, { expectedLogicalItemAction: "create_new" }), /questionCategory/);
    assert.throws(() => prepareReadingPackageAtomicImport(packageData), /questionCategory/);
  }
  const historical = packageFrom();
  historical.questions.forEach((question) => { delete question.questionCategory; });
  assert.doesNotThrow(() => prepareReadingPackageAtomicImport(historical, { expectedLogicalItemAction: "reuse_existing" }));
});

test("classification does not bypass existing option, anchor, sentence, or question-type validation", () => {
  const badOptions = document();
  const options = JSON.parse(badOptions.rows[0].options_json);
  options[1].text = "";
  badOptions.rows[0].options_json = JSON.stringify(options);
  assertRejected(badOptions, /options\[1\]\.text: must not be empty/);
  const badAnchors = document();
  const anchors = JSON.parse(badAnchors.rows[1].insertion_anchors_json);
  anchors[1].boundaryIndex = anchors[0].boundaryIndex;
  anchors[1].afterSentenceId = anchors[0].afterSentenceId;
  badAnchors.rows[1].insertion_anchors_json = JSON.stringify(anchors);
  assertRejected(badAnchors, /duplicate insertion boundary/);
  const badSentence = document();
  badSentence.rows[2].correct_sentence_id = "nonexistent";
  assertRejected(badSentence, /missing source reference|correctSentenceId/);
  const badType = document();
  badType.rows[0].question_type = "rap_unknown";
  assertRejected(badType, /unsupported RAP question_type/);
});

test("unsorted questions retain independent categories through canonical ID remapping and final RPC payload", async () => {
  const doc = document();
  const fourth = { ...doc.rows[0], question_order: "4", source_question_number: "24", question_category: "词汇题", question_stem: "What does force mean?" };
  doc.rows = [doc.rows[2], fourth, doc.rows[0], doc.rows[1]];
  const expected = ["事实信息题", "句子插入题", "选句题", "词汇题"];
  const candidate = adapt(doc).candidates[0];
  assert.deepEqual(candidate.questions.map((question) => question.questionCategory), expected);
  const packageData = packageFrom(doc);
  assert.deepEqual(packageData.questions.map((question) => question.questionCategory), expected);
  assert.equal(packageData.passages.length, 1);
  let calls = 0;
  await importReadingPackageAtomic({
    async rpc(name, args) {
      calls += 1;
      assert.equal(name, "import_reading_package_atomic");
      assert.deepEqual(args.p_rows.reading_questions.map((question) => question.question_category), expected);
      assert.deepEqual(args.p_rows.reading_questions.map((question) => question.question_id), packageData.questions.map((question) => question.questionId));
      return { data: { logical_item_action: "create_new", inserted_occurrence_count: 1, existing_occurrence_count: 0, inserted_question_count: 4, updated_question_count: 0 }, error: null };
    }
  }, packageData, { expectedLogicalItemAction: "create_new" });
  assert.equal(calls, 1);
});

test("CTW/RDL need no classification column and keep NULL question-category payloads", () => {
  for (const [product, type] of [["Complete_the_Words", "complete_the_words"], ["Read_in_Daily_Life", "read_in_daily_life"]]) {
    const doc = document(product);
    assert.ok(!doc.headers.includes("question_category"));
    const packageData = packageFrom(doc, type);
    validateReadingImportPackage(packageData, { requireRapQuestionCategory: true });
    assert.ok(packageData.questions.every((question) => question.questionCategory === undefined));
    assert.ok(prepareReadingPackageAtomicImport(packageData, { expectedLogicalItemAction: "create_new" }).rows.reading_questions.every((row) => row.question_category === null));
  }
});

test("categories do not change strict/semantic/possible-duplicate identities or grouped canonical IDs", () => {
  const first = packageFrom();
  const changed = document();
  changed.rows[0].question_category = "推断题";
  const second = packageFrom(changed);
  assert.equal(first.item.dedupFingerprint, second.item.dedupFingerprint);
  assert.equal(first.item.logicalItemId, second.item.logicalItemId);
  assert.equal(readingSemanticFingerprint(first), readingSemanticFingerprint(second));
  assert.equal(readingPossibleDuplicateFingerprint(first), readingPossibleDuplicateFingerprint(second));
  const combined = groupReadingSourceOccurrences([adapt(document()).candidates[0], adapt(changed).candidates[0]]);
  assert.equal(combined.packages.length, 1);
});

test("legacy direct-upsert importer omits classification when writing existing canonical questions", async () => {
  const packageData = packageFrom();
  const writes = [];
  const existingId = packageData.questions[0].questionId;
  await importReadingPackage({
    from(table) {
      return {
        select() { return { async in() { return { data: [{ question_id: existingId }], error: null }; } }; },
        async upsert(rows) { if (table === "reading_questions") writes.push(...rows); return { error: null }; }
      };
    }
  }, packageData);
  assert.equal(Object.hasOwn(writes[0], "question_category"), false);
  assert.equal(writes[1].question_category, "句子插入题");
  assert.equal(writes[2].question_category, "选句题");
});

async function localDatabase() {
  // OFFLINE, in-memory PostgreSQL only. Historical schema/RPC files are local
  // test scaffolding, never a production deployment source. The increment's
  // mapping baseline is the production fragment inspected on 2026-10-11.
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role; create role fixture_reader; create table public.profiles(id uuid primary key);");
  await db.exec(read("supabase/reading_data_layer.sql").split("create index if not exists reading_logical_items_catalog_idx")[0]);
  await db.exec(`
    alter table public.reading_logical_items drop constraint reading_logical_item_title_check;
    alter table public.reading_logical_items add column catalog_category text, add column catalog_search_text text;
    alter table public.reading_materials add column catalog_search_text text;
    alter table public.reading_questions add column question_category text;
  `);
  // A simulated newer deployed change must survive the increment byte-for-byte.
  await db.exec(read("supabase/reading_csv_import.sql").replace("  v_module text;", "  v_module text;\n  -- fixture: unrelated newer production change"));
  await db.exec("grant execute on function public.import_reading_package_atomic(jsonb,uuid) to fixture_reader;");
  return db;
}

async function rpcDefinition(db) {
  return (await db.query("select pg_get_functiondef('public.import_reading_package_atomic(jsonb,uuid)'::regprocedure) as definition")).rows[0].definition;
}

function localClient(db) {
  return {
    from(table) {
      assert.ok(["reading_logical_items", "reading_source_occurrences"].includes(table));
      return { select(columns) { return {
        async in(column, values) {
          const result = await db.query(`select ${columns} from public.${table} where ${column} = any($1::text[])`, [values]);
          return { data: result.rows, error: null };
        }
      }; } };
    },
    async rpc(name, args) {
      assert.equal(name, "import_reading_package_atomic");
      const result = await db.query("select public.import_reading_package_atomic($1::jsonb,$2::uuid) as result", [JSON.stringify(args.p_rows), args.p_created_by]);
      return { data: result.rows[0].result, error: null };
    }
  };
}

engineTest("offline SQL increment changes only the three INSERT mappings, preserves metadata and is idempotent", async () => {
  const db = await localDatabase();
  try {
    const before = await rpcDefinition(db);
    const oldMapping = patchSql.match(/\$old\$([\s\S]*?)\$old\$/)[1];
    const newMapping = patchSql.match(/\$new\$([\s\S]*?)\$new\$/)[1];
    assert.ok(before.includes(oldMapping));
    await db.exec(patchSql);
    const after = await rpcDefinition(db);
    assert.equal(after, before.replace(oldMapping, newMapping));
    assert.equal((newMapping.match(/question_category/g) ?? []).length, 3);
    assert.ok(after.includes("-- fixture: unrelated newer production change"));
    assert.equal((await db.query(verifySql)).rows[0].verification_status, "PASS");
    assert.equal((await db.query("select has_function_privilege('fixture_reader','public.import_reading_package_atomic(jsonb,uuid)','EXECUTE') as allowed")).rows[0].allowed, true);
    await db.exec(patchSql);
    assert.equal(await rpcDefinition(db), after);
    // Drift in the targeted fragment is refused, not overwritten.
    await db.exec(before.replace("    question_type text, stem text,", "    question_type text,  stem text,"));
    const drifted = await rpcDefinition(db);
    await assert.rejects(() => db.exec(patchSql), /differs from the inspected baseline/);
    await db.exec("rollback;");
    assert.equal(await rpcDefinition(db), drifted);
    assert.match((await db.query(verifySql)).rows[0].verification_status, /^FAIL/);
  } finally { await db.close(); }
});

engineTest("offline RPC persists RAP classifications, preserves existing ones, CTW/RDL NULLs, dedup and atomic rollback", async () => {
  const db = await localDatabase();
  try {
    await db.exec(patchSql);
    const client = localClient(db);
    const packageData = packageFrom();
    const first = await importReadingPackageAtomic(client, packageData, { expectedLogicalItemAction: "create_new" });
    assert.equal(first.insertedQuestionCount, 3);
    const categories = async () => (await db.query("select question_category from public.reading_questions where module='rap' order by question_order")).rows.map((row) => row.question_category);
    assert.deepEqual(await categories(), ["事实信息题", "句子插入题", "选句题"]);
    const changed = document();
    changed.rows[0].question_category = "推断题";
    const [prepared] = await prepareReadingPackagesForImport(client, [packageFrom(changed)]);
    assert.equal(prepared.reuseKind, "exact_fingerprint");
    assert.equal(prepared.addedOccurrenceCount, 0);
    assertPreparedReadingPackageCanImport(prepared);
    const second = await importReadingPackageAtomic(client, prepared.packageData, { expectedLogicalItemAction: "reuse_existing" });
    assert.equal(second.insertedQuestionCount, 0);
    assert.deepEqual(await categories(), ["事实信息题", "句子插入题", "选句题"]);
    const nullPayload = buildReadingImportRows(packageData);
    nullPayload.reading_questions.forEach((question) => { question.question_category = null; });
    await client.rpc("import_reading_package_atomic", { p_rows: nullPayload, p_created_by: null });
    assert.deepEqual(await categories(), ["事实信息题", "句子插入题", "选句题"]);

    for (const [product, type] of [["Complete_the_Words", "complete_the_words"], ["Read_in_Daily_Life", "read_in_daily_life"]]) {
      const nonRapDoc = document(product);
      if (type === "read_in_daily_life") nonRapDoc.rows.forEach((row) => { row.source_order = "2"; });
      const nonRap = packageFrom(nonRapDoc, type);
      const rows = prepareReadingPackageAtomicImport(nonRap, { expectedLogicalItemAction: "create_new" }).rows;
      // Even an unexpected non-RAP category cannot change the original NULL behavior.
      rows.reading_questions.forEach((question) => { question.question_category = "事实信息题"; });
      await client.rpc("import_reading_package_atomic", { p_rows: rows, p_created_by: null });
    }
    assert.ok((await db.query("select question_category from public.reading_questions where module <> 'rap'")).rows.every((row) => row.question_category === null));

    const inconsistent = structuredClone(nullPayload);
    inconsistent.reading_logical_items[0].logical_item_id = "another-fingerprint-owner";
    await assert.rejects(() => client.rpc("import_reading_package_atomic", { p_rows: inconsistent }), /READING_DEDUP_FINGERPRINT_IDENTITY_INCONSISTENCY/);

    const sourceConflict = document();
    sourceConflict.rows.forEach((row) => { row.passage_title = "Different Passage"; });
    const [blocked] = await prepareReadingPackagesForImport(client, [packageFrom(sourceConflict)]);
    assert.throws(() => assertPreparedReadingPackageCanImport(blocked), /refusing to rebind/);

    const failedNew = document();
    failedNew.rows.forEach((row) => { row.passage_title = "Different Passage"; row.source_group_id = "failed-new"; row.source_label = "ROLLBACK-FIXTURE"; });
    const brokenRows = prepareReadingPackageAtomicImport(packageFrom(failedNew), { expectedLogicalItemAction: "create_new" }).rows;
    brokenRows.reading_question_options[0].question_id = "missing-question";
    const counts = async () => (await db.query(`select
      (select count(*) from public.reading_logical_items) as items,
      (select count(*) from public.reading_questions) as questions,
      (select count(*) from public.reading_source_occurrences) as occurrences,
      (select count(*) from public.reading_passages) as passages`)).rows[0];
    const before = await counts();
    await assert.rejects(() => client.rpc("import_reading_package_atomic", { p_rows: brokenRows }), /foreign key constraint/);
    assert.deepEqual(await counts(), before);
  } finally { await db.close(); }
});
