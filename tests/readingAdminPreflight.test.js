const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const component = read("components/TeacherImportQuestions.tsx");
const route = read("app/api/teacher/import-questions/route.ts");
const readingImporter = read("app/api/teacher/import-questions/importers/reading.ts");
const resolutionComponent = read("components/import/ReadingDuplicateResolutionList.tsx");
const resolutionModel = read("lib/reading/duplicateResolutionModel.ts");

test("Reading upload starts with readonly preflight and resets it for a new file", () => {
  assert.match(component, /setResult\(null\)[\s\S]*file\.text\(\)/);
  assert.match(component, /dryRun: readingDryRun/);
  assert.match(component, /readingPreflightComplete[\s\S]*"确认导入"[\s\S]*"开始预检"/);
});

test("Reading confirm import is hidden when preflight reports a blocker", () => {
  assert.match(component, /result\.rejectedRowCount[\s\S]*result\.occurrenceConflictCount[\s\S]*result\.unableToImportCount/);
  assert.match(component, /!readingPreflightBlocked \? \([\s\S]*<button/);
  assert.match(component, /预检未通过。请修正无法导入的内容或来源冲突/);
});

test("Reading preflight exposes only product-facing summary metrics", () => {
  for (const label of [
    "本次题组",
    "复用已有题目",
    "新增题目",
    "新增来源",
    "已存在来源",
    "需确认的相似题",
    "来源冲突",
    "无法导入",
    "复用已有素材",
    "新增素材",
    "需确认的相似素材"
  ]) assert.match(component, new RegExp(label.replace(/[（）]/g, ".")));
  for (const internalLabel of [
    "CSV 行数",
    "Accepted",
    "Rejected",
    "Occurrences",
    "严格指纹复用",
    "语义复用",
    "Blockers"
  ]) assert.doesNotMatch(component, new RegExp(`label="${internalLabel}`));
  assert.match(component, /exactFingerprintReuseCount[\s\S]*semanticReuseCount/);
});

test("Reading warnings and errors only render when their count is positive", () => {
  assert.match(component, /readingExistingOccurrenceCount > 0[\s\S]*已存在来源/);
  assert.match(component, /unresolvedReadingDuplicateCount > 0[\s\S]*需确认的相似题/);
  assert.match(component, /occurrenceConflictCount \?\? 0\) > 0[\s\S]*来源冲突/);
  assert.match(component, /unresolvedRdlMaterialWarningCount > 0[\s\S]*需确认的相似素材/);
  assert.match(component, /tone="warning"/);
  assert.match(component, /warning\.operation === "check Reading possible duplicates"[\s\S]*return warning\.message/);
});

test("CSV format errors are concise and never expose the complete required schema", () => {
  assert.match(component, /CSV 格式不正确/);
  assert.match(component, /缺少字段：/);
  assert.match(component, /存在不属于该题型的字段：/);
  assert.doesNotMatch(component, /最接近的格式：/);
  assert.doesNotMatch(component, /closestSchema\.schema\.join/);
  assert.match(component, /payload\.code === "CSV_HEADER_MISMATCH"\) return "CSV 格式不正确"/);
});

