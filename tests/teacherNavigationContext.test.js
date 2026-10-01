const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  parseTeacherStudentChildReturnTo,
  parseTeacherStudentReturnTo,
  safeTeacherReturnTo,
  teacherAssignmentsListHref,
  teacherClassIdFromReturnTo,
  teacherReturnToHref,
  teacherSetDetailsReturnHref,
  teacherStudentChildCrumbs,
  teacherStudentDetailCrumbs,
  TEACHER_ASSIGNMENTS_HREF,
  TEACHER_HOME_CLASSES_HREF,
  TEACHER_HOME_HREF,
  TEACHER_STUDENTS_HREF
} = require("../lib/teacherNavigation.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const CLASS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const STUDENT_ID = "11111111-2222-3333-4444-555555555555";

test("safeTeacherReturnTo accepts only internal teacher routes", () => {
  assert.equal(
    safeTeacherReturnTo(TEACHER_HOME_CLASSES_HREF, TEACHER_HOME_HREF),
    TEACHER_HOME_CLASSES_HREF
  );
  assert.equal(
    safeTeacherReturnTo(`/teacher/classes/${CLASS_ID}`, TEACHER_HOME_HREF),
    `/teacher/classes/${CLASS_ID}`
  );
  assert.equal(
    safeTeacherReturnTo(`${TEACHER_ASSIGNMENTS_HREF}?view=class&classId=${CLASS_ID}`, TEACHER_HOME_HREF),
    `${TEACHER_ASSIGNMENTS_HREF}?view=class&classId=${CLASS_ID}`
  );
  // The hash never travels with the return target.
  assert.equal(
    safeTeacherReturnTo("/teacher/dashboard#anchor", TEACHER_HOME_HREF),
    "/teacher/dashboard"
  );
  for (const unsafe of [
    "https://example.com",
    "//example.com",
    "javascript:alert(1)",
    "/student/assignments",
    "/admin/student-bindings",
    "/teacher/unknown",
    "/teacher/../student/assignments",
    "\\\\teacher\\dashboard",
    "",
    null,
    undefined,
    7
  ]) {
    assert.equal(
      safeTeacherReturnTo(unsafe, TEACHER_HOME_HREF),
      TEACHER_HOME_HREF,
      `${String(unsafe)} must fall back to the canonical parent`
    );
  }
});

test("teacherReturnToHref appends only validated contexts", () => {
  assert.equal(
    teacherReturnToHref(TEACHER_ASSIGNMENTS_HREF, `${TEACHER_ASSIGNMENTS_HREF}?view=class&classId=${CLASS_ID}`),
    `${TEACHER_ASSIGNMENTS_HREF}?returnTo=${encodeURIComponent(`${TEACHER_ASSIGNMENTS_HREF}?view=class&classId=${CLASS_ID}`)}`
  );
  assert.equal(
    teacherReturnToHref("/teacher/students/x", "https://evil.example"),
    "/teacher/students/x"
  );
  assert.equal(
    teacherReturnToHref("/teacher/students/x", "/teacher/students/x"),
    "/teacher/students/x"
  );
  // Nested contexts keep their own encoded query intact.
  const nested = `${TEACHER_STUDENTS_HREF}/${STUDENT_ID}?returnTo=${encodeURIComponent(`/teacher/classes/${CLASS_ID}`)}`;
  assert.equal(
    teacherReturnToHref(`/teacher/writing/reviews/attempt-1`, nested),
    `/teacher/writing/reviews/attempt-1?returnTo=${encodeURIComponent(nested)}`
  );
});

test("assignments list href mirrors the tab and filter state", () => {
  assert.equal(
    teacherAssignmentsListHref({ view: "students" }),
    TEACHER_ASSIGNMENTS_HREF
  );
  assert.equal(
    teacherAssignmentsListHref({ view: "students", studentId: STUDENT_ID }),
    `${TEACHER_ASSIGNMENTS_HREF}?studentId=${STUDENT_ID}`
  );
  assert.equal(
    teacherAssignmentsListHref({ view: "class" }),
    `${TEACHER_ASSIGNMENTS_HREF}?view=class`
  );
  assert.equal(
    teacherAssignmentsListHref({ view: "class", classId: CLASS_ID }),
    `${TEACHER_ASSIGNMENTS_HREF}?view=class&classId=${CLASS_ID}`
  );
});

test("student detail crumbs express the real entry chain", () => {
  assert.deepEqual(
    teacherStudentDetailCrumbs({
      returnTo: TEACHER_HOME_HREF,
      studentName: "张三"
    }),
    [
      { label: "首页", href: TEACHER_HOME_HREF },
      { label: "张三" }
    ]
  );
  assert.deepEqual(
    teacherStudentDetailCrumbs({
      className: "周六写作班",
      returnTo: `/teacher/classes/${CLASS_ID}`,
      studentName: "张三"
    }),
    [
      { label: "首页", href: TEACHER_HOME_HREF },
      { label: "周六写作班", href: `/teacher/classes/${CLASS_ID}` },
      { label: "张三" }
    ]
  );
  assert.deepEqual(
    teacherStudentDetailCrumbs({
      returnTo: TEACHER_STUDENTS_HREF,
      studentName: "张三"
    }),
    [
      { label: "首页", href: TEACHER_HOME_HREF },
      { label: "学生", href: TEACHER_STUDENTS_HREF },
      { label: "张三" }
    ]
  );
  // A missing class name still links back to the class, never to the student list.
  const classCrumbs = teacherStudentDetailCrumbs({
    returnTo: `/teacher/classes/${CLASS_ID}`,
    studentName: "张三"
  });
  assert.equal(classCrumbs[1].label, "班级");
  assert.equal(classCrumbs[1].href, `/teacher/classes/${CLASS_ID}`);
});

test("student child crumbs keep the class and student chain", () => {
  const studentHref = `${TEACHER_STUDENTS_HREF}/${STUDENT_ID}?returnTo=${encodeURIComponent(`/teacher/classes/${CLASS_ID}`)}`;
  const context = parseTeacherStudentReturnTo(studentHref);
  assert.equal(context.studentId, STUDENT_ID);
  assert.equal(context.classId, CLASS_ID);
  assert.equal(context.classHref, `/teacher/classes/${CLASS_ID}`);
  assert.equal(context.studentHref, studentHref);
  assert.equal(teacherClassIdFromReturnTo(`/teacher/classes/${CLASS_ID}?x=1`), CLASS_ID);
  assert.equal(teacherClassIdFromReturnTo(TEACHER_HOME_HREF), "");

  // The set-details hop keeps the student page (and its class context) intact.
  const setHref = `${TEACHER_STUDENTS_HREF}/${STUDENT_ID}/details/set-1?returnTo=${encodeURIComponent(studentHref)}`;
  const childContext = parseTeacherStudentChildReturnTo(setHref);
  assert.equal(childContext.studentId, STUDENT_ID);
  assert.equal(childContext.classId, CLASS_ID);
  assert.equal(childContext.studentHref, studentHref);
  // Both parsers accept a direct student page.
  assert.equal(parseTeacherStudentChildReturnTo(studentHref)?.studentHref, studentHref);
  // A set-details page without a nested student page still resolves the student.
  const bareSet = parseTeacherStudentChildReturnTo(
    `${TEACHER_STUDENTS_HREF}/${STUDENT_ID}/details/set-1`
  );
  assert.equal(bareSet.studentId, STUDENT_ID);
  assert.equal(bareSet.classId, "");
  assert.equal(bareSet.studentHref, `${TEACHER_STUDENTS_HREF}/${STUDENT_ID}`);

  // The 套题 crumb returns to the set page it came from, otherwise canonical.
  assert.equal(teacherSetDetailsReturnHref(setHref, STUDENT_ID, "set-1"), setHref);
  assert.equal(
    teacherSetDetailsReturnHref(studentHref, STUDENT_ID, "set-1"),
    `${TEACHER_STUDENTS_HREF}/${STUDENT_ID}/details/set-1`
  );
  assert.equal(
    teacherSetDetailsReturnHref("https://evil.example", STUDENT_ID, "set-1"),
    `${TEACHER_STUDENTS_HREF}/${STUDENT_ID}/details/set-1`
  );

  assert.deepEqual(
    teacherStudentChildCrumbs({
      className: "周六写作班",
      studentContext: context,
      studentId: STUDENT_ID,
      studentName: "张三",
      tail: [{ label: "套题001" }]
    }),
    [
      { label: "首页", href: TEACHER_HOME_HREF },
      { label: "周六写作班", href: `/teacher/classes/${CLASS_ID}` },
      { label: "张三", href: studentHref },
      { label: "套题001" }
    ]
  );

  // Without a returnTo the student page itself is the canonical parent.
  assert.deepEqual(
    teacherStudentChildCrumbs({
      studentContext: null,
      studentId: STUDENT_ID,
      studentName: "张三",
      tail: [{ label: "答题详情" }]
    }),
    [
      { label: "首页", href: TEACHER_HOME_HREF },
      { label: "张三", href: `${TEACHER_STUDENTS_HREF}/${STUDENT_ID}` },
      { label: "答题详情" }
    ]
  );
});

test("class detail breadcrumb returns to the home class list tab", () => {
  const page = read("app/teacher/classes/[classId]/page.tsx");
  assert.match(page, /safeTeacherReturnTo\(/);
  assert.match(page, /TEACHER_HOME_CLASSES_HREF/);
  assert.match(page, /label: "首页", href: TEACHER_HOME_HREF/);
  assert.match(page, /label: "班级", href: classListHref/);
});

test("home class tab is URL-backed and student links carry their source", () => {
  const dashboard = read("app/teacher/dashboard/page.tsx");
  assert.match(dashboard, /searchParams/);
  assert.match(dashboard, /=== "classes" \? "classes" : "students"/);

  const overview = read("components/teacher/TeacherStudentOverview.tsx");
  assert.match(overview, /teacherQueryUrl\(\{ tab: nextTab === "classes" \? "classes" : null \}\)/);
  assert.match(overview, /router\.replace\(/);
  assert.match(overview, /teacherReturnToHref\(/);
  assert.match(overview, /studentReturnTo = TEACHER_HOME_HREF/);

  const studentsHome = read("components/admin/AdminStudents.tsx");
  assert.match(studentsHome, /<TeacherStudentOverviewList studentReturnTo=\{TEACHER_STUDENTS_HREF\} \/>/);

  const classDetail = read("components/teacher/TeacherClassDetail.tsx");
  assert.match(classDetail, /teacherReturnToHref\(/);
  assert.match(classDetail, /teacherStudentDetailHref\(member\.student_id\)/);
});

test("student detail and its drill-down pages thread the return context", () => {
  const studentPage = read("app/teacher/students/[studentId]/page.tsx");
  assert.match(studentPage, /returnTo=\{firstSearchParamValue\(searchParams\?\.returnTo\)\}/);

  const section = read("components/teacher/TeacherStudentPracticeSection.tsx");
  assert.match(section, /teacherStudentDetailCrumbs\(/);
  assert.match(section, /teacherReturnToHref\(record\.href, returnTo\)/);

  const setPage = read("app/teacher/students/[studentId]/details/[setId]/page.tsx");
  assert.match(setPage, /returnTo=\{firstSearchParamValue\(searchParams\?\.returnTo\)\}/);
  const answerPage = read("app/teacher/students/[studentId]/answers/[attemptAnswerId]/page.tsx");
  assert.match(answerPage, /returnTo=\{firstSearchParamValue\(searchParams\?\.returnTo\)\}/);

  const dashboard = read("components/TeacherDashboard.tsx");
  assert.match(dashboard, /teacherStudentChildCrumbs\(/);
  assert.match(dashboard, /parseTeacherStudentChildReturnTo\(/);
  // The set-wide attempt list is no longer reachable from the record chain: the
  // per-question page keeps the material name as a plain crumb.
  assert.doesNotMatch(dashboard, /teacherSetDetailsReturnHref/);
  assert.match(dashboard, /teacherReturnToHref\(\s*`\/teacher\/students\/\$\{studentId\}\/answers\/\$\{answer\.attemptAnswerId\}`,\s*selfHref\s*\)/);

  const readingPage = read("app/teacher/students/[studentId]/reading/attempts/[attemptId]/page.tsx");
  assert.match(readingPage, /returnTo=\{firstSearchParamValue\(searchParams\?\.returnTo\)\}/);
  const readingDetail = read("components/teacher/TeacherStudentReadingAttemptDetail.tsx");
  assert.match(readingDetail, /safeTeacherReturnTo\(returnTo, teacherStudentDetailHref\(studentId\)\)/);
});

test("assignment drill-downs return to the exact list state", () => {
  const list = read("components/teacher/TeacherWritingAssignmentList.tsx");
  assert.match(list, /listReturnTo\?: string/);
  assert.match(list, /teacherReturnToHref\(detailHref, listReturnTo\)/);
  assert.match(list, /listReturnTo \?\? "\/teacher\/writing\/assignments"/);
  assert.match(list, /teacherReturnToHref\(`\$\{detailHref\}\/edit`, listReturnTo\)/);

  const listPage = read("components/teacher/TeacherWritingAssignmentsPageClient.tsx");
  assert.match(listPage, /teacherAssignmentsListHref\(/);
  assert.match(listPage, /listReturnTo=\{listReturnTo\}/);
  assert.match(listPage, /teacherQueryUrl\(\{/);
  assert.match(listPage, /router\.replace\(/);

  const detailPage = read("app/teacher/writing/assignments/[assignmentId]/page.tsx");
  assert.match(detailPage, /safeTeacherReturnTo\(\s*firstSearchParamValue\(searchParams\?\.returnTo\),\s*TEACHER_ASSIGNMENTS_HREF\s*\)/);
  assert.match(detailPage, /crumbs=\{\[\{ href: listReturnTo, label: "作业管理" \}, \{ label: "作业详情" \}\]\}/);

  const batchPage = read("app/teacher/writing/assignments/batches/[batchId]/page.tsx");
  assert.match(batchPage, /returnTo=\{listReturnTo\}/);

  const detailView = read("components/teacher/TeacherWritingAssignmentDetailView.tsx");
  assert.match(detailView, /teacherReturnToHref\(\s*teacherAssignmentDetailHref\(assignmentId\),\s*returnTo\s*\)/);
  assert.match(detailView, /router\.push\(returnTo \|\| TEACHER_ASSIGNMENTS_HREF\)/);

  const collectionView = read("components/teacher/TeacherWritingAssignmentCollectionDetailView.tsx");
  assert.match(collectionView, /teacherReturnToHref\(\s*teacherAssignmentBatchDetailHref\(collectionId\),\s*returnTo\s*\)/);

  const editPage = read("app/teacher/writing/assignments/[assignmentId]/edit/page.tsx");
  assert.match(editPage, /href: detailHref, label: "作业详情"/);
  const batchEditPage = read("app/teacher/writing/assignments/batches/[batchId]/edit/page.tsx");
  assert.match(batchEditPage, /teacherAssignmentBatchDetailHref\(batchId\)/);
});

test("assignment editors keep the list context after a successful save", () => {
  const form = read("components/teacher/TeacherWritingAssignmentForm.tsx");
  // Single assignment edit / 保存并重新布置: the saved detail URL carries the
  // same returnTo the editor was opened with. A group edit returns to the
  // group detail instead.
  assert.match(form, /teacherReturnToHref\(/);
  assert.match(form, /initialGroupId[\s\S]{0,120}teacherAssignmentBatchDetailHref\(initialGroupId\)/);
  assert.match(form, /teacherAssignmentDetailHref\(first\.assignment_id\)/);
  assert.match(form, /returnTo\?: string/);
  assert.match(form, /<TeacherAssignmentWizard/);

  const editWrapper = read("components/teacher/TeacherWritingAssignmentEditForm.tsx");
  assert.match(editWrapper, /TeacherWritingAssignmentForm initialAssignment=\{data\.assignment\} returnTo=\{returnTo\}/);

  const groupForm = read("components/teacher/TeacherWritingAssignmentGroupEditForm.tsx");
  assert.match(groupForm, /initialCollection=\{state\.data\.collection\}/);
  assert.match(groupForm, /returnTo=\{returnTo\}/);

  // The edit pages hand the raw returnTo to the form and keep the validated
  // value for the breadcrumb; a direct visit without returnTo stays canonical.
  const editPage = read("app/teacher/writing/assignments/[assignmentId]/edit/page.tsx");
  assert.match(editPage, /returnTo=\{returnToParam\}/);
  assert.match(editPage, /const listReturnTo = safeTeacherReturnTo\(returnToParam, TEACHER_ASSIGNMENTS_HREF\)/);
  const batchEditPage = read("app/teacher/writing/assignments/batches/[batchId]/edit/page.tsx");
  assert.match(batchEditPage, /returnTo=\{returnToParam\}/);
  assert.match(batchEditPage, /const listReturnTo = safeTeacherReturnTo\(returnToParam, TEACHER_ASSIGNMENTS_HREF\)/);
});

test("review workspace back link returns to the class review chain", () => {
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  // The tab, class/student and the status/task filters all live in the URL;
  // the workspace Back link (returnTo) carries that full list context.
  assert.match(list, /teacherWritingReviewsListHref\(\{/);
  assert.match(list, /classId: activeClassId/);
  assert.match(list, /studentId: activeStudentId/);
  assert.match(list, /status: statusFilter/);
  assert.match(list, /taskType: taskFilter/);
  assert.match(list, /returnTo=\{listHref\}/);
  assert.match(list, /returnTo=\{returnTo\}/);
  assert.match(list, /teacherWritingReviewWorkspaceHref\(\s*attempt\.attemptId,\s*returnTo \|\| "\/teacher\/writing\/reviews"\s*\)/);

  const workspacePage = read("app/teacher/writing/reviews/[attemptId]/page.tsx");
  assert.match(workspacePage, /safeWritingReviewReturnTo/);
  assert.match(workspacePage, /returnTo=\{returnTo\}/);

  const logsPage = read("app/teacher/writing/reviews/logs/page.tsx");
  assert.match(logsPage, /safeTeacherReturnTo\(/);
  assert.match(logsPage, /label: "写作批改", href: reviewReturnTo/);

  const logs = read("components/teacher/TeacherWritingAiLogs.tsx");
  assert.match(logs, /teacherWritingReviewWorkspaceHref\(log\.attempt_id, TEACHER_REVIEW_LOGS_HREF\)/);

  const workspace = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  assert.match(workspace, /href=\{returnTo\}/);
});
