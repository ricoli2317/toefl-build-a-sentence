const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "components/import/ReadingContentConflictList.tsx"), "utf8");
const duplicate = fs.readFileSync(path.join(root, "components/import/ReadingDuplicateResolutionList.tsx"), "utf8");
const teacher = fs.readFileSync(path.join(root, "components/TeacherImportQuestions.tsx"), "utf8");

test("compact CTW review renders only DB canonical left and CSV source right", () => {
  const compact = content.slice(
    content.indexOf("function CompactQuestionConflict"),
    content.indexOf("function FullContentComparison")
  );
  assert.match(compact, /conflict\.ctwSlotConflicts/);
  assert.match(compact, /第 \{slot\.slotOrder\} 空内容不同/);
  assert.match(compact, /title="题库版本" segments=\{slot\.inlineDiff\.existing\}/);
  assert.match(compact, /title="来源 CSV" segments=\{slot\.inlineDiff\.incoming\}/);
  assert.doesNotMatch(content, /当前版本|另一来源版本|existingVersionOrigin/);
  assert.doesNotMatch(compact, /ctwPassage|ctwBlanks|displayText|missingLength|Ordered blanks|Correct answers/);
});

test("presentation-only CTW noise is filtered from duplicate review", () => {
  const view = fs.readFileSync(path.join(root, "lib/reading/duplicateResolutionView.ts"), "utf8");
  assert.match(view, /difference\.kind === "display"/);
  assert.match(view, /difference\.kind === "punctuation"/);
  assert.match(view, /difference\.kind === "whitespace"/);
  assert.match(view, /answerPairs\.has/);
});

test("review actions immediately follow compact differences and expose local selected state", () => {
  assert.ok(content.indexOf("<CompactQuestionConflict") < content.indexOf("保留题库版本"));
  assert.ok(duplicate.indexOf("<CompactDuplicateDifferences") < duplicate.indexOf("这是同一道题，归入题库版本"));
  for (const source of [content, duplicate]) {
    assert.match(source, /ring-2 ring-student-primary/);
    assert.match(source, /已选择：/);
    assert.match(source, /修改选择/);
  }
});

test("resolved reviews toggle independently and never expose whole-content dumps", () => {
  for (const source of [content, duplicate]) {
    assert.match(source, /const resolved = Boolean\(draft\.action\)/);
    assert.match(source, /const reviewExpanded = expandedReviewItems\.has\(item\.resolutionId\)/);
    assert.match(source, /resolved && !reviewExpanded/);
    assert.match(source, /重新查看/);
    assert.match(source, />收起<\/button>/);
    assert.match(source, /confirmResolution[\s\S]*collapseReviewItem\(resolutionId\)/);
    assert.match(source, /setExpandedReviewItems\(\(current\) => removeFromSet\(current, resolutionId\)\)/);
    assert.doesNotMatch(source, /expandedDetails|展开完整内容|收起完整内容/);
  }
  assert.doesNotMatch(content, /FullContentComparison|QuestionVersion|内部题目编号/);
  assert.doesNotMatch(duplicate, /FullDuplicateComparison|ReadingDuplicateDetail/);
  assert.match(content, /<mark/);
  assert.match(duplicate, /<mark/);
});

test("RDL duplicate review shows both material images with click-to-enlarge links", () => {
  assert.match(duplicate, /RdlMaterialComparison/);
  assert.match(duplicate, /题库已有素材/);
  assert.match(duplicate, /来源 CSV 素材/);
  assert.match(duplicate, /target="_blank"/);
  assert.match(duplicate, /object-contain/);
});

test("the combined Reading review area calculates live handled and pending progress", () => {
  assert.match(teacher, /readingReviewTotalCount = pendingResolutionItems\.length \+ contentConflictItems\.length/);
  assert.match(teacher, /readingReviewHandledCount = pendingResolutionItems\.filter/);
  assert.match(teacher, /待确认 \{readingReviewTotalCount - readingReviewHandledCount\} 项/);
  assert.match(teacher, /已处理 \{readingReviewHandledCount\} \/ \{readingReviewTotalCount\}/);
});
