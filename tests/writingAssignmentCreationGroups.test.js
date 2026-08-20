const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildCustomWritingQuestionSnapshot,
  parseCustomEmailPrompt,
  toggleWritingAssignmentQuestionSelection
} = require("../lib/writingAssignments.ts");

const projectRoot = path.resolve(__dirname, "..");

test("custom Email prompt parser extracts recipient, scenario, and exactly three requirements without rewriting", () => {
  const prompt = [
    "You missed an important class meeting.",
    "You need the notes before Friday.",
    "",
    "Write an email to Professor Lee. In your email, do the following:",
    "• Explain why you missed the meeting.",
    "• Ask for the notes.",
    "• Suggest a time to meet.",
    "",
    "Write as much as you can and in complete sentences."
  ].join("\n");
  assert.deepEqual(parseCustomEmailPrompt(prompt), {
    recipient: "Professor Lee",
    requirements: [
      "Explain why you missed the meeting.",
      "Ask for the notes.",
      "Suggest a time to meet."
    ],
    scenario: "You missed an important class meeting.\nYou need the notes before Friday."
  });
});

test("custom Email parser reports missing recipient and an inaccurate requirement count for manual correction", () => {
  const parsed = parseCustomEmailPrompt("A campus office changed its hours.\n• Ask why.\n• Request the new hours.");
  assert.equal(parsed.recipient, "");
  assert.equal(parsed.requirements.length, 2);
  assert.equal(parseCustomEmailPrompt(
    "Write an email to the office.\n• One.\n• Two.\n• Three.\n• Four."
  ).requirements.length, 4);
});

test("manual Email corrections become the final immutable snapshot", () => {
  const question = buildCustomWritingQuestionSnapshot({
    taskType: "email",
    id: "manual-email",
    fields: {
      parsed_email: true,
      title: "Class meeting",
      scenario: "Line one stays here.\nLine two stays here.",
      recipient: "Professor Rivera",
      requirement_1: "Explain what happened.",
      requirement_2: "Ask for the notes.",
      requirement_3: "Propose a meeting time.",
      subject: "Missed class meeting"
    }
  });
  assert.equal(question.scenario, "Line one stays here.\nLine two stays here.");
  assert.equal(question.recipient, "Professor Rivera");
  assert.deepEqual(
    [question.requirement_1, question.requirement_2, question.requirement_3],
    ["Explain what happened.", "Ask for the notes.", "Propose a meeting time."]
  );
});

test("question-bank multi-selection survives replacing the visible search results", () => {
  const firstSearch = [{ question_id: "email-1", title: "First" }];
  const secondSearch = [{ question_id: "email-2", title: "Second" }];
  let selected = new Map();
  selected = toggleWritingAssignmentQuestionSelection(selected, firstSearch[0]);
  selected = toggleWritingAssignmentQuestionSelection(selected, secondSearch[0]);
  assert.deepEqual(Array.from(selected.keys()), ["email-1", "email-2"]);
  selected = toggleWritingAssignmentQuestionSelection(selected, secondSearch[0]);
  assert.deepEqual(Array.from(selected.keys()), ["email-1"]);
});

test("creation form supports multi-select, custom multi-question editing, deadline modes, and renderer previews", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentForm.tsx"),
    "utf8"
  );
  const createForm = source.match(
    /function TeacherWritingAssignmentCreateForm[\s\S]*?(?=function TeacherWritingAssignmentEditForm)/
  )?.[0] ?? "";
  assert.match(createForm, /Map<string, LogicalWritingQuestionSearchResult>/);
  assert.match(createForm, /已选择 \{selectedQuestions\.size\} 篇/);
  assert.match(createForm, /切换搜索或翻页不会清除已选题目/);
  assert.match(createForm, /添加一篇/);
  assert.match(createForm, /setCustomQuestions\(\(current\) => current\.filter/);
  assert.match(createForm, /统一截止时间/);
  assert.match(createForm, /分别设置/);
  assert.match(createForm, /individualDueAt/);
  assert.match(createForm, /WritingAssignmentQuestionPreview/);
  assert.match(createForm, /assignments, studentIds: selectedStudents/);
  assert.match(createForm, /customEmailRequirementCount\(draft\) !== 3/);
});

test("custom Email creation keeps only three main inputs collapsed and exposes correction validation", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "components/teacher/TeacherWritingAssignmentForm.tsx"),
    "utf8"
  );
  const card = source.match(
    /function CustomQuestionDraftCard[\s\S]*?(?=function MultiQuestionResults)/
  )?.[0] ?? "";
  assert.match(card, />标题</);
  assert.match(card, />题目</);
  assert.match(card, />Subject</);
  assert.match(card, /查看\/修改识别结果/);
  assert.match(card, /未能识别 Recipient/);
  assert.match(card, /必须准确识别或补充 3 条要求后才能布置/);
  assert.match(card, /Requirement \{number\}/);
});

test("group migration is copyable, historical-compatible, and creates every child atomically", () => {
  const sql = fs.readFileSync(
    path.join(projectRoot, "supabase/writing_assignment_groups.sql"),
    "utf8"
  );
  assert.match(sql, /create table if not exists public\.writing_assignment_groups/);
  assert.match(sql, /add column if not exists group_id uuid null/);
  assert.match(sql, /group_position integer null/);
  assert.match(sql, /create or replace function public\.create_writing_assignment_group/);
  assert.match(sql, /security definer/);
  assert.match(sql, /insert into public\.writing_assignment_groups/);
  assert.match(sql, /insert into public\.writing_assignments[\s\S]*created_group_id/);
  assert.match(sql, /insert into public\.writing_assignment_students/);
  assert.match(sql, /assignment_ids := array_append/);
  assert.doesNotMatch(sql, /writing_attempts/);
  const rpc = sql.match(
    /create or replace function public\.create_writing_assignment_group[\s\S]*?\n\$\$;/
  )?.[0] ?? "";
  assert.ok(rpc.indexOf("jsonb_array_elements(p_assignments)") < rpc.indexOf("insert into public.writing_assignment_groups"));
});

test("single and multi-question POST requests use the same group RPC and reject incomplete results", () => {
  const route = fs.readFileSync(
    path.join(projectRoot, "app/api/teacher/writing/assignments/route.ts"),
    "utf8"
  );
  assert.match(route, /Array\.isArray\(body\.assignments\)/);
  assert.match(route, /assignments: \[body\]/);
  assert.match(route, /prepareWritingAssignmentGroupMutation/);
  assert.match(route, /\.rpc\("create_writing_assignment_group"/);
  assert.match(route, /assignmentIds\.length !== prepared\.assignments\.length/);
  assert.doesNotMatch(route, /\.from\("writing_attempts"\)/);
});
