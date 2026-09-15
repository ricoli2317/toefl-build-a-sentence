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
  readingQuestionNavigationTargets,
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

test("review side navigation skips CTW slots and moves between Reading questions", () => {
  const keys = ["ctw:q1", "ctw:q1", "ctw:q1", "rdl:q2", "rap:q3"];
  assert.deepEqual(readingQuestionNavigationTargets(keys, 0), {
    previousIndex: null,
    nextIndex: 3
  });
  assert.deepEqual(readingQuestionNavigationTargets(keys, 2), {
    previousIndex: null,
    nextIndex: 3
  });
  assert.deepEqual(readingQuestionNavigationTargets(keys, 3), {
    previousIndex: 0,
    nextIndex: 4
  });
  assert.deepEqual(readingQuestionNavigationTargets(keys, 4), {
    previousIndex: 3,
    nextIndex: null
  });
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
  assert.doesNotMatch(shellSource, /retake|STUDENT_SETS_CACHE|READING_RESULT_CACHE/i);
  assert.match(shellSource, /wrongbook[\s\S]*invalidateStudentWrongbook/i);
});

test("CTW, RDL, and RAP share one fixed-height practice viewport with side navigation", () => {
  const shellSource = fs.readFileSync(path.join(__dirname, "../components/reading/ReadingPractice.tsx"), "utf8");
  const headerSource = shellSource.slice(
    shellSource.indexOf("function ReadingPracticeHeader"),
    shellSource.indexOf("function ReadingWorkspaceRouter")
  );
  const sharedShellSource = shellSource.slice(
    shellSource.indexOf("function ReadingTwoColumnPracticeShell"),
    shellSource.indexOf("function RdlPracticeWorkspace")
  );
  const viewportSource = shellSource.slice(
    shellSource.indexOf("export function ReadingQuestionViewport"),
    shellSource.indexOf("function ReadingPracticeMessage")
  );

  assert.match(headerSource, /productName \? <p/);
  assert.match(shellSource, /"--reading-header-height": "56px"/);
  assert.match(headerSource, /h-\[var\(--reading-header-height\)\]/);
  assert.match(headerSource, /\{timeLabel\}/);
  assert.match(headerSource, /data-testid=\{progressTestId\}/);
  assert.doesNotMatch(headerSource, /min-h-\[54px\].*rounded-xl.*bg-student-primary-soft/);
  const activeShellSource = shellSource.slice(
    shellSource.indexOf("export function ReadingPracticeShell"),
    shellSource.indexOf("function ReadingPracticeHeader")
  );
  assert.doesNotMatch(activeShellSource, /productName=/);
  assert.match(activeShellSource, /"h-\[100dvh\] overflow-hidden"/);
  assert.match(activeShellSource, /h-\[calc\(100dvh-var\(--reading-header-height\)\)\] min-h-0/);
  assert.doesNotMatch(activeShellSource, /layoutMode="natural"/);
  assert.match(activeShellSource, /style=\{readingTwoColumnScaleStyle\}/);
  assert.match(shellSource, /"--reading-scale-unit": "clamp\(0\.875px, min\(calc\(0\.5px \+ 0\.034722vw\), calc\(0\.4px \+ 0\.066667vh\)\), 1\.12px\)"/);
  assert.match(shellSource, /fontSize: "var\(--reading-scale-unit\)"/);
  assert.match(shellSource, /maxWidth: "1600em"/);
  assert.match(sharedShellSource, /bg-white/);
  assert.match(sharedShellSource, /style=\{readingTitleStyle\}/);
  assert.doesNotMatch(sharedShellSource, /divide-x|border-l|border-r/);
  assert.match(shellSource, /function ReadingQuestionColumn/);
  assert.doesNotMatch(sharedShellSource, /max-w-3xl/);
  assert.ok((shellSource.match(/fontSize: "18em"/g) ?? []).length >= 2);
  assert.match(shellSource, /gap: "24em"/);
  assert.match(shellSource, /height: `\$\{20 \/ 18\}em`/);
  assert.equal((shellSource.match(/<ReadingQuestionColumn labelledBy=/g) ?? []).length, 2);
  assert.ok((shellSource.match(/style=\{readingQuestionTextStyle\}/g) ?? []).length >= 2);
  assert.match(shellSource, /style=\{\{ \.\.\.readingQuestionTextStyle, \.\.\.readingChoiceStyle \}\}/);
  assert.match(viewportSource, /h-\[calc\(100dvh-var\(--reading-header-height\)\)\].*py-\[12px\]/);
  assert.doesNotMatch(viewportSource, /100dvh-92px/);
  assert.match(viewportSource, /grid-cols-\[80px_minmax\(0,1fr\)_80px\]/);
  assert.match(viewportSource, /col-start-2 row-start-1/);
  assert.match(viewportSource, /className="contents"/);
  assert.match(viewportSource, /data-reading-navigation-rail="previous"/);
  assert.match(viewportSource, /data-reading-navigation-rail="next"/);
  assert.doesNotMatch(viewportSource, /absolute inset-0|z-20|mx-\[52em\]/);
  assert.match(viewportSource, /aria-label="Previous"/);
  assert.match(viewportSource, /aria-label="Next"/);
  assert.match(viewportSource, /col-start-3 row-start-1[\s\S]*aria-label="Submit"/);
  assert.match(viewportSource, /h-\[76px\] w-\[52px\]/);
  assert.match(viewportSource, /group-disabled:bg-\[#f4f4f7\]/);
  assert.match(viewportSource, /group-disabled:text-student-muted\/45/);
  assert.match(viewportSource, />Previous<|>Previous\}/);
  assert.match(viewportSource, />Next<|>Next\}/);
  assert.match(viewportSource, />Submit<|>Submit\}/);
  assert.doesNotMatch(viewportSource, /Q \d|Submit Module|size="36em"/);
  assert.doesNotMatch(viewportSource, /bg-student-primary px-\[14em\]/);
  assert.match(viewportSource, /module === "ctw"[\s\S]*overflow-visible/);
  assert.doesNotMatch(viewportSource, /module === "ctw"[\s\S]*?overflow-y-(?:auto|scroll)/);
  const choiceListSource = shellSource.slice(
    shellSource.indexOf("function ChoiceOptionList"),
    shellSource.indexOf("export function ReadingQuestionViewport")
  );
  assert.doesNotMatch(choiceListSource, /justify-between|justify-around|space-evenly/);
  assert.match(shellSource, /rdlMaterialInstruction\(material\.materialType\)/);
  assert.doesNotMatch(shellSource, /title=\{material\.title\}/);
});

