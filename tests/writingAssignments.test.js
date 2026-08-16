const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CUSTOM_EMAIL_CLOSING_INSTRUCTION,
  buildCustomEmailTaskInstruction,
  buildCustomWritingQuestionSnapshot,
  calculateWritingAssignmentStudentStatus,
  earliestWritingAssignmentSubmission,
  isWritingQuestionSnapshot,
  normalizeAssignmentText,
  parseEmailRequirements,
  suggestAcademicDiscussionAvatarType,
  writingAssignmentTitle
} = require("../lib/writingAssignments.ts");
const {
  createStudentSearchMetadata,
  studentSearchRank
} = require("../lib/studentSearch.ts");

const projectRoot = path.resolve(__dirname, "..");

test("custom Email snapshot fills only the fixed renderer fields", () => {
  const question = buildCustomWritingQuestionSnapshot({
    taskType: "email",
    id: "assignment-1",
    now: new Date("2026-08-16T00:00:00Z"),
    fields: {
      title: "  Library Account Help  ",
      scenario: "You need to ask the\nlibrary for help.",
      requirements: "• Explain the problem.\n• Describe what you tried.\n• Request a solution.",
      recipient: "  Library   Services ",
      subject: "Library   account problem"
    }
  });
  assert.equal(question.set_title, "Library Account Help");
  assert.equal(question.scenario, "You need to ask the library for help.");
  assert.equal(
    question.task_instruction,
    "Write an email to Library Services. In your email, do the following:"
  );
  assert.equal(question.closing_instruction, CUSTOM_EMAIL_CLOSING_INSTRUCTION);
  assert.equal(question.question_id, "custom:assignment-1");
  assert.equal(question.recipient, "Library Services");
  assert.equal(question.subject, "Library account problem");
  assert.deepEqual(
    [question.requirement_1, question.requirement_2, question.requirement_3],
    ["Explain the problem.", "Describe what you tried.", "Request a solution."]
  );
  assert.equal(isWritingQuestionSnapshot("email", question), true);
});

test("custom Academic Discussion snapshot matches the existing renderer structure", () => {
  const question = buildCustomWritingQuestionSnapshot({
    taskType: "academic_discussion",
    id: "assignment-2",
    fields: {
      title: "  High School   Course Selection ",
      professor_name: "Dr. Lee",
      professor_prompt: "Should universities\nrequire internships?",
      student_1_name: "Mia",
      student_1_response: "Yes, because they build\npractical skills.",
      student_2_name: "Noah",
      student_2_response: "No, students\tneed flexibility."
    }
  });
  assert.equal(question.set_title, "High School Course Selection");
  assert.equal(question.professor_name, "Dr. Lee");
  assert.equal(question.professor_prompt, "Should universities require internships?");
  assert.equal(question.student_1_response, "Yes, because they build practical skills.");
  assert.equal(question.student_2_response, "No, students need flexibility.");
  assert.equal(question.student_2_name, "Noah");
  assert.equal(isWritingQuestionSnapshot("academic_discussion", question), true);
  assert.equal(isWritingQuestionSnapshot("email", question), false);
});

test("custom question required fields are validated", () => {
  assert.throws(
    () => buildCustomWritingQuestionSnapshot({ taskType: "email", fields: {} }),
    /标题/
  );
});

test("assignment text normalization removes visual line breaks, tabs, and repeated spaces", () => {
  assert.equal(
    normalizeAssignmentText("  Hello\r\nworld\n\nthis\t  is   text  "),
    "Hello world this is text"
  );
});

test("assignment normalization repairs Unicode and high-confidence PDF ligature artifacts", () => {
  assert.equal(normalizeAssignmentText(" beneﬁ\u00a0cial\u200b  ﬂow\tﬃ test "), "beneficial flow ffi test");
  assert.equal(
    normalizeAssignmentText("benefi cial fi nancial fi nances effi cient"),
    "beneficial financial finances efficient"
  );
  assert.equal(
    normalizeAssignmentText("A normal financial plan benefits many students."),
    "A normal financial plan benefits many students."
  );
  assert.equal(normalizeAssignmentText("wifi connection remains separate"), "wifi connection remains separate");
});

