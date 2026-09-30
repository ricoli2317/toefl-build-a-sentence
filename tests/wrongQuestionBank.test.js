const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  basWrongQuestionEvents,
  buildReadingSessionGroups,
  normalizeWrongQuestionHistoryAmount,
  readingCorrectionEvents,
  readingWrongAnswerEvents,
  wrongQuestionAmountOptions,
  wrongQuestionBankKey,
  wrongQuestionPracticeCount
} = require("../lib/wrongQuestionBank.ts");

const projectRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("wrong-question bank identity is canonical and occurrence-free", () => {
  // BAS reuses the existing content-level wrongbook dedupe rule: the sentence
  // key when the question has one, the question fallback otherwise. A bare
  // question_id is never used when content identity exists.
  assert.equal(
    wrongQuestionBankKey({
      finalSentence: "  The   cat sleeps. ",
      questionId: "bas-q",
      taskType: "bas"
    }),
    "sentence:The cat sleeps."
  );
  assert.equal(wrongQuestionBankKey({ questionId: "bas-q", taskType: "bas" }), "question:bas-q");
  assert.equal(
    wrongQuestionBankKey({
      logicalItemId: "reading-rdl-0123456789abcdef01234567",
      questionId: "reading-rdl-q1",
      slotId: null,
      taskType: "rdl"
    }),
    "reading-rdl-0123456789abcdef01234567:reading-rdl-q1:question"
  );
  assert.equal(
    wrongQuestionBankKey({
      logicalItemId: "reading-ctw-0123456789abcdef01234567",
      questionId: "reading-ctw-q1",
      slotId: "slot-2",
      taskType: "ctw"
    }),
    "reading-ctw-0123456789abcdef01234567:reading-ctw-q1:slot-2"
  );
});

test("5 / 10 / 15 / 20 enablement follows the history count rule", () => {
  const options = (count) => wrongQuestionAmountOptions(count)
    .map((option) => [option.amount, option.enabled, option.shortfallHint]);

  assert.deepEqual(options(0), [
    [5, false, null], [10, false, null], [15, false, null], [20, false, null]
  ]);
  assert.deepEqual(options(3), [
    [5, true, "当前历史错题共 3 道"], [10, false, null], [15, false, null], [20, false, null]
  ]);
  assert.deepEqual(options(8), [
    [5, true, null], [10, true, "当前历史错题共 8 道"], [15, false, null], [20, false, null]
  ]);
  assert.deepEqual(options(12), [
    [5, true, null], [10, true, null], [15, true, "当前历史错题共 12 道"], [20, false, null]
  ]);
  assert.deepEqual(options(18), [
    [5, true, null], [10, true, null], [15, true, null], [20, true, "当前历史错题共 18 道"]
  ]);
  assert.deepEqual(options(25), [
    [5, true, null], [10, true, null], [15, true, null], [20, true, null]
  ]);

  // Never pad a session with duplicate questions.
  assert.equal(wrongQuestionPracticeCount(10, 8), 8);
  assert.equal(wrongQuestionPracticeCount(5, 8), 5);
  assert.equal(wrongQuestionPracticeCount(20, 0), 0);
});

test("formal practice creates pending while repeated wrongs stay idempotent", () => {
  const formal = basWrongQuestionEvents({
    answers: [
      { finalSentence: "One sentence.", isCorrect: false, questionId: "a" },
      { finalSentence: "Another sentence.", isCorrect: true, questionId: "b" }
    ],
    official: true,
    setId: "20260830-1"
  });
  assert.deepEqual(formal.map((event) => [event.event, event.questionKey]), [
    ["wrong", "sentence:One sentence."]
  ]);

  // Virtual sets and non-official sets never create pending state.
  assert.deepEqual(basWrongQuestionEvents({
    answers: [{ finalSentence: "One sentence.", isCorrect: false, questionId: "a" }],
    official: true,
    setId: "wrongbook-random-20260930-120000"
  }), []);
  assert.deepEqual(basWrongQuestionEvents({
    answers: [{ finalSentence: "One sentence.", isCorrect: false, questionId: "a" }],
    official: false,
    setId: "20260830-1"
  }), []);
  assert.deepEqual(basWrongQuestionEvents({
    answers: [{ finalSentence: "One sentence.", isCorrect: false, questionId: "a" }],
    official: false,
    setId: "grammar-all-20260930"
  }), []);

  const readingWrong = readingWrongAnswerEvents({
    answers: [
      { isCorrect: false, questionId: "q", slotId: null },
      { isCorrect: true, questionId: "q2", slotId: null }
    ],
    logicalItemId: "reading-rdl-item",
    taskType: "rdl"
  });
  assert.deepEqual(readingWrong.map((event) => [event.event, event.questionKey]), [
    ["wrong", "reading-rdl-item:q:question"]
  ]);
});