test("CTW passage is vertically centered in the body without compounding its 18em text size", () => {
  const source = fs.readFileSync(path.join(__dirname, "../components/reading/ReadingPractice.tsx"), "utf8");
  const ctwSource = source.slice(
    source.indexOf("function CtwPracticeWorkspace"),
    source.indexOf("function CtwBlankWord")
  );

  assert.match(ctwSource, /text-center text-\[20em\]/);
  assert.match(ctwSource, /flex h-full min-h-0 max-w-4xl flex-col/);
  assert.match(ctwSource, /flex min-h-0 flex-1 flex-col/);
  assert.match(ctwSource, /my-auto w-full py-\[24em\] text-left text-\[18em\]/);
  assert.match(ctwSource, /marginBottom: paragraphIndex === paragraphs\.length - 1 \? 0 : `\$\{20 \/ 18\}em`/);
  assert.doesNotMatch(ctwSource, /mt-\[28em\]|mb-\[20em\]|justify-between|mt-auto/);
});

test("single-practice timer uses the shared lightweight Reading header without a second exit action", () => {
  const source = fs.readFileSync(path.join(__dirname, "../components/reading/ReadingPractice.tsx"), "utf8");
  const headerSource = source.slice(
    source.indexOf("export function ReadingPracticeHeader"),
    source.indexOf("export function ReadingWorkspaceRouter")
  );

  assert.match(headerSource, /\{timeLabel\}[\s\S]*timeValue \?\? formatWritingTimer\(elapsedSeconds\)/);
  assert.doesNotMatch(headerSource, /onExit|Exit Practice|DoorOpen|writing-exit-button/);
});

test("Full Set and wrongbook entry points reuse the compact header and fixed question viewport", () => {
  const sources = [
    "ReadingFullSetRunner.tsx",
    "ReadingFullSetWrongbookPractice.tsx",
    "ReadingWrongbookReview.tsx"
  ].map((file) => fs.readFileSync(path.join(__dirname, `../components/reading/${file}`), "utf8"));

  for (const source of sources) {
    assert.match(source, /<ReadingPracticeHeader/);
    assert.match(source, /<ReadingQuestionViewport/);
    assert.match(source, /style=\{readingTwoColumnScaleStyle\}/);
    assert.doesNotMatch(source, /layoutMode="natural"|h-\[76px\]|100dvh-76px/);
  }
  assert.match(sources[0], /timeLabel="Time Left"/);
  assert.doesNotMatch(sources[0], /Submit Module|submitLabel=/);
  assert.match(sources[0], /Questions \$\{displayRange\.start\}–\$\{displayRange\.end\} \/ \$\{moduleQuestionCount\}/);
});