test("custom Academic Discussion stores selected avatar types and preserves manual choice", () => {
  const question = buildCustomWritingQuestionSnapshot({
    taskType: "academic_discussion",
    id: "avatar-selection",
    fields: {
      title: "Campus spaces",
      professor_name: "Emily",
      professor_prompt: "Which spaces should the university improve?",
      student_1_name: "John",
      student_1_response: "The library needs more quiet rooms.",
      student_2_name: "Sarah",
      student_2_response: "Outdoor study areas would help.",
      professor_avatar_type: "male_professor",
      student_1_avatar_type: "male_student",
      student_2_avatar_type: "female_student"
    }
  });
  assert.equal(question.professor_avatar_type, "male_professor");
  assert.equal(question.student_1_avatar_type, "male_student");
  assert.equal(question.student_2_avatar_type, "female_student");
  assert.equal(isWritingQuestionSnapshot("academic_discussion", question), true);

  const switched = buildCustomWritingQuestionSnapshot({
    taskType: "academic_discussion",
    id: "avatar-selection-switched",
    fields: {
      title: "Campus spaces",
      professor_name: "Michael",
      professor_prompt: "Which spaces should the university improve?",
      student_1_name: "John",
      student_1_response: "The library needs more quiet rooms.",
      student_2_name: "Sarah",
      student_2_response: "Outdoor study areas would help.",
      professor_avatar_type: "female_professor",
      student_1_avatar_type: "female_student",
      student_2_avatar_type: "male_student"
    }
  });
  assert.deepEqual(
    [switched.professor_avatar_type, switched.student_1_avatar_type, switched.student_2_avatar_type],
    ["female_professor", "female_student", "male_student"]
  );
});

test("common-name avatar suggestions allow explicit fallback for an unknown name", () => {
  assert.equal(suggestAcademicDiscussionAvatarType("Michael", "professor"), "male_professor");
  assert.equal(suggestAcademicDiscussionAvatarType("Dr. Emily Carter", "professor"), "female_professor");
  assert.equal(suggestAcademicDiscussionAvatarType("John", "student"), "male_student");
  assert.equal(suggestAcademicDiscussionAvatarType("Sarah", "student"), "female_student");
  assert.equal(
    suggestAcademicDiscussionAvatarType("Xylophone", "student", "female_student"),
    "female_student"
  );
});

test("custom Academic Discussion form uses clickable avatar choices and restores snapshot values", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentForm.tsx"),
    "utf8"
  );
  assert.match(source, /CustomAvatarPicker/);
  assert.match(source, /aria-pressed=\{active\}/);
  assert.match(source, /manuallySelectedAvatars/);
  assert.match(source, /professor_avatar_type: isProfessorAvatarType\(question\.professor_avatar_type\)/);
  assert.match(source, /student_1_avatar_type: isStudentAvatarType\(question\.student_1_avatar_type\)/);
  assert.match(source, /student_2_avatar_type: isStudentAvatarType\(question\.student_2_avatar_type\)/);
});

test("plain Email requirement lines parse into exactly three structured fields", () => {
  assert.deepEqual(
    parseEmailRequirements("First requirement.\nSecond requirement.\nThird requirement."),
    ["First requirement.", "Second requirement.", "Third requirement."]
  );
});

test("bullet Email requirements remove markers and merge visual line wraps", () => {
  assert.deepEqual(
    parseEmailRequirements(
      "• First requirement with a visual\nline wrap.\n• Second requirement.\n• Third requirement."
    ),
    [
      "First requirement with a visual line wrap.",
      "Second requirement.",
      "Third requirement."
    ]
  );
});

test("numbered Email requirements remove dot and parenthesis markers", () => {
  assert.deepEqual(
    parseEmailRequirements("1. First requirement.\n2) Second requirement.\n3. Third requirement."),
    ["First requirement.", "Second requirement.", "Third requirement."]
  );
});

test("Email requirements reject fewer or more than three items", () => {
  assert.throws(() => parseEmailRequirements("First.\nSecond."), /请输入 3 个邮件要点/);
  assert.throws(
    () => parseEmailRequirements("1. First.\n2. Second.\n3. Third.\n4. Fourth."),
    /请输入 3 个邮件要点/
  );
});

test("custom Email instruction uses normalized recipient and the correct closing template", () => {
  assert.equal(
    buildCustomEmailTaskInstruction("  Maria  "),
    "Write an email to Maria. In your email, do the following:"
  );
  assert.equal(
    CUSTOM_EMAIL_CLOSING_INSTRUCTION,
    "Write as much as you can and in complete sentences."
  );
});

test("custom assignment title comes only from snapshot set_title", () => {
  const question = buildCustomWritingQuestionSnapshot({
    taskType: "email",
    id: "title-test",
    fields: {
      title: "Business Trip Recommendations",
      scenario: "A much longer scenario that must never become the title.",
      requirements: "First.\nSecond.\nThird.",
      recipient: "Maria",
      subject: "Trip"
    }
  });
  assert.equal(question.set_title, "Business Trip Recommendations");
  assert.equal(writingAssignmentTitle(question), "Business Trip Recommendations");
  const listSource = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentList.tsx"),
    "utf8"
  );
  const detailSource = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentDetailView.tsx"),
    "utf8"
  );
  assert.match(listSource, /writingAssignmentTitle\(assignment\.question_snapshot\)/);
  assert.match(detailSource, /writingAssignmentTitle\(assignment\.question_snapshot\)/);
});

