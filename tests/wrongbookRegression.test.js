const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildReadingSessionGroups,
  WRONG_QUESTION_QUESTION_SLOT
} = require("../lib/wrongQuestionBank.ts");
const {
  buildReadingWrongbookSessionSteps,
  buildReadingWrongbookSessionReviewPayload,
  mergeReadingWrongbookSessionResults,
  readingWrongbookSessionGroupStarts,
  readingWrongbookSessionProgressLabel
} = require("../lib/reading/wrongbookSession.ts");
const {
  selectReadingWrongbookSubmissionAnswers
} = require("../lib/reading/wrongbook.ts");
const {
  readingQuestionNavigationTargets
} = require("../lib/reading/practiceState.ts");
const {
  safeStudentReturnTo,
  withStudentReturnTo
} = require("../lib/studentNavigation.ts");

const projectRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// A. Retake / Correction button geometry
// ---------------------------------------------------------------------------

test("A1. Reading result Retake and Correction share one shared button size rule", () => {
  const styles = read("app/globals.css");
  const retake = read("components/reading/ReadingRetakeButton.tsx");
  const correction = read("components/reading/ReadingCorrectionEntryButton.tsx");

  // One shared rule defines the geometry for every student button variant.
  const baseRule = styles.slice(
    styles.indexOf(".student-button-primary,"),
    styles.indexOf(".student-button-primary {")
  );
  assert.match(baseRule, /\.student-button-correction \{/);
  assert.match(baseRule, /min-h-10[\s\S]*rounded-\[10px\][\s\S]*px-4[\s\S]*py-2[\s\S]*text-sm/);
  assert.match(styles, /\.student-button-correction \{\n    @apply border border-student-error-border/);

  // Retake keeps the shared primary class; correction uses the shared
  // correction class and no longer maintains its own smaller geometry.
  assert.match(retake, /"student-button-primary"/);
  assert.match(correction, /className="student-button-correction"/);
  assert.doesNotMatch(correction, /min-h-9|px-3\.5|py-1\.5/);
});

test("A2. BAS result correction reuses the same shared correction button class", () => {
  const result = read("components/PracticeResult.tsx");
  const resultButtonSource = result.slice(
    result.indexOf("function CorrectionEntryButton"),
    result.indexOf("export function PracticeResultView")
  );
  assert.match(resultButtonSource, /className="student-button-correction"/);
  assert.doesNotMatch(resultButtonSource, /min-h-9|px-3\.5|py-1\.5/);
});

test("A3. Full Set result Retake and Correction share the same shared classes", () => {
  const result = read("components/reading/ReadingFullSetResult.tsx");
  const retake = read("components/reading/ReadingFullSetRetakeButton.tsx");
  const correction = read("components/reading/ReadingCorrectionEntryButton.tsx");

  assert.match(result, /<ReadingFullSetRetakeButton fullSetId=\{fullSetId\} \/>/);
  assert.match(result, /<ReadingFullSetCorrectionEntryButton attemptId=\{attemptId\} \/>/);
  assert.match(retake, /"student-button-primary"/);
  assert.match(correction, /className="student-button-correction"[\s\S]*data-testid="reading-full-set-correction-entry"/);
});

// ---------------------------------------------------------------------------
// B. returnTo travels through every entry correction surface
// ---------------------------------------------------------------------------

test("B. entry corrections carry returnTo through practice, submit, and result", () => {
  const readingButton = read("components/reading/ReadingCorrectionEntryButton.tsx");
  assert.match(readingButton, /window\.location\.pathname/);
  assert.match(readingButton, /entry\/reading\/practice/);

  const entryPage = read("app/student/wrong-questions/entry/reading/practice/page.tsx");
  assert.match(entryPage, /safeStudentReturnTo\(searchParams\.returnTo\)/);

  const bank = read("components/reading/ReadingWrongbookBankPractice.tsx");
  assert.match(bank, /onSubmitted: \(submittedAttempt\) => router\.replace/);
  assert.match(bank, /withStudentReturnTo\(\n?\s*`\/student\/reading\/wrongbook-results\/\$\{encodeURIComponent\(submittedAttempt\.attemptId\)\}`/);

  const wrongbookResult = read("components/reading/ReadingWrongbookResult.tsx");
  assert.match(wrongbookResult, /getReadingCorrectionResultNavigation\(returnTo, attempt\.taskType/);
  assert.match(wrongbookResult, /backHref=\{navigation\.backHref\}/);
  assert.match(wrongbookResult, /questionHref=\{\(reviewIndex\) =>[\s\S]*withStudentReturnTo/);

  const reviewPage = read("app/student/reading/wrongbook-results/[attemptId]/questions/[questionIndex]/page.tsx");
  assert.match(reviewPage, /safeStudentReturnTo\(searchParams\.returnTo\)/);
  const review = read("components/reading/ReadingWrongbookReview.tsx");
  assert.match(review, /withStudentReturnTo\(\n?\s*`\/student\/reading\/wrongbook-results\/\$\{encodeURIComponent\(attemptId\)\}`,\n?\s*returnTo/);
});

test("B. BAS entry correction keeps returnTo on the result page and resume URL", () => {
  const result = read("components/PracticeResult.tsx");
  assert.match(result, /scope: "entry"/);
  assert.match(result, /window\.location\.pathname/);

  const historyPage = read("app/student/wrong-questions/history/practice/page.tsx");
  assert.match(historyPage, /safeStudentReturnTo\(searchParams\.returnTo\)/);

  const practice = read("components/WrongQuestions.tsx");
  assert.match(practice, /returnTo=\{returnTo\}/);

  const session = read("components/PracticeSession.tsx");
  assert.match(session, /router\.push\(withStudentReturnTo\(`\/student\/results\/\$\{payload\.attemptId\}`\, returnTo\)\)/);

  const navigation = read("lib/studentNavigation.ts");
  assert.match(navigation, /const safeReturnTo = safeStudentReturnTo\(options\?\.returnTo\)/);
});

test("B. Full Set correction keeps returning to the Full Set result", () => {
  const fullSetPractice = read("components/reading/ReadingFullSetWrongbookPractice.tsx");
  assert.match(fullSetPractice, /router\.replace\(withStudentReturnTo\(\n?\s*`\/student\/reading\/wrongbook-results\/\$\{encodeURIComponent\(attempt\.attemptId\)\}`,\n?\s*returnTo/);
  const fullSetResult = read("components/reading/ReadingFullSetResult.tsx");
  assert.match(fullSetResult, /getReadingFullSetResultNavigation\(/);
});

test("B. session result and session review both restore each other through returnTo", () => {
  const result = read("components/reading/ReadingWrongbookSessionResult.tsx");
  assert.match(result, /const selfPath = withStudentReturnTo\(selfBase, safeReturnTo\)/);
  assert.match(result, /withStudentReturnTo\(`\$\{selfBase\}\/questions\/\$\{reviewIndex\}`, safeReturnTo\)/);
  assert.match(result, /backHref=\{safeReturnTo \|\| STUDENT_ROUTES\.wrongQuestions\}/);
  assert.match(result, /returnTo: selfPath/);

  const reviewPage = read("app/student/wrong-questions/sessions/[sessionId]/questions/[questionIndex]/page.tsx");
  assert.match(reviewPage, /safeStudentReturnTo\(searchParams\.returnTo\)/);
  const review = read("components/reading/ReadingSessionBundleReview.tsx");
  assert.match(review, /router\.push\(withStudentReturnTo\(base, returnTo\)\)/);
  assert.match(review, /withStudentReturnTo\(`\$\{base\}\/questions\/\$\{index\}`, returnTo\)/);
  // The session review never offers an entry correction: entry corrections are
  // only offered from a single-item practice result / read-only review.
  assert.doesNotMatch(review, /correctionReturnTo|ReadingCorrectionEntryButton/);
  const shell = read("components/reading/ReadingPractice.tsx");
  assert.doesNotMatch(shell, /correctionAttemptId|correctionReturnTo/);
  const button = read("components/reading/ReadingCorrectionEntryButton.tsx");
  assert.match(button, /const origin = returnTo\?\.trim\(\)/);
  assert.match(button, /returnTo: origin/);
});

test("B. returnTo survives URL round-trips and refresh-safe parsing", () => {
  const result = "/student/reading/results/11111111-1111-4111-8111-111111111111?source=practice-history";
  const entry = withStudentReturnTo(
    "/student/wrong-questions/entry/reading/practice",
    result
  );
  const parsed = new URL(entry, "https://tps.local");
  assert.equal(parsed.searchParams.get("returnTo"), result);
  assert.equal(safeStudentReturnTo(parsed.searchParams.get("returnTo")), result);

  const nested = withStudentReturnTo(
    "/student/reading/wrongbook-results/22222222-2222-4222-8222-222222222222",
    result
  );
  assert.equal(
    safeStudentReturnTo(new URL(nested, "https://tps.local").searchParams.get("returnTo")),
    result
  );
  assert.equal(safeStudentReturnTo("https://evil.example/steal"), undefined);
  assert.equal(safeStudentReturnTo("/teacher/x"), undefined);
});

// ---------------------------------------------------------------------------
// C. BAS history session cannot redraw after creation
// ---------------------------------------------------------------------------

test("C. BAS history session is pinned in state and only ever resumed by id", () => {
  const practice = read("components/WrongQuestions.tsx");

  // Single in-flight creation per creation query; invalidation refetches resume.
  assert.match(practice, /const basSessionCreations = new Map/);
  assert.match(practice, /const inFlight = basSessionCreations\.get\(query\)/);
  assert.match(practice, /if \(existingSessionId\) \{[\s\S]*\/api\/wrong-questions\/sessions\/\$\{encodeURIComponent\(existingSessionId\)\}/);
  assert.match(practice, /basSessionCreations\.set\(query, creation\)/);
  assert.match(practice, /basSessionCreations\.delete\(query\)/);

  // The created id is pinned into React state + cache + URL together.
  assert.match(practice, /const \[pinnedSessionId, setPinnedSessionId\] = useState\(""\)/);
  assert.match(practice, /const activeSessionId = historySession \? \(sessionId \?\? pinnedSessionId\) : ""/);
  assert.match(practice, /setPinnedSessionId\(createdSessionId\)/);
  assert.match(practice, /url\.searchParams\.set\("session", createdSessionId\)/);
  assert.match(practice, /cache\.setData\([\s\S]*bas-session:\$\{pinnedQuery\}/);

  // The freeze snapshot is never replaced by a refetch result...
  assert.match(practice, /questionSnapshot\?\.key === sessionKey/);
  // ...and a degraded refetch never replaces the frozen practice with a loader.
  assert.doesNotMatch(practice, /if \(activeState\.loading \|\| !sessionQuestions\)/);
  assert.match(practice, /if \(!sessionQuestions\) \{[\s\S]*StudentLoadingState/);

  // After the last question the flow only pushes the session result page.
  const session = read("components/PracticeSession.tsx");
  assert.match(session, /if \(isLastQuestion\) \{[\s\S]*await submitAll\(savedAnswers\)/);
  assert.match(session, /router\.push\(withStudentReturnTo\(`\/student\/results\/\$\{payload\.attemptId\}`\, returnTo\)\)/);
});

// ---------------------------------------------------------------------------
// D. Reading session grouping: source aggregation frozen at creation
// ---------------------------------------------------------------------------

test("D. a draw of A1, B1, A2 aggregates into contiguous sources", () => {
  const groups = buildReadingSessionGroups({
    questionOrderById: new Map([["a1", 1], ["a2", 2], ["b1", 1]]),
    targets: [
      { logicalItemId: "item-a", questionId: "a1", slotId: null },
      { logicalItemId: "item-b", questionId: "b1", slotId: null },
      { logicalItemId: "item-a", questionId: "a2", slotId: null }
    ],
    titles: new Map([["item-a", "Article A"], ["item-b", "Article B"]])
  });

  // A never reopens after B: the aggregated order is A1,A2,B1 (B first when the
  // first draw is B1). No A -> B -> A sequence exists.
  assert.deepEqual(groups.map((group) => group.logicalItemId), ["item-a", "item-b"]);
  assert.deepEqual(groups[0].targets.map((target) => target.questionId), ["a1", "a2"]);
  assert.deepEqual(groups[1].targets.map((target) => target.questionId), ["b1"]);

  const bFirst = buildReadingSessionGroups({
    questionOrderById: new Map([["a1", 1], ["a2", 2], ["b1", 1]]),
    targets: [
      { logicalItemId: "item-b", questionId: "b1", slotId: null },
      { logicalItemId: "item-a", questionId: "a2", slotId: null },
      { logicalItemId: "item-a", questionId: "a1", slotId: null }
    ],
    titles: new Map([["item-a", "Article A"], ["item-b", "Article B"]])
  });
  assert.deepEqual(bFirst.map((group) => group.logicalItemId), ["item-b", "item-a"]);
  assert.deepEqual(bFirst[1].targets.map((target) => target.questionId), ["a1", "a2"]);
});

test("D. session steps keep one global 1..N order across sources", () => {
  const groups = [
    { logicalItemId: "item-a", title: "A", targets: [{ questionId: "a1", slotId: null }, { questionId: "a2", slotId: null }] },
    { logicalItemId: "item-b", title: "B", targets: [{ questionId: "b1", slotId: null }] }
  ];
  const steps = buildReadingWrongbookSessionSteps(groups);
  assert.deepEqual(steps.map((step) => [step.globalIndex, step.questionId]), [
    [0, "a1"], [1, "a2"], [2, "b1"]
  ]);
  assert.deepEqual(readingWrongbookSessionGroupStarts(groups), [0, 2]);
});

// ---------------------------------------------------------------------------
// E. Reading action semantics: Next between sources, Submit only at the end
// ---------------------------------------------------------------------------

test("E. intermediate sources finish with Next; only the final workspace submits", () => {
  const bank = read("components/reading/ReadingMultiSourceSessionRunner.tsx");
  assert.match(bank, /completionLabel: groupIndex \+ 1 < groups\.length \? "Next" : "Submit"/);
  assert.match(bank, /if \(groupIndex \+ 1 < groups\.length\) setGroupIndex\(groupIndex \+ 1\)/);

  const shell = read("components/reading/ReadingPractice.tsx");
  assert.match(shell, /submitLabel = "Submit"/);
  assert.match(shell, /label=\{submitLabel\}/);
  assert.match(shell, /onSubmit=\{session \? completeWorkspace : submit\}/);
  assert.doesNotMatch(shell, /Submit Module/);
});

test("E. unanswered targets submit as answered-empty rows instead of a rejected null", () => {
  const answers = selectReadingWrongbookSubmissionAnswers(
    [
      { kind: "option", questionId: "q1", questionTimeSeconds: 3, studentAnswer: null },
      { kind: "option", questionId: "q2", questionTimeSeconds: 1, studentAnswer: "option-a" },
      { kind: "option", questionId: "q3", questionTimeSeconds: 2, studentAnswer: "option-b" }
    ],
    [
      { questionId: "q1", slotId: null },
      { questionId: "q2", slotId: null }
    ]
  );
  assert.deepEqual(answers, [
    { kind: "option", questionId: "q1", questionTimeSeconds: 3, studentAnswer: "" },
    { kind: "option", questionId: "q2", questionTimeSeconds: 1, studentAnswer: "option-a" }
  ]);
});

// ---------------------------------------------------------------------------
// F. Reading shell stability across source switches
// ---------------------------------------------------------------------------

test("F. the session shell stays mounted; only the workspace shows local pending", () => {
  const bank = read("components/reading/ReadingMultiSourceSessionRunner.tsx");
  const shell = read("components/reading/ReadingPractice.tsx");

  // One shell instance for the whole session, rendered from the last fully
  // loaded source while the next one loads.
  assert.match(bank, /const \[retained, setRendered\] = useState/);
  assert.match(bank, /const pending = !rendered \|\| rendered\.logicalItemId !== group\?\.logicalItemId/);
  assert.match(bank, /reviewTitle=\{sessionTitle\}/);
  assert.match(bank, /elapsedSeconds: sessionElapsed/);
  const sessionShell = bank.slice(
    bank.indexOf("return <ReadingPracticeShell"),
    bank.indexOf("export function ReadingSessionMessage")
  );
  assert.doesNotMatch(sessionShell, /key=\{/);

  // The in-shell pending replaces only the workspace, not the header/timer.
  assert.match(shell, /data-testid="reading-session-workspace-pending"/);
  assert.match(shell, /session\?\.pending \? \([\s\S]*reading-session-workspace-pending[\s\S]*\) : \(\n\s+<ReadingWorkspaceRouter/);
  assert.match(shell, /navigationDisabled=\{Boolean\(session\?\.navigationDisabled \|\| session\?\.pending\)\}/);

  // The elapsed timer is session-owned and pauses while a source is loading.
  assert.match(shell, /elapsedSeconds=\{session \? session\.elapsedSeconds : elapsedSeconds \+ elapsedOffsetSeconds\}/);
  assert.match(shell, /if \(readOnly \|\| session \|\| attempt\.status === "submitted"\) return;/);
  assert.match(bank, /flushElapsed\(\);/);
  assert.match(bank, /clock\.current\.startedAt === null/);
  // The workspace router remounts per source inside the stable shell.
  assert.match(shell, /key=\{practice\.item\.itemId\}/);
});

// ---------------------------------------------------------------------------
// G. History session result / review reuse the normal Reading surfaces
// ---------------------------------------------------------------------------

test("G. history session result uses the normal result structure with 1..N chips", () => {
  const result = read("components/reading/ReadingWrongbookSessionResult.tsx");
  assert.match(result, /PracticeResultSummary/);
  assert.match(result, /ReadingResultDetailCard/);
  assert.match(result, /student-result-overview-layout/);
  assert.doesNotMatch(result, /WRONG_QUESTION_BANK_LABELS|已订正|查看订正结果/);
  assert.doesNotMatch(result, /<ul|<li/);
  assert.doesNotMatch(result, /按材料|材料名称/);

  const merged = mergeReadingWrongbookSessionResults([
    {
      group: { logicalItemId: "a", title: "A", targets: [{ questionId: "a1", slotId: null }] },
      payload: {
        answers: [
          { answerId: "a1", order: 1, isAnswered: true, isCorrect: false, questionId: "a1", questionTimeSeconds: 4 },
          { answerId: "a2", order: 2, isAnswered: false, isCorrect: false, questionId: "a2", questionTimeSeconds: 0 }
        ],
        attempt: { correctPoints: 1, elapsedSeconds: 7, totalPoints: 2 }
      }
    },
    {
      group: { logicalItemId: "b", title: "B", targets: [{ questionId: "b1", slotId: null }] },
      payload: {
        answers: [
          { answerId: "b1", order: 1, isAnswered: true, isCorrect: true, questionId: "b1", questionTimeSeconds: 3 }
        ],
        attempt: { correctPoints: 1, elapsedSeconds: 5, totalPoints: 1 }
      }
    }
  ]);
  assert.deepEqual(merged.answers.map((answer) => [answer.globalOrder, answer.reviewIndex, answer.groupIndex]), [
    [1, 0, 0], [2, 1, 0], [3, 2, 1]
  ]);
  assert.equal(merged.correctPoints, 2);
  assert.equal(merged.totalPoints, 3);
  assert.equal(merged.elapsedSeconds, 12);
});

test("G. session review concatenates sources with global order and cross-source navigation", () => {
  const groupReviews = [
    {
      group: { logicalItemId: "item-a", title: "A", targets: [{ questionId: "a1", slotId: null }] },
      payload: {
        answers: {},
        attempt: { attemptId: "attempt-a" },
        disclosures: { "answer-a": { correctAnswer: { kind: "text", text: "A" }, studentAnswer: "" } },
        practice: { item: { itemId: "item-a", module: "rdl", title: "A" }, questions: [] },
        reviewItems: [{
          answerId: "answer-a",
          order: 1,
          isAnswered: true,
          isCorrect: false,
          questionId: "a1",
          slotId: null,
          questionTimeSeconds: 4
        }]
      }
    },
    {
      group: { logicalItemId: "item-b", title: "B", targets: [{ questionId: "b1", slotId: null }] },
      payload: {
        answers: {},
        attempt: { attemptId: "attempt-b" },
        disclosures: { "answer-b": { correctAnswer: { kind: "text", text: "B" }, studentAnswer: "" } },
        practice: { item: { itemId: "item-b", module: "rap", title: "B" }, questions: [] },
        reviewItems: [{
          answerId: "answer-b",
          order: 1,
          isAnswered: true,
          isCorrect: true,
          questionId: "b1",
          slotId: null,
          questionTimeSeconds: 2
        }]
      }
    }
  ];
  const payload = buildReadingWrongbookSessionReviewPayload({
    groupReviews,
    reviewHref: (globalIndex) => `/student/wrong-questions/sessions/session-1/questions/${globalIndex}`,
    sessionId: "session-1",
    taskType: "rdl",
    title: "历史错题练习"
  });

  assert.equal(payload.reviewItems.length, 2);
  assert.deepEqual(payload.reviewItems.map((item) => [item.order, item.sourceAnswerIndex, item.occurrenceId]), [
    [1, 0, "item-a"], [2, 1, "item-b"]
  ]);
  assert.equal(payload.reviewItems[0].href, "/student/wrong-questions/sessions/session-1/questions/0");
  assert.equal(payload.reviewItems[1].href, "/student/wrong-questions/sessions/session-1/questions/1");
  assert.deepEqual(payload.occurrences.map((occurrence) => occurrence.occurrenceId), ["item-a", "item-b"]);
  // Each source keeps its own correction attempt for the entry-correction
  // action shown on the session review.
  assert.deepEqual(
    payload.occurrences.map((occurrence) => [occurrence.attemptId, occurrence.hasWrong]),
    [["attempt-a", true], ["attempt-b", false]]
  );

  // Previous / Next step across sources when the next global item belongs to
  // another source.
  const keys = payload.reviewItems.map((item) => `${item.occurrenceId}:${item.questionId}`);
  assert.deepEqual(readingQuestionNavigationTargets(keys, 0).nextIndex, 1);
  assert.deepEqual(readingQuestionNavigationTargets(keys, 1).previousIndex, 0);
});

test("G. history session surfaces keep the Reading hue, not the writing purple", () => {
  // The sessions route lives under /student/wrong-questions, outside the
  // /student/reading layout, so the session result must carry the reading theme
  // itself; the review shell already does.
  const result = read("components/reading/ReadingWrongbookSessionResult.tsx");
  assert.match(result, /<div className="reading-theme student-result-overview-layout">/);
  const shell = read("components/reading/ReadingPractice.tsx");
  const reviewShell = shell.slice(
    shell.indexOf("export function ReadingFullSetReviewShell"),
    shell.indexOf("export type ReadingPracticeSessionControl")
  );
  assert.match(reviewShell, /className="reading-theme min-h-\[100dvh\]/);
});

test("G. session result and review pages are wired to the session", () => {
  const resultPage = read("app/student/wrong-questions/sessions/[sessionId]/page.tsx");
  assert.match(resultPage, /ReadingWrongbookSessionResult/);
  assert.match(resultPage, /safeStudentReturnTo\(searchParams\.returnTo\)/);
  const reviewPage = read("app/student/wrong-questions/sessions/[sessionId]/questions/[questionIndex]/page.tsx");
  assert.match(reviewPage, /ReadingWrongbookSessionReview/);
  const review = read("components/reading/ReadingSessionBundleReview.tsx");
  assert.match(review, /ReadingFullSetReviewShell/);
  assert.match(review, /variant="session"/);
});

// ---------------------------------------------------------------------------
// H. CTW global numbering format
// ---------------------------------------------------------------------------

test("H. CTW single scoring point shows X / N and multiple slots show X–Y / N", () => {
  assert.equal(
    readingWrongbookSessionProgressLabel({
      currentIndex: 0,
      groupStart: 4,
      module: "ctw",
      targetCount: 1,
      totalPoints: 15
    }),
    "第 5 / 15 题"
  );
  assert.equal(
    readingWrongbookSessionProgressLabel({
      currentIndex: 0,
      groupStart: 4,
      module: "ctw",
      targetCount: 3,
      totalPoints: 15
    }),
    "第 5–7 / 15 题"
  );
  // X–X is impossible by construction.
  for (const targetCount of [1, 2, 5]) {
    const label = readingWrongbookSessionProgressLabel({
      currentIndex: 0,
      groupStart: 4,
      module: "ctw",
      targetCount,
      totalPoints: 15
    });
    assert.doesNotMatch(label, /–5 \/ 15/);
  }
  // RDL / RAP workspaces are one scoring point each and keep session-global
  // numbering.
  assert.equal(
    readingWrongbookSessionProgressLabel({
      currentIndex: 1,
      groupStart: 3,
      module: "rdl",
      targetCount: 2,
      totalPoints: 15
    }),
    "第 5 / 15 题"
  );
});

test("H. wrong-question entry identity still counts CTW slots as scoring points", () => {
  assert.equal(WRONG_QUESTION_QUESTION_SLOT, "question");
  const groups = buildReadingSessionGroups({
    questionOrderById: new Map([["q1", 1]]),
    targets: [
      { logicalItemId: "item-a", questionId: "q1", slotId: "slot-2" },
      { logicalItemId: "item-a", questionId: "q1", slotId: "slot-1" }
    ],
    titles: new Map([["item-a", "A"]])
  });
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].targets.map((target) => target.slotId), ["slot-1", "slot-2"]);
});
