const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  assignmentPracticeBadgeForEntry,
  assignmentPracticeFullSetBadge,
  assignmentPracticeItemIsCompleted,
  assignmentPracticeStatusKey,
  assignmentPracticeStatusRecord
} = require("../lib/assignmentPracticeStatus.ts");
const {
  assignmentSubjectsForClassSubjects,
  assignmentSubjectsForStudents
} = require("../lib/teacherClasses.ts");
const { ASSIGNMENT_SUBJECTS } = require("../lib/assignmentCatalog.ts");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const FORM = "components/teacher/TeacherWritingAssignmentForm.tsx";
const PICKER = "components/teacher/TeacherAssignmentCatalogPicker.tsx";
const PICKER_HOOK = "components/teacher/useAssignmentPracticeStatus.ts";
const STUDENTS_ROUTE = "app/api/teacher/writing/assignments/students/route.ts";
const STATUS_ROUTE = "app/api/teacher/writing/assignments/practice-status/route.ts";
const STATUS_SERVER = "lib/assignmentPracticeStatus.server.ts";

// ---------------------------------------------------------------------------
// 1. Recipient-first subject permissions
// ---------------------------------------------------------------------------

test("selected students only offer the intersection of their subject bindings", () => {
  assert.deepEqual(
    assignmentSubjectsForStudents([
      { domains: ["reading", "writing"] },
      { domains: ["reading"] }
    ]),
    ["reading"]
  );
  assert.deepEqual(
    assignmentSubjectsForStudents([
      { domains: ["reading"] },
      { domains: ["writing"] }
    ]),
    []
  );
  assert.deepEqual(
    assignmentSubjectsForStudents([
      { domains: ["reading"] },
      { domains: ["reading"] },
      { domains: ["reading", "writing"] }
    ]),
    ["reading"]
  );
  assert.deepEqual(
    assignmentSubjectsForStudents([{ domains: [] }]),
    []
  );
  // No recipient selected yet: step 2 is not restricted.
  assert.deepEqual(assignmentSubjectsForStudents([]), [...ASSIGNMENT_SUBJECTS]);
});

test("class mode only offers the acting teacher's own subjects in that class", () => {
  assert.deepEqual(assignmentSubjectsForClassSubjects(["reading"]), ["reading"]);
  assert.deepEqual(assignmentSubjectsForClassSubjects(["writing"]), ["writing"]);
  assert.deepEqual(
    assignmentSubjectsForClassSubjects(["reading", "writing"]),
    ["writing", "reading"]
  );
  assert.deepEqual(assignmentSubjectsForClassSubjects([]), []);
  // Another teacher's subjects never widen the list: the summary subjects are
  // already the viewing teacher's own set.
  const form = source(FORM);
  assert.match(form, /assignmentSubjectsForClassSubjects\(selectedClass\.subjects\)/);
  assert.match(form, /assignmentSubjectsForClassSubjects\(classEntry\.subjects\)/);
});

