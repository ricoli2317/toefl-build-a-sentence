const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  READING_QUESTION_CATEGORIES, isReadingQuestionCategory, drawCategoryManifest,
  categoryResultAnswers, categoryResultHref, categoryRetakeHref, categoryAnswerRows
} = require("../lib/reading/questionCategory.ts");
const { wrongQuestionAmountOptions, readingWrongAnswerEvents } = require("../lib/wrongQuestionBank.ts");
const { selectReadingTargetPractice, selectReadingWrongbookPractice } = require("../lib/reading/wrongbook.ts");
const { buildReadingSubmissionAnswers } = require("../lib/reading/attempts.ts");
const { buildTeacherStudentReadingPractice } = require("../lib/teacherStudentPractice.ts");
const { buildTeacherStudentPracticeRange } = require("../lib/teacherStudentPracticeRange.ts");
const { studentPracticeRecordResultTarget, studentPracticeRecordRetakeTarget } = require("../lib/studentPracticeHistory.ts");
const { loadCategoryHistoryRows } = require("../lib/reading/questionCategoryHistory.server.ts");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const sql = read("supabase/reading_question_category_sessions_20261007.sql");
const editableSQL = read("supabase/reading_question_category_editable_20261007.sql");
const runner = read("components/reading/ReadingMultiSourceSessionRunner.tsx");
const category = "推断题";
const pool = Array.from({ length: 30 }, (_, i) => ({ question_id: `q-${i}`, logical_item_id: `item-${i % 6}`, question_order: i + 1 }));
function frozen(amount = 20) {
  return drawCategoryManifest({ questionCategory: category, amount, rows: pool, titles: new Map(pool.map((row) => [row.logical_item_id, row.logical_item_id])) });
}
function completed() {
  const manifest = frozen();
  const session = { sessionId: "session-20", questionCategory: category, amount: 20,
    groups: manifest.groups, progress: {}, status: "completed", elapsedSeconds: 123,
    totalPoints: 20, correctPoints: 10, completedAt: "2026-10-07T03:00:00Z", createdAt: "2026-10-07T02:00:00Z" };
  const answers = manifest.groups.flatMap((group) => group.targets.map((target) => ({
    answerId: `a-${target.questionId}`, questionId: target.questionId, logicalItemId: group.logicalItemId,
    answerKind: "option", studentAnswer: "opt-a", isCorrect: true, questionTimeSeconds: 3
  })));
  return { session, answers };
}