test("only Reading question routes bypass the standard Student shell chrome", () => {
  const studentShell = fs.readFileSync(path.join(__dirname, "../components/student/StudentShell.tsx"), "utf8");
  assert.match(studentShell, /reading\\\/full-sets\\\/\[\^\/\]\+\\\/result/);
  assert.match(studentShell, /reading\\\/\(\?:results\|wrongbook-results\)/);
  assert.match(studentShell, /wrong-questions\\\/\(\?:today\|history\)\\\/reading\\\/practice/);
  assert.doesNotMatch(studentShell, /pathname\.startsWith\("\/student\/reading\/results\/"\)/);
});

test("readonly Reading pages scroll outside a fixed question viewport", () => {
  const source = fs.readFileSync(path.join(__dirname, "../components/reading/ReadingPractice.tsx"), "utf8");
  const ordinaryLoader = source.slice(
    source.indexOf("export function ReadingPractice"),
    source.indexOf("export function ReadingSubmittedReview")
  );
  const submittedReview = source.slice(
    source.indexOf("export function ReadingSubmittedReview"),
    source.indexOf("export function ReadingFullSetSubmittedReview")
  );
  const fullSetShell = source.slice(
    source.indexOf("function ReadingFullSetReviewShell"),
    source.indexOf("export function ReadingPracticeShell")
  );
  const practiceShell = source.slice(
    source.indexOf("export function ReadingPracticeShell"),
    source.indexOf("function ReadingPracticeHeader")
  );
  const twoColumnShell = source.slice(
    source.indexOf("function ReadingTwoColumnPracticeShell"),
    source.indexOf("function RdlPracticeWorkspace")
  );

  assert.doesNotMatch(ordinaryLoader, /document\.(body|documentElement)\.style\.overflow/);
  assert.doesNotMatch(submittedReview, /document\.(body|documentElement)\.style\.overflow/);
  assert.match(practiceShell, /readOnly \? "min-h-\[100dvh\]" : "h-\[100dvh\] overflow-hidden"/);
  assert.doesNotMatch(practiceShell, /layoutMode="natural"/);
  assert.match(practiceShell, /<ReadingQuestionViewport/);
  assert.match(fullSetShell, /min-h-\[100dvh\]/);
  assert.match(fullSetShell, /min-h-\[calc\(100dvh-var\(--reading-header-height\)\)\]/);
  assert.doesNotMatch(fullSetShell, /layoutMode="natural"/);
  assert.match(fullSetShell, /<ReadingQuestionViewport/);
  assert.match(fullSetShell, /readingQuestionNavigationTargets\([\s\S]*item\.occurrenceId[\s\S]*item\.questionId/);
  assert.doesNotMatch(fullSetShell, /onNext=\{\(\) => selectReviewItem\(activeIndex \+ 1\)\}/);
  assert.doesNotMatch(fullSetShell, /document\.(body|documentElement)\.style\.overflow/);
});

test("CTW, RDL, and RAP keep bounded content geometry without a bottom navigation bar", () => {
  const source = fs.readFileSync(path.join(__dirname, "../components/reading/ReadingPractice.tsx"), "utf8");
  const practiceShell = source.slice(
    source.indexOf("export function ReadingPracticeShell"),
    source.indexOf("function ReadingPracticeHeader")
  );
  const rdlSource = source.slice(
    source.indexOf("function RdlPracticeWorkspace"),
    source.indexOf("function sameRdlRect")
  );
  const rapSource = source.slice(
    source.indexOf("function RapPracticeWorkspace"),
    source.indexOf("function renderRapHighlightedText")
  );

  assert.match(practiceShell, /<ReadingQuestionViewport/);
  assert.doesNotMatch(practiceShell, /layoutMode="natural"/);
  assert.doesNotMatch(practiceShell, /border-t border-student-border/);
  assert.match(rdlSource, /naturalFlow \? "h-auto" : "h-full"/);
  assert.match(rdlSource, /object-contain/);
  assert.match(rdlSource, /overflow-hidden lg:min-h-0/);
  assert.match(rapSource, /naturalFlow[\s\S]*?\? "min-w-0"/);
  assert.match(rapSource, /question\.questionType === "rap_multiple_choice"/);
  assert.match(rapSource, /question\.questionType === "rap_sentence_insertion"/);
  assert.match(rapSource, /question\.questionType === "rap_sentence_selection"/);
});