test("live BAS writes and the backfill share one content identity", () => {
  const { buildWrongQuestionBackfillHistory } = require("../lib/wrongQuestionBankBackfill.ts");
  const liveEvents = basWrongQuestionEvents({
    answers: [
      { finalSentence: "Shared logical question.", isCorrect: false, questionId: "bas-source-a-q7" }
    ],
    official: true,
    setId: "20260930-1"
  });
  const backfilled = buildWrongQuestionBackfillHistory([
    {
      eventDate: "2026-09-30",
      eventTimeMs: 1,
      finalSentence: "Shared logical question.",
      isCorrect: false,
      kind: "formal",
      questionId: "bas-source-b-q3",
      studentId: "student-1",
      taskType: "bas"
    }
  ]);

  assert.equal(liveEvents.length, 1);
  assert.equal(backfilled.length, 1);
  assert.equal(liveEvents[0].questionKey, backfilled[0].key);
});

test("corrections clear pending only in the clearing flows", () => {
  // Today practice / formal-result entry corrections clear.
  assert.deepEqual(readingCorrectionEvents({
    answers: [{ isCorrect: true, questionId: "q", slotId: null }],
    appliesToPending: true,
    logicalItemId: "reading-rdl-item",
    taskType: "rdl"
  }).map((event) => event.event), ["corrected"]);
  assert.deepEqual(basWrongQuestionEvents({
    answers: [
      { finalSentence: "First sentence.", isCorrect: true, questionId: "a" },
      { finalSentence: "Second sentence.", isCorrect: false, questionId: "b" }
    ],
    official: false,
    setId: "wrongbook-today-20260930"
  }).map((event) => [event.event, event.questionKey]), [["corrected", "sentence:First sentence."]]);

  // History practice corrections never touch pending or history membership.
  assert.deepEqual(readingCorrectionEvents({
    answers: [{ isCorrect: true, questionId: "q", slotId: null }],
    appliesToPending: false,
    logicalItemId: "reading-rdl-item",
    taskType: "rdl"
  }), []);
  assert.deepEqual(basWrongQuestionEvents({
    answers: [{ isCorrect: true, questionId: "a" }],
    official: false,
    setId: "wrongbook-random-20260930-120000"
  }), []);
});

test("Reading session grouping keeps the draw order and canonical question order", () => {
  const groups = buildReadingSessionGroups({
    questionOrderById: new Map([["a1", 1], ["a2", 2], ["b1", 1], ["b2", 2]]),
    targets: [
      { logicalItemId: "item-b", questionId: "b2", slotId: null },
      { logicalItemId: "item-a", questionId: "a2", slotId: null },
      { logicalItemId: "item-b", questionId: "b1", slotId: null },
      { logicalItemId: "item-a", questionId: "a1", slotId: null }
    ],
    titles: new Map([["item-a", "A"], ["item-b", "B"]])
  });

  // The draw order of the sources is frozen; inside a source the canonical
  // question order wins.
  assert.deepEqual(groups.map((group) => group.logicalItemId), ["item-b", "item-a"]);
  assert.deepEqual(groups[0].targets.map((target) => target.questionId), ["b1", "b2"]);
  assert.deepEqual(groups[1].targets.map((target) => target.questionId), ["a1", "a2"]);
  assert.deepEqual(groups.map((group) => group.title), ["B", "A"]);
});

