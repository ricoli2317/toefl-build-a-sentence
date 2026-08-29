const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { buildReadingImportRows } = require("../lib/reading/importer.ts");
const { toStudentReadingPracticePayload } = require("../lib/reading/studentPractice.ts");
const { ReadingValidationError, validateReadingImportPackage } = require("../lib/reading/validation.ts");

const root = path.join(__dirname, "..");

function rapPackage() {
  const source = JSON.parse(fs.readFileSync(
    path.join(root, "data/reading/fixtures/reading-source.fixture.json"),
    "utf8"
  ));
  return structuredClone(groupReadingSourceOccurrences(source.occurrences).packages.find(
    (candidate) => candidate.item.module === "rap"
  ));
}

function codePointRange(text, target, from = 0) {
  const utf16Start = text.indexOf(target, from);
  assert.notEqual(utf16Start, -1);
  const startOffset = Array.from(text.slice(0, utf16Start)).length;
  return {
    startOffset,
    endOffset: startOffset + Array.from(target).length,
    nextUtf16Offset: utf16Start + target.length
  };
}

test("RAP import rows and student payload preserve per-question DOCX ranges by offsets", () => {
  const packageData = rapPackage();
  const [firstParagraph, secondParagraph] = packageData.passages[0].paragraphs;
  const first = codePointRange(firstParagraph.text, "response");
  const second = codePointRange(secondParagraph.text, "response");
  const question = packageData.questions[0];
  question.payload.highlightRanges = [
    { paragraphId: firstParagraph.paragraphId, startOffset: first.startOffset, endOffset: first.endOffset },
    { paragraphId: secondParagraph.paragraphId, startOffset: second.startOffset, endOffset: second.endOffset }
  ];

  validateReadingImportPackage(packageData);
  const rows = buildReadingImportRows(packageData);
  assert.deepEqual(rows.reading_questions[0].passage_highlight_ranges, question.payload.highlightRanges);

  const payload = toStudentReadingPracticePayload(packageData);
  assert.deepEqual(payload.questions[0].highlightRanges, question.payload.highlightRanges);
  assert.deepEqual(payload.questions[1].highlightRanges, []);
  assert.equal(JSON.stringify(payload).includes("correctOptionId"), false);
});

test("RAP validation supports discontinuous ranges and rejects overlap or out-of-bounds offsets", () => {
  const packageData = rapPackage();
  const paragraph = packageData.passages[0].paragraphs[0];
  const first = codePointRange(paragraph.text, "Plants");
  const second = codePointRange(paragraph.text, "growth", first.nextUtf16Offset);
  packageData.questions[0].payload.highlightRanges = [
    { paragraphId: paragraph.paragraphId, startOffset: first.startOffset, endOffset: first.endOffset },
    { paragraphId: paragraph.paragraphId, startOffset: second.startOffset, endOffset: second.endOffset }
  ];
  validateReadingImportPackage(packageData);

  packageData.questions[0].payload.highlightRanges[1].startOffset = first.endOffset - 1;
  assert.throws(
    () => validateReadingImportPackage(packageData),
    (error) => error instanceof ReadingValidationError && /ordered and non-overlapping/.test(error.message)
  );

  packageData.questions[0].payload.highlightRanges[1] = {
    paragraphId: paragraph.paragraphId,
    startOffset: Array.from(paragraph.text).length - 1,
    endOffset: Array.from(paragraph.text).length + 1
  };
  assert.throws(
    () => validateReadingImportPackage(packageData),
    (error) => error instanceof ReadingValidationError && /code-point length/.test(error.message)
  );
});

test("RAP renderer slices source ranges without target-text matching and is shared by submitted review", () => {
  const source = fs.readFileSync(path.join(root, "components/reading/ReadingPractice.tsx"), "utf8");
  const renderer = source.slice(
    source.indexOf("function renderRapHighlightedText"),
    source.indexOf("function ChoiceOptionList")
  );
  assert.match(source, /question\.highlightRanges\.filter/);
  assert.match(renderer, /Array\.from\(text\)/);
  assert.match(renderer, /range\.startOffset/);
  assert.match(renderer, /range\.endOffset/);
  assert.match(renderer, /data-testid="rap-source-highlight"/);
  assert.match(renderer, /className="bg-student-primary font-bold text-white"/);
  assert.match(source, /className="inline text-student-primary" data-testid="rap-insertion-marker"/);
  assert.doesNotMatch(renderer, /indexOf|includes|questionType|stem/);
  assert.equal((source.match(/<RapPracticeWorkspace/g) ?? []).length, 1);
  assert.match(source, /mode="submitted_review"/);
});

test("DOCX audit recognizes the actual Word run shading and schema migration is minimal", () => {
  const adapter = fs.readFileSync(path.join(root, "scripts/reading_docx_adapter.py"), "utf8");
  assert.match(adapter, /run_properties\.find\(qn\("shd"\)\)/);
  assert.match(adapter, /shading\.get\(qn\("fill"\)\)/);
  assert.match(adapter, /highlight_ranges: tuple\[tuple\[int, int\], \.\.\.\]/);
  assert.doesNotMatch(adapter, /question_type.*highlight|stem.*highlight/i);

  const migration = fs.readFileSync(path.join(root, "supabase/reading_rap_highlights.sql"), "utf8");
  assert.match(migration, /add column if not exists passage_highlight_ranges jsonb/);
  assert.match(migration, /zero-based, end-exclusive Unicode code-point/);
});