test("category order is fixed and unknown categories never become a new pool", () => {
  assert.deepEqual(READING_QUESTION_CATEGORIES, ["事实信息题","否定信息题","主旨题","词汇题","选句题","句子简化题","指代题","推断题","修辞目的题","句子插入题"]);
  for (const value of READING_QUESTION_CATEGORIES) assert.equal(isReadingQuestionCategory(value), true);
  for (const value of ["RAP", "主旨", "推断题 ", null, 10, {}]) assert.equal(isReadingQuestionCategory(value), false);
});
test("draw freezes unique identity, first encountered group order and canonical within-group order", () => {
  const originalRandom = Math.random;
  try {
    Math.random = () => 0.9999; // Fisher-Yates retains the given first-encounter order
    const rows = [pool[8], pool[1], pool[2], pool[0], pool[7], pool[6]];
    const manifest = drawCategoryManifest({ questionCategory: category, amount: 5, rows, titles: new Map() });
    assert.deepEqual(manifest.groups.map((group) => group.logicalItemId), ["item-2", "item-1", "item-0"]);
    assert.deepEqual(manifest.groups[0].targets.map((target) => target.questionId), ["q-2", "q-8"]);
    assert.deepEqual(manifest.groups[1].targets.map((target) => target.questionId), ["q-1", "q-7"]);
    assert.equal(JSON.stringify(manifest).includes("options"), false);
    assert.equal(JSON.stringify(manifest).includes("stem"), false);
    assert.equal(manifest.groups.flatMap((group) => group.targets).length, 5);
    assert.equal(new Set(manifest.groups.flatMap((group) => group.targets).map((target) => target.questionId)).size, 5);
  } finally { Math.random = originalRandom; }
});
test("small category pool uses the SAME 5/10/15/20 shortage rule and actual frozen count", () => {
  assert.deepEqual(wrongQuestionAmountOptions(8).filter((option) => option.enabled).map((option) => option.amount), [5, 10]);
  assert.equal(wrongQuestionAmountOptions(8, "当前题型共")[1].shortfallHint, "当前题型共 8 道");
  const manifest = drawCategoryManifest({ questionCategory: category, amount: 10, rows: pool.slice(0, 8), titles: new Map() });
  assert.equal(manifest.groups.flatMap((group) => group.targets).length, 8);
  assert.ok(wrongQuestionAmountOptions(0).every((option) => !option.enabled));
});
test("result is manifest-global 1..20, independent of answer arrival order", () => {
  const { session, answers } = completed();
  const ordered = categoryResultAnswers(session, [...answers].reverse());
  assert.deepEqual(ordered.map((answer) => answer.order), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(ordered.map((answer) => answer.reviewIndex), Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(ordered.map((answer) => answer.questionId), answers.map((answer) => answer.questionId));
  assert.throws(() => categoryResultAnswers(session, answers.slice(1)), /CATEGORY_RESULT_TARGET_MISSING/);
  assert.throws(() => categoryResultAnswers(session, [{ ...answers[0], logicalItemId: "forged" }, ...answers.slice(1)]), /CATEGORY_RESULT_TARGET_MISSING/);
});
test("partial-target selector is literally shared; untargeted questions never submit", () => {
  assert.equal(selectReadingTargetPractice, selectReadingWrongbookPractice);
  const practice = { item: { module: "rap", itemId: "i", questionCount: 3, scoringPointCount: 3 },
    passage: { title: "Canonical", paragraphs: [] }, questions: [
      { questionId: "q1", questionOrder: 1, questionType: "rap_multiple_choice", options: [] },
      { questionId: "q2", questionOrder: 2, questionType: "rap_sentence_insertion", anchors: [] },
      { questionId: "q3", questionOrder: 3, questionType: "rap_sentence_selection" }
    ] };
  const partial = selectReadingTargetPractice(practice, [{ questionId: "q2", slotId: null }]);
  assert.equal(partial.passage, practice.passage);
  assert.deepEqual(partial.questions.map((question) => question.questionId), ["q2"]);
  assert.deepEqual(buildReadingSubmissionAnswers(partial, {}, {}), [{ kind: "insertion_anchor", questionId: "q2", questionTimeSeconds: 0, studentAnswer: null }]);
});
test("normal wrong events include unanswered and never correct existing history", () => {
  const events = readingWrongAnswerEvents({ logicalItemId: "i", taskType: "rap", answers: [
    { questionId: "correct", slotId: null, isCorrect: true },
    { questionId: "wrong", slotId: null, isCorrect: false },
    { questionId: "unanswered", slotId: null, isCorrect: false }
  ] });
  assert.deepEqual(events.map((event) => [event.event, event.taskType, event.logicalItemId, event.questionId, event.slotId]), [
    ["wrong", "rap", "i", "wrong", null], ["wrong", "rap", "i", "unanswered", null]
  ]);
  const normal = read("lib/reading/wrongQuestionEvents.server.ts");
  assert.match(normal, /applyReadingAttemptWrongEvents[\s\S]*await applyReadingGradedWrongEvents/);
  const submit = read("app/api/reading/question-category/sessions/[sessionId]/groups/[itemId]/route.ts");
  assert.doesNotMatch(submit, /applyReadingGradedWrongEvents|createServiceSupabase/);
  assert.match(editableSQL, /if p_finalize then[\s\S]*apply_student_wrong_question_events/);
  assert.match(editableSQL, /Asia\/Shanghai/);
  assert.doesNotMatch(submit, /applyReadingCorrection|readingCorrectionEvents/);
  assert.doesNotMatch(sql, /apply_student_wrong_question_events/);
});
test("twenty targets across six passages produce ONE normal RAP history record", () => {
  const historyRow = { session_id: "s", question_category: category, amount: 20, status: "completed",
    completed_at: "2026-10-07T03:00:00Z", elapsed_seconds: 123, total_points: 20, correct_points: 12 };
  const payload = buildTeacherStudentReadingPractice({ attempts: [], categorySessions: [historyRow, { ...historyRow, session_id: "active", status: "active" }], itemMeta: new Map(), studentId: "student" });
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].title, "题型分类练习·推断题");
  assert.equal(payload.records[0].kind, "question_category");
  assert.deepEqual(payload.tasks.rap, { attempts: 1, totalPoints: 20, correctPoints: 12, accuracy: 0.6 });
  assert.equal(studentPracticeRecordResultTarget(payload.records[0]).href, `${categoryResultHref("s")}?returnTo=%2Fstudent%2Fpractice-history`);
  assert.match(studentPracticeRecordRetakeTarget(payload.records[0]).href, /amount=20/);
  const range = buildTeacherStudentPracticeRange({ timeZone: "Asia/Shanghai", reading: { attempts: [], wrongbookAttempts: [], sessions: [], fullSetAttempts: [], fullSetModules: [], categorySessions: [historyRow] } });
  assert.equal(range.reading.tasks.rap.attempts, 1);
  assert.equal(range.days[0].counts.rap, 1);
});
test("history query is owner/date scoped and never loads answer/manifest/content rows", async () => {
  const date = "2026-10-07T03:00:00Z";
  const rows = [
    { session_id: "s", student_id: "student", status: "completed", completed_at: date },
    { session_id: "other", student_id: "other", status: "completed", completed_at: date },
    { session_id: "active", student_id: "student", status: "active", completed_at: date },
    { session_id: "old", student_id: "student", status: "completed", completed_at: "2026-10-06T03:00:00Z" }
  ];
  const result = await loadCategoryHistoryRows(createMockSupabase({ reading_question_category_sessions: rows }), "student", "2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z");
  assert.deepEqual(result.map((row) => row.session_id), ["s"]);
  const source = read("lib/reading/questionCategoryHistory.server.ts");
  assert.doesNotMatch(source, /\.from\("reading_questions"\)|\.select\("\*"\)/);
  assert.doesNotMatch(source.match(/CATEGORY_HISTORY_COLUMNS = ([^;]+);/)[1], /manifest|answers|passage/);
});
test("retake preserves category/tier behavior but carries NO old session/targets", () => {
  const href = categoryRetakeHref({ questionCategory: category, amount: 10 });
  const url = new URL(href, "https://fixture.invalid");
  assert.equal(url.searchParams.get("questionCategory"), category);
  assert.equal(url.searchParams.get("amount"), "10");
  assert.equal(url.searchParams.has("session"), false);
});
test("answer conversion preserves original passage/question identity and unanswered null", () => {
  const rows = categoryAnswerRows([{ answerId: "a", questionId: "q", logicalItemId: "i", answerKind: "option", studentAnswer: null, isCorrect: false, questionTimeSeconds: 3 }]);
  assert.deepEqual(rows, [{ attempt_answer_id: "a", question_id: "q", slot_id: null, answer_kind: "option", student_answer: null, is_correct: false, question_time_seconds: 3 }]);
});
test("schema has only two tables and no ordinary draft or passage completion writes", () => {
  assert.deepEqual([...sql.matchAll(/create table public\.(\w+)/g)].map((match) => match[1]), ["reading_question_category_sessions", "reading_question_category_session_answers"]);
  assert.doesNotMatch(sql, /(?:insert into|update|alter table) public\.(?:reading_attempts|reading_wrongbook_attempts|student_practice_item_state)\b/i);
  assert.match(sql, /unique \(session_id, question_id\)/);
  assert.match(sql, /foreign key \(question_id, logical_item_id\)/);
  assert.match(sql, /grant select[\s\S]*to authenticated/);
  assert.doesNotMatch(sql, /grant (?:insert|update|delete|all)[^;]*to authenticated/);
});
test("counts and draw use the exact RAP/category pool with no active or dedup filter", () => {
  const server = read("lib/reading/questionCategory.server.ts");
  assert.match(server, /\.eq\("module", "rap"\)\.eq\("question_category", questionCategory\)/);
  assert.match(sql, /where module = 'rap' group by question_category/);
  assert.doesNotMatch(server, /\.eq\("is_active"|dedup|distinct/i);
  const countFunction = sql.slice(sql.indexOf("create function public.reading_question_category_counts()"), sql.indexOf("create function public.save_reading_question_category_draft"));
  assert.doesNotMatch(countFunction, /is_active|options|stem|passage/);
  const route = read("app/api/reading/question-category/route.ts");
  assert.match(route, /Object\.keys\(body\)\.some\(\(key\) => key !== "questionCategory" && key !== "amount"\)/);
});
test("editable submit locks owner row, uses frozen targets, and completed retry exits before writes", () => {
  const submit = editableSQL.slice(editableSQL.indexOf("create function public.submit_reading_question_category_group"));
  assert.match(submit, /student_id = auth\.uid\(\) for update/);
  assert.ok(submit.indexOf("'alreadySubmitted',true") < submit.indexOf("insert into public.reading_question_category_session_answers"));
  assert.match(submit, /v_current is distinct from p_logical_item_id/);
  assert.match(submit, /jsonb_array_length\(p_answers\) <> v_total/);
  assert.match(submit, /group by a->>'questionId' having count\(\*\) > 1/);
  assert.match(submit, /q\.question_category is distinct from v_session\.question_category/);
  assert.match(submit, /from jsonb_array_elements\(v_group->'targets'\)/);
  assert.match(submit, /coalesce\(nullif\(a->>'studentAnswer',''\) = case q\.question_type/);
  for (const table of ["reading_question_options", "reading_rap_insertion_anchors", "reading_passage_sentences"]) assert.ok(submit.includes(table));
  assert.match(submit, /elapsed_seconds = v_elapsed,total_points = v_total/);
});
test("summary is one active->completed transition and rebuild includes completed sessions", () => {
  assert.match(sql, /when \(old\.status = 'active' and new\.status = 'completed'\)/);
  assert.equal((sql.match(/perform public\.apply_student_practice_summary_increment/g) || []).length, 1);
  assert.match(sql, /union all select elapsed_seconds::bigint,completed_at from public\.reading_question_category_sessions[\s\S]*status = 'completed'/);
  assert.match(sql, /old\.status = 'completed'[\s\S]*READING_INVALID_COMPLETED_CATEGORY_MUTATION/);
});
test("wrongbook + category share runner/dialog but adapter owns source editability", () => {
  for (const file of ["ReadingWrongbookBankPractice", "QuestionCategoryPractice"]) assert.match(read(`components/reading/${file}.tsx`), /<ReadingMultiSourceSessionRunner/);
  for (const file of ["components/WrongQuestionsHome.tsx", "components/reading/QuestionCategoryPracticeHome.tsx"]) assert.match(read(file), /<PracticeAmountDialog/);
  const submitBlock = runner.slice(runner.indexOf("const completeWorkspace"), runner.indexOf("const progressLabelResolver"));
  assert.ok(submitBlock.indexOf('!adapterRef.current.isSourceEditable') < submitBlock.indexOf("adapterRef.current.submit"));
  assert.match(read("components/reading/ReadingWrongbookBankPractice.tsx"), /isSourceEditable: \(source\) => source\.attempt\.status !== "submitted"/);
  assert.match(read("components/reading/QuestionCategoryPractice.tsx"), /isSourceEditable: \(_source, session\) => session\.status === "active"/);
  assert.match(runner, /groups\[groupIndex \+ 1\]/);
  assert.doesNotMatch(runner, /Promise\.all\(groups|groups\.map\(.*fetch/);
  assert.doesNotMatch(read("components/reading/QuestionCategorySessionReview.tsx"), /backgroundPrefetch|Promise\.all\(session\.groups/);
});
test("refresh loads pinned identity and restores answers/index/time without a new draw", () => {
  const client = read("components/reading/QuestionCategoryPractice.tsx");
  assert.match(client, /if \(pinned\) \{[\s\S]*await loadCategorySession\(pinned, auth\)/);
  assert.match(client, /url\.searchParams\.set\("session", practiceSession\.sessionId\)/);
  assert.match(client, /sessionStorage\.setItem/);
  assert.match(client, /categoryWorkspace\(session, group.logicalItemId\)/);
  assert.match(editableSQL, /if v_session.status = 'completed' then return/);
  assert.match(runner, /workspaces\.current/);
  assert.match(runner, /restored - \(groupReady\.persistedElapsedSeconds \?\? 0\)/);
});

test("API RPC names and named arguments match the effective SQL after manual incremental migration", () => {
  const routes = [
    "app/api/reading/question-category/route.ts",
    "app/api/reading/question-category/sessions/[sessionId]/route.ts",
    "app/api/reading/question-category/sessions/[sessionId]/groups/[itemId]/route.ts",
    "app/api/reading/question-category/sessions/[sessionId]/groups/[itemId]/review/route.ts"
  ];
  let calls = 0;
  for (const route of routes) {
    for (const match of read(route).matchAll(/\.rpc\("([^"]+)"(?:,\s*\{([^}]+)\})?\)/g)) {
      const signature = (match[1] === "submit_reading_question_category_group" ? editableSQL : sql)
        .match(new RegExp(`create function public\\.${match[1]}\\(([^)]*)\\)`));
      assert.ok(signature, `${route}: unknown RPC ${match[1]}`);
      const expected = [...signature[1].matchAll(/\b(p_\w+)\s+(?:uuid|text|integer|jsonb|boolean|bigint)\b/g)].map((arg) => arg[1]).sort();
      const actual = [...(match[2] || "").matchAll(/\b(p_\w+)\s*:/g)].map((arg) => arg[1]).sort();
      assert.deepEqual(actual, expected, `${route}: RPC argument mismatch`);
      calls++;
    }
  }
  assert.equal(calls, 5);
});

test("post-migration owner SELECT, server-only create and JSON payload stay aligned", () => {
  const domain = read("lib/reading/questionCategory.ts");
  for (const constant of ["CATEGORY_SESSION_TABLE", "CATEGORY_ANSWER_TABLE"]) {
    const table = domain.match(new RegExp(`${constant} = "([^"]+)"`))[1];
    assert.ok(sql.includes(`create table public.${table} (`));
  }
  const sessionJSON = sql.slice(sql.indexOf("create function public.reading_category_session_json"), sql.indexOf("create function public.reading_category_answers_json"));
  for (const key of ["sessionId", "questionCategory", "amount", "groups", "progress", "draft", "status", "elapsedSeconds", "totalPoints", "correctPoints", "createdAt", "completedAt"]) {
    assert.ok(sessionJSON.includes(`'${key}'`), `Missing session JSON key ${key}`);
  }
  const answerJSON = sql.slice(sql.indexOf("create function public.reading_category_answers_json"), sql.indexOf("revoke all on function public.reading_category_session_json"));
  for (const key of ["answerId", "logicalItemId", "questionId", "answerKind", "studentAnswer", "isCorrect", "questionTimeSeconds"]) {
    assert.ok(answerJSON.includes(`'${key}'`), `Missing answer JSON key ${key}`);
  }
  assert.match(sql, /'logicalItemId',p_logical_item_id,'workspace',p_draft/);
  assert.match(sql, /'correctPoints',v_correct,'totalPoints',v_total,'elapsedSeconds',p_elapsed_seconds,'submittedAt',now\(\)/);
  assert.match(sql, /using \(student_id = auth\.uid\(\) and public\.can_use_student_experience\(\)\)/);
  const route = read("app/api/reading/question-category/route.ts");
  assert.match(route, /createCategorySession\(createServiceSupabase\(\), auth\.userId/);
  assert.match(route, /auth\.client\.rpc\("reading_question_category_counts"\)/);
  assert.doesNotMatch(read("lib/reading/questionCategory.client.ts"), /service_role|createServiceSupabase|\.from\(/);
});