test("custom Email form exposes one three-requirement textarea and normalizes on blur", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentForm.tsx"),
    "utf8"
  );
  assert.match(source, /\["requirements", "三个要点"\]/);
  assert.doesNotMatch(source, /\["requirement_1", "Requirement 1"\]/);
  assert.match(source, /每个要点一行/);
  assert.match(source, /normalizeEmailRequirementsInput/);
  assert.match(source, /onBlur=\{\(\) => onBlur\(field\)\}/);
});

test("assignment status is dynamic and uses the earliest submitted retake", () => {
  const dueAt = "2026-08-20T12:00:00.000Z";
  const firstSubmittedAt = earliestWritingAssignmentSubmission([
    "2026-08-21T09:00:00.000Z",
    "2026-08-19T09:00:00.000Z",
    null
  ]);
  assert.equal(firstSubmittedAt, "2026-08-19T09:00:00.000Z");
  assert.equal(calculateWritingAssignmentStudentStatus({ dueAt, firstSubmittedAt }), "completed");
  assert.equal(calculateWritingAssignmentStudentStatus({ dueAt, firstSubmittedAt: "2026-08-21T09:00:00.000Z" }), "late_completed");
  assert.equal(calculateWritingAssignmentStudentStatus({ dueAt, firstSubmittedAt: null, now: new Date("2026-08-21T00:00:00Z") }), "overdue");
  assert.equal(calculateWritingAssignmentStudentStatus({ dueAt: null, firstSubmittedAt: null }), "pending");
});

test("assignment student search reuses Chinese and pinyin matching", () => {
  const metadata = createStudentSearchMetadata("王小明");
  assert.equal(Number.isFinite(studentSearchRank(metadata, "王小明", "王小明")), true);
  assert.equal(Number.isFinite(studentSearchRank(metadata, "王小明", "wang")), true);
  assert.equal(Number.isFinite(studentSearchRank(metadata, "王小明", "wxm")), true);
});

test("assignment SQL is copyable and links the existing writing attempts atomically", () => {
  const sql = fs.readFileSync(path.join(projectRoot, "supabase/writing_assignments.sql"), "utf8");
  assert.match(sql, /create table if not exists public\.writing_assignments/);
  assert.match(sql, /create table if not exists public\.writing_assignment_students/);
  assert.match(sql, /primary key \(assignment_id, student_id\)/);
  assert.match(sql, /writing_attempts[\s\S]*add column if not exists assignment_id uuid null/);
  assert.match(sql, /create or replace function public\.create_writing_assignment/);
  assert.match(sql, /security definer/);
  assert.match(sql, /alter table public\.writing_assignments enable row level security/);
  assert.match(sql, /constraint writing_assignments_question_source_value_check/);
  assert.match(sql, /constraint writing_assignments_question_source_check check/);
  assert.equal(
    (sql.match(/constraint writing_assignments_question_source_check check/g) ?? []).length,
    1
  );
});

test("assignment lifecycle SQL is rerunnable, transactional, and never deletes assignments", () => {
  const sql = fs.readFileSync(path.join(projectRoot, "supabase/writing_assignments.sql"), "utf8");
  assert.match(sql, /add column if not exists status text not null default 'active'/);
  assert.match(sql, /add column if not exists deleted_at timestamptz null/);
  assert.match(sql, /writing_assignments_status_check[\s\S]*status in \('active', 'withdrawn'\)/);
  assert.match(sql, /where conname = 'writing_assignments_status_check'[\s\S]*conrelid = 'public\.writing_assignments'::regclass/);
  assert.match(sql, /create or replace function public\.update_withdrawn_writing_assignment/);
  assert.match(sql, /QUESTION_LOCKED_AFTER_SUBMISSION/);
  assert.match(sql, /STUDENT_HAS_ATTEMPT/);
  assert.match(sql, /create or replace function public\.enforce_active_writing_assignment_attempt/);
  assert.match(sql, /writing_attempts_require_active_assignment/);
  assert.match(sql, /assignment\.status = 'active'[\s\S]*assignment\.deleted_at is null/);
  assert.match(sql, /revoke delete on public\.writing_assignments from authenticated/);
  assert.match(sql, /where attempt\.assignment_id = p_assignment_id[\s\S]*attempt\.user_id = assignment_student\.student_id/);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.writing_assignments\s/i);
});