test("practice-all-history is not executable through any entry point", () => {
  // One shared parser: only exactly 5 / 10 / 15 / 20 survives.
  assert.equal(normalizeWrongQuestionHistoryAmount(5), 5);
  assert.equal(normalizeWrongQuestionHistoryAmount("10"), 10);
  assert.equal(normalizeWrongQuestionHistoryAmount(20), 20);
  for (const invalid of [null, undefined, "", "all", 0, 1, 4, 6, 7, 25, 100]) {
    assert.equal(normalizeWrongQuestionHistoryAmount(invalid), null);
  }

  // The session API refuses a history session without an amount.
  const sessionsRoute = read("app/api/wrong-questions/sessions/route.ts");
  assert.match(sessionsRoute, /mode === "history" && amount === null/);
  assert.ok(sessionsRoute.includes("历史错题练习需要选择 5 / 10 / 15 / 20 题"));
  const guardIndex = sessionsRoute.indexOf("mode === \"history\" && amount === null");
  const createIndex = sessionsRoute.indexOf("createWrongQuestionPracticeSession({");
  assert.ok(guardIndex > 0 && createIndex > 0 && guardIndex < createIndex);

  // Manual `scope=history&mode=all` (and amount-less) URLs fall back to the home
  // where the 5 / 10 / 15 / 20 chooser lives; a frozen session may still resume.
  const basPage = read("app/student/wrong-questions/history/practice/page.tsx");
  assert.match(basPage, /mode !== "random" \|\| !amount/);
  assert.match(basPage, /redirect\("\/student\/wrong-questions"\)/);
  const readingPage = read("app/student/wrong-questions/history/reading/practice/page.tsx");
  assert.match(readingPage, /!sessionId && !amount/);
  assert.match(readingPage, /redirect\("\/student\/wrong-questions"\)/);
});

test("wrongbook home only issues the lightweight summary and modal count requests", () => {
  const home = read("components/WrongQuestionsHome.tsx");
  assert.match(home, /\/api\/wrong-questions\?view=summary/);
  assert.match(home, /view: "history-count"/);
  assert.match(home, /wrongQuestionAmountOptions/);
  assert.match(home, /WRONG_QUESTION_HISTORY_AMOUNTS/);
  assert.match(home, /道错题待订正/);
  assert.match(home, /今日错题已全部订正/);
  assert.match(home, /个题型已完成今日错题/);
  assert.doesNotMatch(home, /view=overview/);
  assert.doesNotMatch(home, /练习全部历史错题|浏览全部历史错题/);
  assert.doesNotMatch(home, /attempt_answers|reading_attempts|reading_wrongbook_attempts/);
});

test("wrong-question sessions freeze the draw and never bulk-load content", () => {
  const sessionsRoute = read("app/api/wrong-questions/sessions/route.ts");
  assert.match(sessionsRoute, /createWrongQuestionPracticeSession/);
  assert.match(sessionsRoute, /loadWrongQuestionPracticeSession/);
  const sessionRoute = read("app/api/wrong-questions/sessions/[sessionId]/route.ts");
  assert.match(sessionRoute, /loadWrongQuestionPracticeSession/);

  const bank = read("components/reading/ReadingWrongbookBankPractice.tsx");
  assert.match(bank, /preloadedRef/);
  assert.match(bank, /loadPractice\(next\.logicalItemId, session\)/);
  assert.match(bank, /progressLabelResolver/);
  assert.match(bank, /setSessionElapsed/);
  assert.match(bank, /url\.searchParams\.set\("session", serverSessionId\)/);

  const server = read("lib/wrongQuestionBank.server.ts");
  assert.match(server, /wrongQuestionPracticeCount/);
  assert.match(server, /buildReadingSessionGroups/);
  assert.match(server, /apply_student_wrong_question_events/);
});

