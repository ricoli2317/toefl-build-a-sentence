const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildLogicalWritingQuestionSearchResults,
  matchedLogicalWritingItemIds
} = require("../lib/writingAssignmentLogicalSearch.ts");
const {
  validateLogicalWritingTitle
} = require("../lib/practiceImporter/logicalTitle.ts");
const { formatTextItems } = require("../lib/questionText.ts");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function emailQuestion(questionId, setTitle) {
  return {
    question_id: questionId,
    set_id: `set-${questionId}`,
    set_title: setTitle,
    year_month: "202608",
    source_labels: "8.8A",
    scenario: "A community theater needs costume rentals.",
    task_instruction: "Write an email.",
    requirement_1: "Ask about availability.",
    requirement_2: "Ask about price.",
    requirement_3: "Ask about pickup.",
    closing_instruction: "Write complete sentences.",
    recipient: "Rental manager",
    subject: "Inquiry About Costume Rentals for Community Theater"
  };
}

test("exact draft resume reads by attempt_id and never applies new-mode availability", () => {
  const exactRoute = read("app/api/writing/attempts/[attemptId]/route.ts");
  const createRoute = read("app/api/writing/attempts/route.ts");
  const client = read("components/writing/WritingPractice.tsx");
  assert.match(exactRoute, /readOwnedWritingAttempt\([\s\S]*params\.attemptId/);
  assert.doesNotMatch(exactRoute, /getStudentWritingModeAvailability|writingModeUnavailableMessage/);
  assert.match(client, /attemptId\s*\?\s*await fetch\(`\/api\/writing\/attempts\/\$\{encodeURIComponent\(attemptId\)\}/);
  assert.match(client, /result\.attempt\.question_id !== questionId/);
  assert.match(createRoute, /getStudentWritingModeAvailability/);
  assert.match(createRoute, /isStudentWritingModeAllowed/);
});

test("submitted attempts remain immutable and assignment draft checks remain active", () => {
  const route = read("app/api/writing/attempts/[attemptId]/route.ts");
  assert.match(route, /if \(attempt\.status === "submitted"\)[\s\S]*Submitted writing attempts cannot be modified/);
  assert.match(route, /attemptResult\.data\.status === "draft" && attemptResult\.data\.assignment_id/);
  assert.match(route, /if \(attempt\.assignment_id\)[\s\S]*isAssignmentAvailable/);
});

test("Email and AD logical titles enforce permanent English 1-5 word names", () => {
  assert.equal(validateLogicalWritingTitle("Community Theater Costume Rentals"), "Community Theater Costume Rentals");
  assert.equal(validateLogicalWritingTitle("Nature vs Nurture"), "Nature vs Nurture");
  assert.throws(() => validateLogicalWritingTitle("Inquiry About Costume Rentals for Community Theater"), /at most 5 words/);
  assert.throws(() => validateLogicalWritingTitle("TOEFL Email Practice"), /task name/);
  assert.throws(() => validateLogicalWritingTitle("Question 12 Housing"), /question number/);
  const importer = read("lib/practiceImporter/server.ts");
  assert.match(importer, /classification\.classification === "NEW_ITEM"[\s\S]*generateLogicalWritingTitle\(subject, "email"\)/);
  assert.match(importer, /classification\.classification === "NEW_ITEM"[\s\S]*generateAcademicDiscussionTitle/);
});

test("raw duplicate and non-canonical keyword matches yield one canonical logical result", () => {
  const sources = [
    { item_id: "item-1", task_type: "email", source_question_id: "raw-a", is_canonical: false },
    { item_id: "item-1", task_type: "email", source_question_id: "raw-b", is_canonical: false },
    { item_id: "item-1", task_type: "email", source_question_id: "raw-c", is_canonical: true }
  ];
  const matchedItemIds = matchedLogicalWritingItemIds({
    matchedRawQuestionIds: ["raw-a", "raw-b"],
    sources,
    taskType: "email"
  });
  const results = buildLogicalWritingQuestionSearchResults({
    canonicalQuestions: [emailQuestion("raw-c", "8.8C")],
    items: [{
      item_id: "item-1",
      task_type: "email",
      display_number: "023",
      display_title: "Community Theater Rentals",
      first_seen_date: "2026-08-08",
      is_active: true
    }],
    matchedItemIds,
    sources,
    taskType: "email"
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].logical_display_name, "题目023 Community Theater Rentals");
  assert.equal(results[0].question_id, "raw-c");
  assert.notEqual(results[0].set_title, results[0].logical_display_name);
});

test("logical assignment search uses stable date and suffix ordering", () => {
  const canonicalQuestions = ["057", "057A", "057B", "058"].map((number) =>
    emailQuestion(`q-${number}`, number)
  );
  const items = ["057", "057A", "057B", "058"].map((number) => ({
    item_id: `i-${number}`,
    task_type: "email",
    display_number: number,
    display_title: `Title ${number}`,
    first_seen_date: "2026-08-08",
    is_active: true
  }));
  const sources = items.map((item) => ({
    item_id: item.item_id,
    task_type: "email",
    source_question_id: `q-${item.display_number}`,
    is_canonical: true
  }));
  const results = buildLogicalWritingQuestionSearchResults({
    canonicalQuestions,
    items,
    matchedItemIds: new Set(items.map((item) => item.item_id)),
    sources,
    taskType: "email"
  });
  assert.deepEqual(results.map((result) => result.logical_display_number), ["058", "057B", "057A", "057"]);
});

test("new bank assignments snapshot the canonical raw question and list with logical naming", () => {
  const mutation = read("lib/writingAssignmentsServer.ts");
  const route = read("app/api/teacher/writing/assignments/route.ts");
  const list = read("components/teacher/TeacherWritingAssignmentList.tsx");
  assert.match(route, /canonicalizeQuestionBank: true/);
  assert.match(mutation, /practice_item_sources[\s\S]*is_canonical/);
  assert.match(mutation, /questionId = await resolveCanonicalWritingAssignmentQuestionId/);
  assert.match(route, /display_name: display\?\.displayName \?\? snapshotTitle/);
  assert.match(list, /assignment\.display_name \|\| writingAssignmentTitle/);
  assert.match(route, /assignment\.question_source === "question_bank"/);
});

test("frequent wrong JSON arrays render readably while the source field stays unchanged", () => {
  const historical = '["the","most","students","seemed","ideal"]';
  assert.equal(formatTextItems(historical), "the most students seemed ideal");
  assert.equal(formatTextItems("[]"), "");
  assert.equal(
    formatTextItems('["that",["Is","most","in"],"demand right","now"]'),
    "that Is most in demand right now"
  );
  assert.equal(
    formatTextItems('["\\\"that\\\"","[\\\"Is\\\",\\\"most\\\",\\\"in\\\"]","\\\"demand right\\\"","\\\"now\\\""]'),
    "that Is most in demand right now"
  );
  assert.equal(
    formatTextItems('["\\\"that\\\"","[\\\"Is\\\" \\\"most\\\" \\\"in\\\"]","\\\"demand right\\\"","\\\"now\\\""]'),
    "that Is most in demand right now"
  );
  assert.equal(historical, '["the","most","students","seemed","ideal"]');
  const ui = read("components/TeacherDashboard.tsx");
  assert.match(ui, /formatTextItems\(answer\.displaySubmittedOrderText \|\| answer\.submittedOrderText\)/);
  assert.match(ui, /buildSentenceDisplay\([\s\S]*question\.sentenceTemplate,[\s\S]*item\.submittedOrderText[\s\S]*\) \|\| "未作答"/);
});

test("teacher set and review UI hide implementation details and keep status on one line", () => {
  const dashboard = read("components/TeacherDashboard.tsx");
  const review = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.doesNotMatch(dashboard, />Logical Item ID<|>Logical Q1–Q10 正确率<|>历史原始来源</);
  assert.match(dashboard, />各题正确率</);
  assert.match(dashboard, /question\.answerCount === 0 \? "--"/);
  assert.match(review, /whitespace-nowrap/);
  assert.match(review, /attempt\.reviewContext === "assignment_question_bank"/);
  assert.match(review, /attempt\.logicalDisplay\.displayName/);
});

test("login keeps the original auth flow while active layouts use the new TPS asset", () => {
  const login = read("components/LoginPanel.tsx");
  const studentBrand = read("components/student/StudentBrand.tsx");
  const teacherShell = read("components/teacher/TeacherAppShell.tsx");
  assert.match(login, /supabase\.auth\.signInWithPassword/);
  assert.match(login, /profile\?\.role !== role/);
  assert.match(login, /role === "student" \? "\/student\/sets" : "\/teacher\/dashboard"/);
  assert.doesNotMatch(login, /Remember me|Forgot password/);
  for (const source of [login, studentBrand]) assert.match(source, /\/brand\/tps-logo\.png/);
  assert.match(teacherShell, /<StudentBrand compact/);
  assert.doesNotMatch(teacherShell, />\s*Build a Sentence\s*</);
  assert.match(read("components/student/StudentShell.tsx"), /label: "Build a Sentence"/);
});

test("Email title backfill is explicit, guarded, and covers exactly 58 audited rows", () => {
  const sql = read("supabase/email_logical_titles_backfill.sql");
  const plannedRows = sql.match(/^\s*\('\d{3}',\s*'.*?',\s*'.*?'\)[,;]$/gm) ?? [];
  assert.equal(plannedRows.length, 58);
  assert.match(sql, /v_plan_count <> 58/);
  assert.match(sql, /v_match_count <> 58/);
  assert.match(sql, /backfill\.old_title = item\.display_title/);
  assert.match(sql, /item\.task_type = 'email'/);
  assert.match(sql, /item\.display_number = backfill\.display_number/);
  assert.match(sql, /v_invalid_count/);
});
