const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  toStudentReadingPracticePayload,
  StudentReadingLoadError
} = require("../lib/reading/studentPractice.ts");
const {
  calculateReadingElapsedSeconds,
  createReadingNavigation,
  moveReadingNavigation,
  setReadingAnswer
} = require("../lib/reading/practiceState.ts");
const {
  ACTIVE_READING_LOOKUP_CAPABILITIES,
  activeReadingLookupEnabled
} = require("../lib/reading/lookupCapabilities.ts");

const fixtureSource = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../data/reading/fixtures/reading-source.fixture.json"),
  "utf8"
));

function packageFor(module) {
  return structuredClone(
    groupReadingSourceOccurrences(fixtureSource.occurrences).packages.find(
      (packageData) => packageData.item.module === module
    )
  );
}

function forbiddenKeys(value) {
  const keys = [];
  function visit(input) {
    if (!input || typeof input !== "object") return;
    for (const [key, child] of Object.entries(input)) {
      if (["answer", "missingText", "correctOptionId", "correctAnchorId", "correctSentenceId"].includes(key)) {
        keys.push(key);
      }
      visit(child);
    }
  }
  visit(value);
  return keys;
}

test("student-safe CTW keeps blank rendering metadata without answers", () => {
  const full = packageFor("ctw");
  const payload = toStudentReadingPracticePayload(full);
  assert.equal(payload.questions[0].questionType, "ctw");
  assert.equal(payload.item.title, "套题001");
  assert.equal(payload.questions[0].slots[0].prefix, "popul");
  assert.equal(payload.questions[0].slots[0].missingLength, 5);
  assert.deepEqual(forbiddenKeys(payload), []);
  assert.ok(!JSON.stringify(payload).includes("population"));
});

test("student-safe RDL returns resolved image/selection assets and options without the correct option", () => {
  const full = packageFor("rdl");
  full.materials[0] = {
    ...full.materials[0],
    materialId: "RDL-999",
    materialType: "text_message_chain",
    bindingStatus: "bound",
    imageAssetPath: "reading/rdl/RDL-999/material_final.png",
    hitboxDataPath: "reading/rdl/RDL-999/selection_map.json"
  };
  full.questions[0].payload.materialId = "RDL-999";
  const payload = toStudentReadingPracticePayload(full, "https://assets.example.com");
  assert.equal(payload.questions[0].options.length, 3);
  assert.equal(payload.material.imageUrl, "https://assets.example.com/reading/rdl/RDL-999/material_final.png");
  assert.equal(payload.material.selectionMapUrl, "https://assets.example.com/reading/rdl/RDL-999/selection_map.json");
  assert.equal(payload.material.materialType, "text_message_chain");
  assert.deepEqual(forbiddenKeys(payload), []);
  assert.ok(!JSON.stringify(payload).includes("r2.dev"));
});

test("student-safe RAP shares one passage and removes answers from all three subtypes", () => {
  const payload = toStudentReadingPracticePayload(packageFor("rap"));
  assert.equal(payload.passage.paragraphs.length, 2);
  assert.equal(payload.questions.length, 3);
  assert.equal(payload.questions[0].options.length, 3);
  assert.equal(payload.questions[1].anchors.length, 4);
  assert.equal(payload.questions[2].targetParagraphId.endsWith("p02"), true);
  assert.deepEqual(forbiddenKeys(payload), []);
});

test("Reading timer counts up by reusing Writing practice timer semantics", () => {
  assert.equal(calculateReadingElapsedSeconds(1_000, 1_000), 0);
  assert.equal(calculateReadingElapsedSeconds(1_000, 2_400), 1);
  assert.equal(calculateReadingElapsedSeconds(1_000, 62_000), 61);
});