test("student wrong-question migration defines the incremental bank and sessions", () => {
  const sql = read("supabase/student_wrong_questions.sql");
  assert.match(sql, /create table if not exists public\.student_wrong_questions/);
  assert.match(sql, /create index if not exists student_wrong_questions_pending_idx/);
  // Daily pending: one business date per row, no global boolean.
  assert.match(sql, /pending_date date/);
  assert.match(sql, /where pending_date is not null/);
  assert.doesNotMatch(sql, /is_pending/);
  assert.match(sql, /apply_student_wrong_question_events\(/);
  assert.match(sql, /p_practice_date date/);
  // Wrong: stamp today / re-date an older pending row, never double count.
  assert.match(sql, /set pending_date = excluded\.pending_date[\s\S]*where target\.pending_date is null[\s\S]*or target\.pending_date < excluded\.pending_date/);
  // Corrected: clear the pending date only.
  assert.match(sql, /set pending_date = null, corrected_at = now\(\)/);
  assert.match(sql, /create table if not exists public\.student_wrong_question_sessions/);
  assert.match(sql, /manifest jsonb not null/);
  assert.match(sql, /progress jsonb not null default '\{\}'::jsonb/);
  assert.match(sql, /grant execute on function public\.apply_student_wrong_question_events\(uuid, date, jsonb\) to service_role/);
});

test("daily pending uses the one server-side business date and never the client's", () => {
  const businessDate = read("lib/wrongQuestionBusinessDate.ts");
  assert.match(businessDate, /assignmentDateKey/);
  // One calendar rule: the module must not define a second timezone.
  assert.doesNotMatch(businessDate, /Intl\.DateTimeFormat|timeZone/);

  const route = read("app/api/wrong-questions/route.ts");
  assert.match(route, /wrongQuestionBusinessDate\(\)/);
  assert.match(route, /loadWrongQuestionPendingCounts\(auth\.db, auth\.userId, practiceDate\)/);
  assert.match(route, /loadPendingBasQuestionIds\(auth\.db, auth\.userId, practiceDate\)/);
  assert.doesNotMatch(route, /searchParams\.get\("practiceDate"\)|searchParams\.get\("todayStart"\)/);

  const server = read("lib/wrongQuestionBank.server.ts");
  assert.match(server, /\.eq\("pending_date", practiceDate\)/);
  assert.match(server, /"apply_student_wrong_question_events"/);
  assert.match(server, /p_practice_date: practiceDate/);
  assert.doesNotMatch(server, /\.eq\("is_pending", true\)/);
  assert.match(server, /pendingDate: input\.mode === "today" \? input\.practiceDate : undefined/);
});

test("entry corrections carry their origin page as returnTo on every result surface", () => {
  const practiceResult = read("components/PracticeResult.tsx");
  assert.match(practiceResult, /data-testid="wrong-question-correction-entry"/);
  assert.match(practiceResult, /window\.location\.pathname/);
  assert.match(practiceResult, /returnTo/);
  assert.match(practiceResult, /scope: "entry"/);

  const readingButton = read("components/reading/ReadingCorrectionEntryButton.tsx");
  assert.match(readingButton, /window\.location\.pathname/);
  assert.match(readingButton, /entry\/reading\/practice/);
  assert.match(readingButton, /taskType: "full_set"/);

  const readingResult = read("components/reading/ReadingResult.tsx");
  assert.match(readingResult, /ReadingCorrectionEntryButton/);
  const wrongbookResult = read("components/reading/ReadingWrongbookResult.tsx");
  assert.match(wrongbookResult, /ReadingCorrectionEntryButton/);
  const wrongbookReview = read("components/reading/ReadingWrongbookReview.tsx");
  assert.match(wrongbookReview, /ReadingCorrectionEntryButton/);
  const submittedReview = read("components/reading/ReadingPractice.tsx");
  assert.match(submittedReview, /ReadingCorrectionEntryButton/);
  const fullSetResult = read("components/reading/ReadingFullSetResult.tsx");
  assert.match(fullSetResult, /ReadingFullSetCorrectionEntryButton/);
});
