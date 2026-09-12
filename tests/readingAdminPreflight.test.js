const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const component = read("components/TeacherImportQuestions.tsx");
const route = read("app/api/teacher/import-questions/route.ts");
const readingImporter = read("app/api/teacher/import-questions/importers/reading.ts");

test("Reading upload starts with readonly preflight and resets it for a new file", () => {
  assert.match(component, /setResult\(null\)[\s\S]*file\.text\(\)/);
  assert.match(component, /dryRun: readingDryRun/);
  assert.match(component, /readingPreflightComplete \? "确认导入" : "开始预检"/);
});

test("Reading confirm import is hidden when preflight reports a blocker", () => {
  assert.match(component, /result\.rejectedRowCount[\s\S]*result\.occurrenceConflictCount[\s\S]*result\.blockerCount/);
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
  assert.match(component, /existingOccurrenceCount \?\? 0\) > 0[\s\S]*已存在来源/);
  assert.match(component, /possibleDuplicateCount \?\? 0\) > 0[\s\S]*需确认的相似题/);
  assert.match(component, /occurrenceConflictCount \?\? 0\) > 0[\s\S]*来源冲突/);
  assert.match(component, /rdlMaterialWarningCount \?\? 0\) > 0[\s\S]*需确认的相似素材/);
  assert.match(component, /tone="warning"/);
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
  assert.match(readingImporter, /if \(!dryRun\) \{\s*await importReadingPackageAtomic/);
  assert.doesNotMatch(readingImporter, /if \(dryRun\)[\s\S]{0,120}importReadingPackageAtomic/);
  assert.match(readingImporter, /allowRegisteredMaterialStorageKeys: type === "read_in_daily_life"/);
  assert.match(route, /if \(!result\.preview && result\.successCount > 0 && importedTaskType\)/);
});

test("preflight response separates duplicates, material warnings, rejections, conflicts, and blockers", () => {
  assert.match(readingImporter, /possibleDuplicateCount: possibleDuplicateWarnings\.length/);
  assert.match(readingImporter, /rdlMaterialWarningCount:/);
  assert.match(readingImporter, /rejectedRowCount,/);
  assert.match(readingImporter, /occurrenceConflictCount,/);
  assert.match(readingImporter, /blockerCount: failedRows\.length/);
});
