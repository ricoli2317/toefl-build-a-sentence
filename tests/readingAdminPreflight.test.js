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
  assert.match(component, /预检未通过：存在 rejected、occurrence conflict 或 blocker/);
});

test("Reading preflight exposes common metrics and RDL material metrics", () => {
  for (const label of [
    "CSV 行数",
    "Accepted",
    "Rejected",
    "Occurrences",
    "新逻辑题",
    "严格指纹复用",
    "语义复用",
    "新增来源记录",
    "已有相同来源",
    "来源冲突",
    "可能重复（warning）",
    "Blockers",
    "RDL 素材复用",
    "RDL 新素材",
    "RDL 素材警告"
  ]) assert.match(component, new RegExp(label.replace(/[（）]/g, ".")));
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