test("the wizard starts with 学生／班级 and only then shows 科目", () => {
  const form = source(FORM);
  const recipients = form.indexOf('StepCard number="1" title="选择学生／班级"');
  const subject = form.indexOf('StepCard number="2" title="选择科目"');
  const content = form.indexOf('stepNumbers.get("kind")');
  const sourceStep = form.indexOf('stepNumbers.get("source")');
  const items = form.indexOf('stepNumbers.get("items")');
  const title = form.indexOf('stepNumbers.get("title")');
  const due = form.indexOf('stepNumbers.get("due")');
  const preview = form.indexOf('stepNumbers.get("preview")');
  assert.ok(recipients > 0, "step 1 must be the recipient selection");
  assert.ok(subject > recipients, "step 2 must be the subject");
  assert.ok(content > subject, "step 3 must be the content kind");
  assert.ok(sourceStep > content, "step 4 must be the question source");
  assert.ok(items > sourceStep, "step 5 must be the question configuration");
  assert.ok(title > items, "step 6 must be the Assignment title");
  assert.ok(due > title, "step 7 must be the deadline");
  assert.ok(preview > due, "step 8 must be the preview");
  // The recipient selection lists every visible student and every bound class.
  assert.match(form, /useTeacherCachedData<\{ students: StudentOption\[\] \}>/);
  assert.match(form, /teacherAssignmentStudentsCacheKey\(\)/);
  assert.match(form, /filterClassSummariesByName\(allClasses, classQuery\)/);
  assert.match(form, /allClasses\.length > 0/);
  assert.doesNotMatch(form, /classesForAssignmentSubject/);
  // Student mode stays multi-select; class mode stays single-select.
  assert.match(form, /selectedStudents\.includes\(studentId\)/);
  assert.match(form, /一次只能选择一个班级/);
  assert.match(form, /selectedClassId === classId \? "" : classId/);
  assert.match(form, /disabled=\{!recipientSelected\}/);
  assert.match(form, /\{NO_COMMON_ASSIGNMENT_SUBJECT_MESSAGE\}/);
});

