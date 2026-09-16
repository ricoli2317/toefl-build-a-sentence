const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  mergeReadingFullSetReviewWithHotOccurrences,
  isReadingFullSetReadonlySnapshot
} = require("../lib/reading/fullSetReadonlySnapshot.client.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const runner = read("components/reading/ReadingFullSetRunner.tsx");
const result = read("components/reading/ReadingFullSetResult.tsx");
const practice = read("components/reading/ReadingPractice.tsx");
const cache = read("components/StudentDataCache.tsx");
const submitRoute = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/submit/route.ts");

function practicePayload(itemId, module) {
  return {
    item: { itemId, module, productName: module, title: itemId, questionCount: 1, scoringPointCount: 1 },
    material: module === "rdl" ? { materialId: `${itemId}-material`, imageUrl: `${itemId}.png`, selectionMap: { hot: true } } : null,
    passage: module === "rdl" ? null : { passageId: `${itemId}-passage`, paragraphs: [{ text: "hot" }] },
    questions: [{ questionId: `${itemId}-question` }]
  };
}

function reviewOccurrence(id, module) {
  return {
    occurrenceId: id,
    moduleNumber: module === "ctw" ? 1 : 2,
    answers: { server: module },
    practice: practicePayload(`item-${id}`, module)
  };
}

test("final submit returns one authoritative result/review snapshot without another write", () => {
  assert.match(submitRoute, /submitted\.attempt\.status === "completed"/);
  assert.match(submitRoute, /loadReadingFullSetFinalSnapshot/);
  assert.match(submitRoute, /readonly_snapshot/);
  assert.match(submitRoute, /reuseOccurrenceIds: cachedOccurrenceIds/);
  assert.equal((submitRoute.match(/\.rpc\(rpcName/g) ?? []).length, 1);
  assert.doesNotMatch(submitRoute.slice(submitRoute.indexOf("let finalSnapshot")), /\.insert\(|\.update\(|\.upsert\(/);
});

test("submit success seeds result and readonly caches before runner state is discarded", () => {
  const submit = runner.slice(runner.indexOf("const submitModule = useCallback"), runner.indexOf("useEffect(() => {", runner.indexOf("const submitModule = useCallback")));
  assert.match(submit, /studentReadingFullSetResultCacheKey[\s\S]*setCachedData/);
  assert.match(submit, /mergeReadingFullSetReviewWithHotOccurrences[\s\S]*studentReadingFullSetReviewCacheKey/);
  assert.ok(submit.indexOf("studentReadingFullSetReviewCacheKey") < submit.indexOf("applyRunner({ ...current"));
});

test("result and Q1/Q35 readonly use the same attempt-keyed session cache", () => {
  assert.match(result, /studentReadingFullSetResultCacheKey\(attemptId\)/);
  assert.match(practice, /studentReadingFullSetReviewCacheKey\(attemptId\)/);
  assert.match(cache, /reading:full-sets.*:review:\$\{attemptId\}/s);
  assert.doesNotMatch(practice.slice(
    practice.indexOf("function ReadingFullSetReviewShell"),
    practice.indexOf("export function ReadingPracticeShell")
  ), /fetch\(/);
});

test("cache miss or browser refresh retains the review API cold fallback", () => {
  const submitted = practice.slice(
    practice.indexOf("export function ReadingFullSetSubmittedReview"),
    practice.indexOf("function ReadingFullSetReviewShell")
  );
  assert.match(submitted, /useStudentCachedData<ReadingFullSetReviewPayload>/);
  assert.match(submitted, /loadReadingFullSetReview\(fullSetId, attemptId, session\)/);
  assert.match(submitted, /\/api\/reading\/full-sets/);
});

test("stale in-flight cache loads cannot replace a seeded submit snapshot", () => {
  assert.match(cache, /setData[\s\S]*generations\.current\.set/);
  assert.match(cache, /current\.generation === generation[\s\S]*generations\.current\.get\(keyWithStudent\).*=== generation/);
});

test("CTW, RDL, and RAP reuse hot answers plus parsed material/passage objects", () => {
  const serverOccurrences = [
    reviewOccurrence("ctw", "ctw"),
    reviewOccurrence("rdl", "rdl"),
    reviewOccurrence("rap", "rap")
  ];
  const hot = new Map(serverOccurrences.map((occurrence) => {
    const practice = practicePayload(occurrence.practice.item.itemId, occurrence.practice.item.module);
    return [occurrence.occurrenceId, {
      answerRevision: 9,
      answers: { hot: occurrence.occurrenceId },
      occurrence: { occurrenceId: occurrence.occurrenceId },
      practice,
      questionTimes: {}
    }];
  }));
  const source = {
    attempt: { attemptId: "attempt-1", fullSetId: "set-1", title: "Set" },
    disclosures: {},
    reviewItems: [],
    occurrences: serverOccurrences
  };
  const resultPayload = {
    attempt: { attemptId: "attempt-1", fullSetId: "set-1" },
    answers: serverOccurrences.map((occurrence) => ({
      moduleNumber: occurrence.moduleNumber,
      occurrenceId: occurrence.occurrenceId
    }))
  };
  const merged = mergeReadingFullSetReviewWithHotOccurrences(resultPayload, source, hot);
  for (const occurrence of merged.occurrences) {
    assert.strictEqual(occurrence.practice, hot.get(occurrence.occurrenceId).practice);
    assert.strictEqual(occurrence.answers, hot.get(occurrence.occurrenceId).answers);
  }
});

test("submit requests only occurrence content missing from the current session", () => {
  const reviewServer = read("lib/reading/fullSetReviewServer.ts");
  assert.match(runner, /cachedOccurrenceIds: Array\.from\(hotOccurrenceIdsRef\.current\)/);
  assert.match(reviewServer, /occurrenceMetadata\.filter[\s\S]*!reusedOccurrenceIds\.has/);
  assert.match(reviewServer, /occurrenceMetadataToLoad\.map[\s\S]*loadStudentReadingPractice/);
});

test("RDL decoded images survive Runner to readonly unmounts in one bounded cache", () => {
  const occurrenceCache = read("lib/reading/fullSetOccurrenceCache.client.ts");
  assert.match(occurrenceCache, /readingFullSetSessionImagePreloadCache/);
  assert.match(occurrenceCache, /constructor\(maxEntries = 24\)/);
  assert.match(runner, /useRef\(readingFullSetSessionImagePreloadCache\)/);
  assert.match(practice, /readingFullSetSessionImagePreloadCache\.acquire\(imageUrl\)/);
});

test("snapshot validation rejects another attempt or Full Set", () => {
  const resultPayload = { attempt: { attemptId: "a", fullSetId: "s" }, answers: [] };
  const reviewPayload = { attempt: { attemptId: "a", fullSetId: "s" }, occurrences: [], reviewItems: [] };
  assert.equal(isReadingFullSetReadonlySnapshot({ attemptId: "a", fullSetId: "s", result: resultPayload, review: reviewPayload }), true);
  assert.equal(isReadingFullSetReadonlySnapshot({ attemptId: "old", fullSetId: "s", result: resultPayload, review: reviewPayload }), false);
});

test("hot path changes are isolated from BAS and Writing result caches", () => {
  assert.doesNotMatch(runner, /studentAttemptCacheKey|studentWritingAttemptCacheKey/);
  assert.match(cache, /STUDENT_ATTEMPT_CACHE_PREFIX/);
  assert.match(cache, /STUDENT_WRITING_CACHE_PREFIX/);
});