test("teacher assignment lifecycle API soft deletes and enforces withdrawn editing", () => {
  const route = fs.readFileSync(
    path.join(projectRoot, "app/api/teacher/writing/assignments/[assignmentId]/route.ts"),
    "utf8"
  );
  assert.match(route, /action === "withdraw"/);
  assert.match(route, /action === "reactivate"/);
  assert.match(route, /action === "soft_delete"/);
  assert.match(route, /deleted_at: new Date\(\)\.toISOString\(\)/);
  assert.match(route, /assignment\.status !== "withdrawn"/);
  assert.match(route, /prepareWritingAssignmentMembership/);
  assert.match(route, /assertLockedQuestionInput/);
  assert.match(route, /\.eq\("status", "submitted"\)/);
  assert.doesNotMatch(route, /\.from\("writing_assignments"\)\s*\.delete\(/);

  const listRoute = fs.readFileSync(
    path.join(projectRoot, "app/api/teacher/writing/assignments/route.ts"),
    "utf8"
  );
  assert.match(listRoute, /\.is\("deleted_at", null\)/);
});

test("withdrawn assignment UI reuses the form and exposes lifecycle actions", () => {
  const form = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentForm.tsx"),
    "utf8"
  );
  const list = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentList.tsx"),
    "utf8"
  );
  const detail = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentDetailView.tsx"),
    "utf8"
  );
  const editWrapper = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentEditForm.tsx"),
    "utf8"
  );
  assert.match(form, /initialAssignment\?: WritingAssignmentDetail/);
  assert.match(form, /questionLocked/);
  assert.match(form, /lockedStudentIds/);
  assert.match(form, /保存并重新布置/);
  assert.match(editWrapper, /TeacherWritingAssignmentForm initialAssignment=/);
  for (const source of [list, detail]) {
    assert.match(source, /进行中/);
    assert.match(source, /已撤回/);
    assert.match(source, /编辑作业/);
    assert.match(source, /重新布置/);
    assert.match(source, /删除作业/);
    assert.match(source, /撤回后，学生将不能再通过该作业开始或继续未提交的练习/);
    assert.match(source, /学生已有提交和批改记录不会被删除/);
  }
});

test("deleted or withdrawn assignment snapshots remain readable by review pipelines", () => {
  for (const relativePath of [
    "lib/writingReviewSource.ts",
    "lib/writingServer.ts",
    "app/api/teacher/writing/reviews/route.ts",
    "app/api/writing/reviews/route.ts"
  ]) {
    const source = fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
    assert.match(source, /question_snapshot/);
    assert.doesNotMatch(source, /writing_assignments[\s\S]{0,400}\.is\("deleted_at", null\)/);
    assert.doesNotMatch(source, /writing_assignments[\s\S]{0,400}\.eq\("status", "active"\)/);
  }
});

test("withdrawn assignments block draft loading and saving but not submitted history", () => {
  const route = fs.readFileSync(
    path.join(projectRoot, "app/api/writing/attempts/[attemptId]/route.ts"),
    "utf8"
  );
  assert.match(route, /attemptResult\.data\.status === "draft" && attemptResult\.data\.assignment_id/);
  assert.match(route, /\.eq\("status", "active"\)/);
  assert.match(route, /\.is\("deleted_at", null\)/);
  assert.match(route, /这项作业已撤回，不能继续作答/);
  assert.match(route, /if \(attempt\.status === "submitted"\)[\s\S]*if \(attempt\.assignment_id\)/);
});

test("question search stays server-side, task-specific, paged, stable, and uncached", () => {
  const source = fs.readFileSync(path.join(projectRoot, "app/api/teacher/writing/assignments/questions/route.ts"), "utf8");
  assert.match(source, /WRITING_TASK_CONFIG\[taskType\]\.questionTable/);
  assert.match(source, /\.range\(from, from \+ pageSize - 1\)/);
  assert.match(source, /\.order\("year_month"/);
  assert.match(source, /export const dynamic = "force-dynamic"/);
  const server = fs.readFileSync(path.join(projectRoot, "lib/writingAssignmentsServer.ts"), "utf8");
  assert.match(server, /"Cache-Control": "no-store"/);
});

test("assignment attempts load their immutable snapshot in the existing review pipeline", () => {
  const source = fs.readFileSync(path.join(projectRoot, "lib/writingReviewSource.ts"), "utf8");
  assert.match(source, /attempt_id,assignment_id,user_id/);
  assert.match(source, /from\("writing_assignments"\)/);
  assert.match(source, /question_snapshot/);
  const workspace = fs.readFileSync(path.join(projectRoot, "lib/writingReviewWorkspaceServer.ts"), "utf8");
  assert.match(workspace, /attempt\.assignment_id/);
});