test("Reading dry-run never calls the atomic write path or cache revalidation", () => {
  assert.match(readingImporter, /if \(!dryRun\) \{[\s\S]*?await importReadingPackageAtomic/);
  assert.doesNotMatch(readingImporter, /if \(dryRun\)[\s\S]{0,120}importReadingPackageAtomic/);
  assert.match(readingImporter, /allowRegisteredMaterialStorageKeys: type === "read_in_daily_life"/);
  assert.match(route, /if \(!result\.preview && result\.successCount > 0 && importedTaskType\)/);
});

test("preflight response separates duplicates, material warnings, rejections, conflicts, and blockers", () => {
  assert.match(readingImporter, /possibleDuplicateCount: dryRun \? pendingResolutionItems\.length : 0/);
  assert.match(readingImporter, /rdlMaterialWarningCount:/);
  assert.match(readingImporter, /rejectedRowCount,/);
  assert.match(readingImporter, /occurrenceConflictCount,/);
  assert.match(readingImporter, /blockerCount: issueSummary\.unableToImportCount/);
  assert.match(readingImporter, /actualImportErrorCount: issueSummary\.actualImportErrorCount/);
  assert.match(readingImporter, /action=block pending review/);
  assert.doesNotMatch(readingImporter, /action=preserve as new/);
  assert.match(readingImporter, /unresolvedReviews\.length > 0[\s\S]*不能正式导入/);
  assert.doesNotMatch(readingImporter, /if \(possibleDuplicateWarnings\.length > 0\)/);
  assert.match(readingImporter, /contentConflictCount: dryRun \? contentConflictItems\.length : 0/);
  assert.match(readingImporter, /READING_CONTENT_CONFLICT_REQUIRED/);
  assert.doesNotMatch(readingImporter, /已保留题库题目与答案/);
  assert.match(readingImporter, /已稳定复用最早题目/);
});

test("Reading duplicate cards collect every resolution and send it only with final import", () => {
  assert.match(resolutionComponent, /function ReadingDuplicateResolutionList/);
  assert.match(resolutionComponent, /需要判断的实际差异/);
  assert.match(resolutionComponent, /这是同一道题，归入题库版本/);
  assert.match(resolutionComponent, /不是同一道题，保留为新题/);
  assert.match(resolutionComponent, /题库版本/);
  assert.match(resolutionComponent, /来源 CSV/);
  assert.match(resolutionComponent, /difference\.incoming/);
  assert.match(resolutionComponent, /difference\.existing/);
  assert.match(resolutionComponent, /展开完整内容/);
  assert.match(resolutionComponent, /重新查看/);
  assert.match(resolutionComponent, /已选择：/);
  assert.match(component, /readingDuplicateResolutions: readingDryRun[\s\S]*resolutionId:[\s\S]*questionType:[\s\S]*logicalItemId/);
  assert.match(component, /readingHasUnresolvedDuplicates[\s\S]*disabled=/);
  assert.match(component, /仍有.*项相似题未处理/);
});

test("Reading possible duplicates are pending decisions, not failed groups", () => {
  assert.match(readingImporter, /filter\(\(prepared\) => !reviewPlans\.some/);
  assert.match(readingImporter, /pendingResolutionItems: dryRun \? pendingResolutionItems : \[\]/);
  assert.match(readingImporter, /failedCount: issueSummary\.unableToImportCount/);
  assert.match(readingImporter, /assertReadingUnableToImportDetailInvariant/);
  assert.doesNotMatch(readingImporter, /throw new Error\("发现需确认的相似题；明确处理前不能导入为新题。"\)/);
});

test("one pending list controls rendering and enforces the flag/list invariant", () => {
  assert.match(component, /pendingResolutionItems\.length > 0[\s\S]*<ReadingDuplicateResolutionList/);
  assert.doesNotMatch(component, /questionType === "complete_the_words"[\s\S]{0,120}<ReadingDuplicateResolutionList/);
  assert.match(component, /assertReadingPendingResolutionInvariant/);
  assert.match(readingImporter, /assertReadingPendingResolutionInvariant/);
  assert.match(resolutionModel, /hasPendingDuplicates && input\.pendingResolutionItems\.length === 0/);
});

test("shared confirmation shell keeps full Reading content folded behind one detail component", () => {
  assert.match(resolutionComponent, /function ReadingDuplicateDetail/);
  assert.match(resolutionComponent, /preview\.questionType === "ctw"/);
  assert.match(resolutionComponent, /preview\.questionType === "rdl"/);
  assert.match(resolutionComponent, /FullDuplicateComparison/);
  assert.match(resolutionComponent, /expanded\.has\(item\.resolutionId\)/);
});

test("RDL preflight explains registered-material reuse with a first logical question set", () => {
  assert.match(readingImporter, /rdlGroupDecisions/);
  assert.match(component, /RDL 素材与题组明细/);
  assert.match(component, /素材判定/);
  assert.match(component, /题组判定/);
  assert.match(component, /matchedMaterialId/);
  assert.match(component, /matchedLogicalItemId/);
  assert.match(component, /item\.reason/);
});