test("the student endpoint returns every bound student with their domains", () => {
  const route = source(STUDENTS_ROUTE);
  assert.match(route, /loadTeacherScope/);
  assert.match(route, /visibleStudentIds/);
  assert.match(route, /domains: scope\.studentDomains\.get\(studentId\) \?\? \[\]/);
  assert.doesNotMatch(route, /searchParams\.get\("subject"\)/);
  assert.doesNotMatch(route, /listVisibleStudentIds\([\s\S]*?"reading"/);
});

test("recipient changes re-evaluate the subject and confirm before clearing content", () => {
  const form = source(FORM);
  assert.match(form, /function subjectsForStudents\(/);
  assert.match(form, /function subjectsForClass\(/);
  assert.match(form, /const invalidatesSubject = Boolean\(subject\) && !nextSubjects\.includes\(subject!\)/);
  assert.match(form, /if \(!confirmSelectionChange\(nextSubjects, "学生选择"\)\) return;/);
  assert.match(form, /if \(!confirmSelectionChange\(nextSubjects, "班级选择"\)\) return;/);
  assert.match(form, /window\.confirm\(/);
  assert.match(form, /已选题目和自定义题将被清空/);
  assert.match(form, /clearInvalidSubjectState/);
  assert.match(form, /setCustomQuestions\(\[\]\)/);
  // A valid subject keeps the current selection and custom drafts untouched.
  const toggleStudent = form.slice(
    form.indexOf("function toggleStudent("),
    form.indexOf("function chooseSelectionMode(")
  );
  const invalidCheck = toggleStudent.indexOf("const invalidatesSubject");
  const clear = toggleStudent.indexOf("clearInvalidSubjectState()");
  assert.ok(invalidCheck > 0 && clear > invalidCheck);
  assert.doesNotMatch(toggleStudent.slice(clear + 30), /setSelection\(new Map\(\)\)/);
});

test("deep links and withdrawn edits preselect the original recipients", () => {
  const form = source(FORM);
  assert.match(form, /initialClassId \? "class" : "students"/);
  assert.match(form, /useState\(initialClassId \?\? ""\)/);
  assert.match(form, /seed\.students\.length > 0 \? seed\.students : initialStudentId \? \[initialStudentId\] : \[\]/);
  // The seed keeps the original subject, item selection and class.
  assert.match(form, /const subject = assignments\.length > 0[\s\S]{0,80}assignmentItemSubject\(assignments\[0\]\.task_type\)/);
  assert.match(form, /initialCollection\?\.assignments\[0\]\?\.class_id/);
  assert.match(form, /selection\.set\(key, entry\)/);
});

// ---------------------------------------------------------------------------
// 2. Practice badge predicates
// ---------------------------------------------------------------------------

test("a completed attempt always counts even when the student is redoing the item", () => {
  assert.equal(assignmentPracticeItemIsCompleted({ latest_completed_attempt_id: null, last_completed_at: null }), false);
  assert.equal(assignmentPracticeItemIsCompleted({ latest_completed_attempt_id: null, last_completed_at: "2026-09-01T00:00:00Z" }), true);
  assert.equal(assignmentPracticeItemIsCompleted({ latest_completed_attempt_id: "attempt-1", last_completed_at: null }), true);
  // in_progress status itself is irrelevant: the completed identity remains.
  assert.equal(assignmentPracticeItemIsCompleted({ latest_completed_attempt_id: "attempt-1", last_completed_at: "2026-09-01T00:00:00Z" }), true);
});

test("a plain item is 已练习 when any selected student completed it", () => {
  const statuses = assignmentPracticeStatusRecord([
    { item_id: "item-1", item_type: "email", status: "practiced" },
    { item_id: "reading-rap-1", item_type: "rap", status: "practiced" }
  ]);
  assert.equal(assignmentPracticeStatusKey("email", "item-1"), "email:item-1");
  assert.equal(
    assignmentPracticeBadgeForEntry({ item_id: "item-1", item_type: "email" }, statuses),
    "practiced"
  );
  assert.equal(
    assignmentPracticeBadgeForEntry({ item_id: "item-2", item_type: "email" }, statuses),
    null
  );
  assert.equal(
    assignmentPracticeBadgeForEntry({ item_id: "reading-rap-1", item_type: "rap" }, statuses),
    "practiced"
  );
});

test("Full Set badge follows its real constituent logical items", () => {
  const fullSetId = "20260902A";
  const constituents = ["reading-ctw-1", "reading-rdl-1", "reading-rap-1"];
  const badge = (completed, completedFullSets = []) => assignmentPracticeFullSetBadge({
    completedFullSetIds: new Set(completedFullSets),
    completedItemIds: new Set(completed),
    constituentItemIds: constituents,
    fullSetId
  });

  assert.equal(badge([]), null);
  assert.equal(badge([], [fullSetId]), "practiced");
  assert.equal(badge(["reading-ctw-1"]), "partial");
  assert.equal(badge(["reading-ctw-1", "reading-rdl-1"]), "partial");
  assert.equal(badge(constituents), "practiced");
  // Duplicate definitions never inflate the required coverage.
  assert.equal(
    assignmentPracticeFullSetBadge({
      completedFullSetIds: new Set(),
      completedItemIds: new Set(constituents),
      constituentItemIds: [...constituents, ...constituents],
      fullSetId
    }),
    "practiced"
  );
  // A Full Set with no resolvable constituent can never be guessed.
  assert.equal(
    assignmentPracticeFullSetBadge({
      completedFullSetIds: new Set(),
      completedItemIds: new Set(constituents),
      constituentItemIds: [],
      fullSetId
    }),
    null
  );
});

test("the union of different students can cover a Full Set", () => {
  const fullSetId = "20260902A";
  const constituents = ["reading-ctw-1", "reading-rdl-1", "reading-rap-1"];
  // Student A completed CTW + RAP; student B completed RDL. The server merges
  // both identities before this call.
  const classUnion = ["reading-ctw-1", "reading-rap-1", "reading-rdl-1"];
  assert.equal(
    assignmentPracticeFullSetBadge({
      completedFullSetIds: new Set(),
      completedItemIds: new Set(classUnion),
      constituentItemIds: constituents,
      fullSetId
    }),
    "practiced"
  );
  // One student's single item still stays 部分练习.
  assert.equal(
    assignmentPracticeFullSetBadge({
      completedFullSetIds: new Set(),
      completedItemIds: new Set(["reading-rap-1"]),
      constituentItemIds: constituents,
      fullSetId
    }),
    "partial"
  );
});

test("the same canonical reading item is recognized across different Full Sets", () => {
  const shared = "reading-rdl-shared";
  const first = assignmentPracticeFullSetBadge({
    completedFullSetIds: new Set(),
    completedItemIds: new Set([shared]),
    constituentItemIds: [shared, "reading-ctw-a"],
    fullSetId: "20260902A"
  });
  const second = assignmentPracticeFullSetBadge({
    completedFullSetIds: new Set(),
    completedItemIds: new Set([shared]),
    constituentItemIds: [shared, "reading-rap-b"],
    fullSetId: "20260903A"
  });
  assert.equal(first, "partial");
  assert.equal(second, "partial");
});

// ---------------------------------------------------------------------------
// 3. Data sources / performance contract
// ---------------------------------------------------------------------------

test("practice state is read in batches from the indexed sparse state", () => {
  const server = source(STATUS_SERVER);
  assert.match(server, /from\("student_practice_item_state"\)/);
  assert.match(server, /\.in\("student_id", batch\)/);
  assert.match(server, /\.in\("task_type", \[\.\.\.taskTypes\]\)/);
  assert.match(server, /\.not\("latest_completed_attempt_id", "is", null\)/);
  assert.match(server, /chunkValues/);
  // No per-item request: the item filter only appears on the canonical source
  // lookup, never as a query inside a catalog-item loop.
  assert.doesNotMatch(server, /for \(const item of .*catalog/i);
  assert.doesNotMatch(server, /from\("student_practice_item_state"\)[\s\S]{0,120}\.eq\("item_id"/);
});

test("assigned Writing work is added through the canonical source mapping", () => {
  const server = source(STATUS_SERVER);
  assert.match(server, /\.from\("writing_attempts"\)/);
  assert.match(server, /\.eq\("status", "submitted"\)/);
  assert.match(server, /\.eq\("attempt_kind", "original"\)/);
  assert.match(server, /\.not\("assignment_id", "is", null\)/);
  assert.match(server, /from\("practice_item_sources"\)/);
  assert.match(server, /source_question_id/);
  assert.match(server, /taskType: "email" \| "academic_discussion"/);
});

test("Full Sets are expanded to their real logical items, not by question id or date", () => {
  const server = source(STATUS_SERVER);
  assert.match(server, /loadReadingFullSetDefinitions/);
  assert.match(server, /occurrence\.logicalItemId/);
  assert.match(server, /occurrence\.sourceModule === "m1"/);
  assert.match(server, /submittedModule\.module_number/);
  assert.match(server, /fullyCompletedReadingItemIds/);
  assert.match(server, /assignmentPracticeFullSetBadge/);
  assert.doesNotMatch(server, /occurrenceDate.*new Map|question_id.*full_set/);
  // Reading ordinary identity is the logical item id.
  assert.match(server, /reading_attempts[\s\S]{0,200}logical_item_id/);
});

test("category and wrongbook corrections mark practiced but cannot complete a Full Set", () => {
  const server = source(STATUS_SERVER);
  assert.match(server, /reading_question_category_sessions/);
  assert.match(server, /reading_question_category_session_answers/);
  assert.match(server, /reading_wrongbook_attempts/);
  assert.match(server, /reading_wrongbook_attempt_answers/);
  assert.match(server, /if \(readingModule\) addPracticed\(readingModule, row\.logical_item_id\)/);
  // Only the explicit fully-completed reading set is compared for Full Sets.
  assert.match(server, /buildStatusEntries\(\s*practicedItems,\s*fullSets,\s*fullyCompletedReadingItemIds,/);
});

test("the status route validates the class / students and never returns un-practiced on failure", () => {
  const route = source(STATUS_ROUTE);
  assert.match(route, /requireWritingAssignmentTeacher/);
  assert.match(route, /loadTeacherClassForAssignment\([\s\S]*?subject/);
  assert.match(route, /from\("class_members"\)/);
  assert.match(route, /scope\.readingStudentIds : scope\.writingStudentIds/);
  assert.match(route, /eligibleStudentIds\.has\(studentId\)/);
  assert.match(route, /code: "INVALID_STUDENTS"/);
  assert.match(route, /code: "ASSIGNMENT_PRACTICE_STATUS_FAILED"/);
  assert.match(route, /status: 500/);
  assert.match(route, /statuses/);
  // Read-only: no attempt / state mutation.
  assert.doesNotMatch(route, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  const server = source(STATUS_SERVER);
  assert.doesNotMatch(server, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
});

test("a stale practice-status response can never decorate the new selection", () => {
  const hook = source(PICKER_HOOK);
  assert.match(hook, /const generation = useRef\(0\)/);
  assert.match(hook, /const requestId = generation\.current \+ 1/);
  assert.match(hook, /generation\.current !== requestId/);
  assert.match(hook, /AbortController/);
  assert.match(hook, /data\.key === requestKey \? data\.statuses : \{\}/);
  assert.match(hook, /failure\?\.key === requestKey/);
  assert.match(hook, /current\.key === requestKey \? \{ key: "", statuses: \{\} \} : current/);
  assert.match(hook, /练习状态加载失败/);
});

// ---------------------------------------------------------------------------
// 4. Badge UI
// ---------------------------------------------------------------------------

test("the picker renders 已练习 / 部分练习 between the title and 查看题目", () => {
  const picker = source(PICKER);
  assert.match(picker, /assignmentPracticeBadgeForEntry\(entry, input\.practiceStatuses\)/);
  assert.match(picker, /practiceBadge === "practiced" \? "已练习" : "部分练习"/);
  assert.match(picker, /data-assignment-practice-badge=\{practiceBadge\}/);
  assert.match(picker, /border-emerald-200/);
  assert.match(picker, /bg-emerald-50/);
  assert.match(picker, /text-emerald-700/);
  assert.match(picker, /border-amber-200/);
  assert.match(picker, /bg-amber-50/);
  assert.match(picker, /text-amber-700/);
  const row = picker.slice(
    picker.indexOf("function renderSelectableRow("),
    picker.indexOf("function assignmentPracticeBadgeClass(")
  );
  const titleEnd = row.indexOf("{index + 1}. {entry.title}");
  const badge = row.indexOf("data-assignment-practice-badge");
  const viewer = row.indexOf("查看题目");
  assert.ok(titleEnd > 0 && badge > titleEnd && viewer > badge, "badge order");
  // The badge is display-only: no extra input or link and no hover stats.
  assert.doesNotMatch(picker, /完成率|完成人数|练习次数|FS 进度/);
  assert.doesNotMatch(picker, /title=\{.*练习/);
  assert.doesNotMatch(picker, /<button[^>]*>已练习/);
  // The existing row density is preserved.
  assert.match(picker, /<li className="flex min-h-10 items-center gap-3 bg-white px-4 py-2"/);
  assert.match(row, /<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">/);
  assert.match(row, /<input[\s\S]*?type="checkbox"/);
  assert.match(row, /全选当前页|renderSelectableRow/);
});

test("badges never join selection, filtering or pagination", () => {
  const picker = source(PICKER);
  assert.match(picker, /setAssignmentCatalogPageSelection\(selection, pageData\.items, event\.target\.checked\)/);
  assert.match(picker, /filterAssignmentCatalogEntries\(entries, \{/);
  assert.match(picker, /paginateAssignmentCatalogEntries\(filteredEntries, filters\.page/);
  assert.doesNotMatch(picker, /practiceStatuses.*setSelection|setSelection.*practiceStatuses/);
  assert.doesNotMatch(picker, /practiceError.*(query|month|topic|length|page)\(/);
  // A failed state load is explicit; it is never rendered as 未练习.
  assert.match(picker, /practiceError \? \(/);
  assert.match(picker, /未标记的题目不代表没有练习过/);
  assert.match(picker, /练习状态加载中/);
  assert.doesNotMatch(picker, /未练习/);
});