test("question navigation does not alter typed answers or timer anchor", () => {
  const startedAt = 5_000;
  let answers = {};
  answers = setReadingAnswer(answers, "q1", { kind: "choice", optionId: "o2" });
  let navigation = createReadingNavigation("rap", 3, 3);
  navigation = moveReadingNavigation(navigation, 1);
  answers = setReadingAnswer(answers, "q2", { kind: "insertion", anchorId: "a3" });
  navigation = moveReadingNavigation(navigation, -1);
  assert.equal(navigation.currentIndex, 0);
  assert.equal(answers.q1.optionId, "o2");
  assert.equal(answers.q2.anchorId, "a3");
  assert.equal(calculateReadingElapsedSeconds(startedAt, 12_800), 7);
});

test("CTW remains one workspace while preserving all scoring points", () => {
  const navigation = createReadingNavigation("ctw", 1, 10);
  assert.deepEqual(navigation, { currentIndex: 0, workspaceCount: 1, scoringPointCount: 10 });
  assert.equal(moveReadingNavigation(navigation, 1).currentIndex, 0);
});

test("active CTW, RDL, and RAP all disable lookup through one capability gate", () => {
  assert.deepEqual(ACTIVE_READING_LOOKUP_CAPABILITIES, { ctw: false, rdl: false, rap: false });
  assert.equal(activeReadingLookupEnabled("ctw"), false);
  assert.equal(activeReadingLookupEnabled("rdl"), false);
  assert.equal(activeReadingLookupEnabled("rap"), false);

  const source = fs.readFileSync(path.join(__dirname, "../components/reading/ReadingPractice.tsx"), "utf8");
  assert.match(source, /const lookupEnabled = readingLookupEnabled\(mode, practice\.item\.module\)/);
  assert.match(source, /<ReadingWorkspaceRouter[\s\S]*lookupEnabled=\{lookupEnabled\}/);
  assert.match(source, /data-lookup-enabled=\{lookupEnabled \? "true" : "false"\}/);
  assert.match(source, /lookupEnabled && selectionMap && bindingValid/);
  assert.match(source, /lookupEnabled && selectionCommitted && selectedText/);
  assert.match(source, /lookupEnabled \? "" : "select-none"/);
});

test("stable Reading route uses logical identity and safe error text", () => {
  const pageSource = fs.readFileSync(
    path.join(__dirname, "../app/student/reading/practice/[itemId]/page.tsx"),
    "utf8"
  );
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../app/api/reading/practice/[itemId]/route.ts"),
    "utf8"
  );
  assert.match(pageSource, /params: \{ itemId: string \}/);
  assert.doesNotMatch(pageSource, /display.*number/i);
  assert.match(routeSource, /requireUserWithRole\(bearerToken\(request\), "student"\)/);
  const error = new StudentReadingLoadError("foreign key detail", "这个阅读练习暂时无法打开。", 422);
  assert.equal(error.publicMessage, "这个阅读练习暂时无法打开。");
  assert.ok(!error.publicMessage.includes("foreign key"));
});

test("Reading auth verifies signed token claims without a remote getUser round trip", () => {
  const authSource = fs.readFileSync(path.join(__dirname, "../lib/auth.ts"), "utf8");
  assert.match(authSource, /auth\.getClaims\(token\)/);
  assert.match(authSource, /claims\.sub/);
  assert.doesNotMatch(authSource, /auth\.getUser\(token\)/);
});

