const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  assertCanonicalRdlTitle,
  canonicalizeRdlTitleCapitalization,
  countEnglishTitleWords,
  decideRdlProductionTitle
} = require("../lib/reading/rdlTitles.ts");
const {
  StudentReadingLoadError,
  toStudentReadingPracticePayload
} = require("../lib/reading/studentPractice.ts");
const { buildReadingImportRows } = require("../lib/reading/importer.ts");

const projectRoot = path.join(__dirname, "..");
const fixtureSource = JSON.parse(fs.readFileSync(
  path.join(projectRoot, "data/reading/fixtures/reading-source.fixture.json"),
  "utf8"
));

function packageFor(module) {
  return structuredClone(groupReadingSourceOccurrences(fixtureSource.occurrences).packages.find(
    (packageData) => packageData.item.module === module
  ));
}

test("RDL title production keeps eligible explicit titles and requires reviewed generated titles otherwise", () => {
  assert.deepEqual(decideRdlProductionTitle({
    explicitOriginalTitle: true,
    originalTitle: "University Robotics Club Workshop",
    generatedTitle: null
  }), {
    action: "KEEP_ORIGINAL",
    title: "University Robotics Club Workshop",
    originalTitleWordCount: 4
  });
  assert.deepEqual(decideRdlProductionTitle({
    explicitOriginalTitle: false,
    originalTitle: null,
    generatedTitle: "Extended Library Hours",
    sourceOpeningText: "Library hours will be extended during final exams."
  }).action, "GENERATE_SHORT_TITLE");
  assert.throws(() => decideRdlProductionTitle({
    explicitOriginalTitle: true,
    originalTitle: "Extended Library Hours for Final Exams",
    generatedTitle: "Extended Library Hours"
  }), /must not truncate/);
  assert.throws(() => decideRdlProductionTitle({
    explicitOriginalTitle: false,
    originalTitle: null,
    generatedTitle: "Library Hours Will Be",
    sourceOpeningText: "Library hours will be extended during final exams."
  }), /must not copy/);
});

test("RDL capitalization uppercases every English word initial and lowercases the remainder", () => {
  assert.equal(canonicalizeRdlTitleCapitalization("Gym membership"), "Gym Membership");
  assert.equal(canonicalizeRdlTitleCapitalization("Internship fair follow-up"), "Internship Fair Follow-Up");
  assert.equal(canonicalizeRdlTitleCapitalization("STEM Peer Support Group"), "Stem Peer Support Group");
  assert.equal(canonicalizeRdlTitleCapitalization("Shakespeare's KINGS"), "Shakespeare's Kings");
  assert.throws(() => assertCanonicalRdlTitle("Gym membership"), /capitalize every English word/);
  assert.throws(() => assertCanonicalRdlTitle("STEM Peer Support Group"), /expected Stem Peer Support Group/);
});

test("current RDL audit covers all 86 materials and every final title has at most five words", () => {
  const audit = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "data/reading/reports/rdl-title-audit.json"),
    "utf8"
  ));
  assert.equal(audit.material_count, 86);
  assert.equal(audit.schema_version, 2);
  assert.equal(audit.keep_original_count, 50);
  assert.equal(audit.generate_short_title_count, 36);
  assert.equal(audit.all_final_titles_capitalization_compliant, true);
  assert.equal(new Set(audit.materials.map((row) => row.material_id)).size, 86);
  assert.deepEqual(new Set(audit.materials.map((row) => row.action)), new Set([
    "KEEP_ORIGINAL",
    "GENERATE_SHORT_TITLE"
  ]));
  for (const row of audit.materials) {
    assert.equal(assertCanonicalRdlTitle(row.new_title), row.new_title);
    assert.ok(countEnglishTitleWords(row.new_title) <= 5, row.material_id);
    assert.equal(row.explicit_original_title, row.original_title !== null);
  }
});

test("student RDL payload reads only the stored material title and never falls back to item text", () => {
  const packageData = packageFor("rdl");
  packageData.item.title = "Wrong Logical Item Fallback";
  packageData.materials[0] = {
    ...packageData.materials[0],
    title: "Stored Material Title",
    bindingStatus: "bound",
    imageAssetPath: "reading/rdl/RDL-999/material_final.png",
    hitboxDataPath: "reading/rdl/RDL-999/selection_map.json"
  };
  const payload = toStudentReadingPracticePayload(packageData, "https://assets.example.com");
  assert.equal(payload.item.title, "Stored Material Title");
  assert.equal(payload.material.title, "Stored Material Title");

  packageData.materials[0].title = null;
  assert.throws(
    () => toStudentReadingPracticePayload(packageData, "https://assets.example.com"),
    (error) => error instanceof StudentReadingLoadError && /canonical title is missing/.test(error.message)
  );
});

test("every importer path requires matching canonical RDL material and logical titles", () => {
  const packageData = packageFor("rdl");
  packageData.item.title = "Gym Membership";
  packageData.materials[0].title = "Gym membership";
  assert.throws(() => buildReadingImportRows(packageData), /capitalize every English word/);

  packageData.materials[0].title = "Campus Notice";
  assert.throws(() => buildReadingImportRows(packageData), /must match its canonical material title/);
});

test("RAP title pipeline remains independent and preserves long passage titles", () => {
  const packageData = packageFor("rap");
  const originalTitle = "The Complete History of a Very Ancient Ecosystem";
  packageData.item.title = originalTitle;
  packageData.passages[0].title = originalTitle;
  const payload = toStudentReadingPracticePayload(packageData);
  assert.equal(payload.item.title, originalTitle);
  assert.equal(payload.passage.title, originalTitle);
});

test("historical DOCX adapter no longer treats the first material line as an RDL title", () => {
  const source = fs.readFileSync(path.join(projectRoot, "scripts/reading_docx_adapter.py"), "utf8");
  const titleFunction = source.slice(source.indexOf("def rdl_title"), source.indexOf("def rdl_title_word_count"));
  assert.match(titleFunction, /subject_index/);
  assert.doesNotMatch(titleFunction, /return first|lines\[0\]/);
  assert.match(source, /must supply a reviewed canonical_title/);
});
