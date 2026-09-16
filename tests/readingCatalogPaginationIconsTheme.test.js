const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildReadingFullSetCatalog,
  buildReadingFullSets
} = require("../lib/reading/fullSets.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function jsonFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(target) : entry.name.endsWith(".json") ? [target] : [];
  }).sort();
}

function repositoryFullSetCatalog() {
  const inputs = jsonFiles(path.join(root, "data/reading/import-packages")).flatMap((file) => {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data.occurrences.map((occurrence) => ({
      occurrenceId: occurrence.occurrenceId,
      logicalItemId: occurrence.logicalItemId,
      taskType: data.item.module,
      occurrenceDate: occurrence.occurrenceDate,
      sourceLabel: occurrence.sourceLabel,
      sourceModule: occurrence.sourceModule,
      sourceOrder: occurrence.sourceOrder,
      sourceQuestionStart: occurrence.sourceQuestionStart,
      sourceQuestionEnd: occurrence.sourceQuestionEnd,
      scoringPointCount: data.item.scoredItemCount
    }));
  });
  return buildReadingFullSetCatalog(buildReadingFullSets(inputs));
}

test("Full Set data produces ten-item, gap-free catalog pages", () => {
  const catalog = repositoryFullSetCatalog();
  assert.ok(catalog.length > 11);
  const first = catalog.slice(0, 10);
  const second = catalog.slice(10, 20);
  assert.equal(first.length, 10);
  assert.equal(second.length, 10);
  assert.equal(new Set([...first, ...second].map((item) => item.fullSetId)).size, 20);
  assert.deepEqual(
    [...first, ...second].map((item) => item.fullSetId),
    catalog.slice(0, 20).map((item) => item.fullSetId)
  );
});

test("Full Set API validates before pagination and counts only usable sets", () => {
  const route = read("app/api/reading/full-sets/route.ts");
  const server = read("lib/reading/fullSets.server.ts");
  assert.match(route, /searchParams\.get\("page"\)/);
  assert.match(route, /searchParams\.get\("limit"\)/);
  assert.match(route, /limit !== 10/);
  assert.match(server, /READING_FULL_SET_CATALOG_PAGE_SIZE = 10/);
  assert.match(server, /buildReadingFullSetCatalog\(buildReadingFullSets\(/);
  assert.match(server, /catalog\.slice\(from, from \+ READING_FULL_SET_CATALOG_PAGE_SIZE\)/);
  assert.match(server, /total: catalog\.length/);
  assert.match(server, /\.in\("full_set_id", fullSetIds\)/);
  assert.doesNotMatch(server, /count: "exact"|catalog anchors/);
  assert.doesNotMatch(route, /loadReadingFullSets|readAllSupabaseRows/);
});

test("catalog and sidebar icon shapes share the canonical practice icon map", () => {
  const icons = read("components/icons/StudentPracticeIcons.ts");
  const shell = read("components/student/StudentShell.tsx");
  const reading = read("components/reading/ReadingCatalog.tsx");
  const fullSet = read("components/reading/ReadingFullSetCatalog.tsx");
  const logical = read("components/LogicalPracticeCatalog.tsx");
  const writing = read("components/writing/WritingCatalog.tsx");
  const wrongbook = read("components/WrongQuestionsHome.tsx");

  assert.match(icons, /ctw: CompleteTheWordsIcon/);
  assert.match(icons, /rdl: FileText/);
  assert.match(icons, /rap: BookOpen/);
  assert.match(icons, /build_sentence: Puzzle/);
  assert.match(icons, /email: Mail/);
  assert.match(icons, /academic_discussion: MessageCircleMore/);
  assert.match(icons, /full_set: Library/);
  assert.match(shell, /icon: STUDENT_PRACTICE_ICONS\.full_set/);
  assert.match(wrongbook, /full_set: STUDENT_PRACTICE_ICONS\.full_set/);
  assert.match(reading, /icon: STUDENT_PRACTICE_ICONS\[item\.taskType\]/);
  assert.match(fullSet, /icon: STUDENT_PRACTICE_ICONS\.full_set/);
  assert.match(logical, /icon: STUDENT_PRACTICE_ICONS\[item\.task_type\]/);
  assert.match(writing, /icon: STUDENT_PRACTICE_ICONS\[taskType\]/);
});

test("Reading theme is blue-scoped and Reading code has no direct purple or violet styling", () => {
  const css = read("app/globals.css");
  const layout = read("app/student/reading/layout.tsx");
  const practice = read("components/reading/ReadingPractice.tsx");
  const readingFiles = [
    ...walkSourceFiles(path.join(root, "components/reading")),
    ...walkSourceFiles(path.join(root, "app/student/reading"))
  ];
  const source = readingFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");

  assert.match(layout, /className="reading-theme"/);
  assert.match(css, /\.reading-theme\s*\{[\s\S]*--student-primary: #347fdc;[\s\S]*--student-primary-hover: #2d70c5;[\s\S]*--student-primary-soft: #eff6ff;[\s\S]*--student-primary-border: #bfdbfe;/);
  assert.match(practice, /bg-blue-400\/30/);
  assert.doesNotMatch(source, /purple-|violet-|rgba\((?:107,\s*92,\s*246|60,\s*47,\s*119|109,\s*40,\s*217)|#(?:6b5cf6|5748e8|f2f0ff|ddd8ff)/i);
});

function walkSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkSourceFiles(target);
    return /\.(?:ts|tsx|css)$/.test(entry.name) ? [target] : [];
  });
}