test("student loader selects only public columns and shell keeps 7B integration minimal", () => {
  const loaderSource = fs.readFileSync(path.join(__dirname, "../lib/reading/studentPractice.ts"), "utf8");
  const shellSource = fs.readFileSync(path.join(__dirname, "../components/reading/ReadingPractice.tsx"), "utf8");
  assert.doesNotMatch(loaderSource, /select\([^)]*(correct_option_id|correct_anchor_id|correct_sentence_id|answer|missing_text)/s);
  assert.match(shellSource, /CtwPracticeWorkspace/);
  assert.match(shellSource, /RdlPracticeWorkspace/);
  assert.match(shellSource, /RapPracticeWorkspace/);
  assert.match(shellSource, /calculateReadingElapsedSeconds/);
  assert.match(shellSource, /buildReadingSubmissionAnswers/);
  assert.match(shellSource, /\/api\/reading\/attempts/);
  assert.doesNotMatch(shellSource, /r2\.dev|cloudflare|reading\/rdl\//i);
  assert.match(shellSource, /invalidate\(STUDENT_READING_HISTORY_CACHE_PREFIX\)/);
  assert.doesNotMatch(shellSource, /wrongbook|retake|STUDENT_SETS_CACHE|READING_RESULT_CACHE/i);
});

test("RDL and RAP share one continuous practice shell with embedded navigation", () => {
  const shellSource = fs.readFileSync(path.join(__dirname, "../components/reading/ReadingPractice.tsx"), "utf8");
  const headerSource = shellSource.slice(
    shellSource.indexOf("function ReadingPracticeHeader"),
    shellSource.indexOf("function ReadingWorkspaceRouter")
  );
  const sharedShellSource = shellSource.slice(
    shellSource.indexOf("function ReadingTwoColumnPracticeShell"),
    shellSource.indexOf("function RdlPracticeWorkspace")
  );
  const navigationSource = shellSource.slice(
    shellSource.indexOf("function ReadingQuestionNavigation"),
    shellSource.indexOf("function ReadingPracticeMessage")
  );

  assert.match(headerSource, /productName \? <p/);
  const submittedReturn = shellSource.indexOf(
    'return (\n      <div className="h-[100dvh]',
    shellSource.indexOf("if (attempt.status === \"submitted\")")
  );
  const activeShellSource = shellSource.slice(
    shellSource.indexOf('return (\n    <div className="h-[100dvh]', submittedReturn + 1),
    shellSource.indexOf("function ReadingPracticeHeader")
  );
  assert.doesNotMatch(activeShellSource, /productName=/);
  assert.match(activeShellSource, /style=\{practice\.item\.module === "ctw" \? undefined : readingTwoColumnScaleStyle\}/);
  assert.match(shellSource, /"--reading-scale-unit": "clamp\(0\.875px, min\(calc\(0\.5px \+ 0\.034722vw\), calc\(0\.4px \+ 0\.066667vh\)\), 1\.12px\)"/);
  assert.match(shellSource, /fontSize: "var\(--reading-scale-unit\)"/);
  assert.match(shellSource, /maxWidth: "1440em"/);
  assert.match(sharedShellSource, /bg-white/);
  assert.match(sharedShellSource, /style=\{readingTitleStyle\}/);
  assert.doesNotMatch(sharedShellSource, /divide-x|border-l|border-r/);
  assert.match(shellSource, /function ReadingQuestionColumn/);
  assert.doesNotMatch(sharedShellSource, /max-w-3xl/);
  assert.match(shellSource, /fontSize: "17em"/);
  assert.match(shellSource, /gap: "26em"/);
  assert.match(shellSource, /height: `\$\{20 \/ 17\}em`/);
  assert.equal((shellSource.match(/<ReadingQuestionColumn labelledBy=/g) ?? []).length, 2);
  assert.ok((shellSource.match(/style=\{readingQuestionTextStyle\}/g) ?? []).length >= 2);
  assert.match(shellSource, /style=\{\{ \.\.\.readingQuestionTextStyle, \.\.\.readingChoiceStyle \}\}/);
  assert.match(shellSource, /practice\.item\.module !== "ctw"[\s\S]*?<ReadingQuestionNavigation/);
  assert.match(navigationSource, /embedded[\s\S]*?border-t border-student-border/);
  assert.match(navigationSource, /navigationButtonSizeClassName = "h-10 w-28 px-3 py-2"/);
  assert.match(navigationSource, /stepButtonClassName = `student-button-secondary \$\{navigationButtonSizeClassName\}`/);
  assert.match(navigationSource, /`\$\{stepButtonClassName\} justify-self-start`/);
  assert.match(navigationSource, /`\$\{stepButtonClassName\} justify-self-end`/);
  assert.match(navigationSource, /`student-button-primary \$\{navigationButtonSizeClassName\} justify-self-end`/);
  assert.match(shellSource, /rdlMaterialInstruction\(material\.materialType\)/);
  assert.doesNotMatch(shellSource, /title=\{material\.title\}/);
});
