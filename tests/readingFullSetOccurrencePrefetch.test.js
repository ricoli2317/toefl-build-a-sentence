const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ReadingFullSetImagePreloadCache,
  ReadingFullSetOccurrenceCache,
  readingFullSetOccurrenceCacheKey
} = require("../lib/reading/fullSetOccurrenceCache.client.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const runner = read("components/reading/ReadingFullSetRunner.tsx");
const occurrenceRoute = read("app/api/reading/full-set-attempts/[attemptId]/occurrences/[occurrenceId]/route.ts");
const performanceClient = read("lib/reading/fullSetPerformance.client.ts");

test("occurrence cache shares in-flight loads and turns them into ready hits", async () => {
  const cache = new ReadingFullSetOccurrenceCache();
  let resolveLoad;
  let loads = 0;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { resolveLoad = resolve; });
  };
  const first = cache.acquire("attempt:1:next", loader);
  const concurrent = cache.acquire("attempt:1:next", loader);
  assert.equal(first.source, "miss");
  assert.equal(concurrent.source, "wait");
  assert.strictEqual(first.promise, concurrent.promise);
  assert.equal(loads, 0);
  await Promise.resolve();
  assert.equal(loads, 1);
  resolveLoad({ occurrenceId: "next" });
  assert.deepEqual(await first.promise, { occurrenceId: "next" });
  const hit = cache.acquire("attempt:1:next", loader);
  assert.equal(hit.source, "hit");
  assert.deepEqual(await hit.promise, { occurrenceId: "next" });
  assert.equal(loads, 1);
});

test("failed prefetch can retry once navigation needs the occurrence", async () => {
  const cache = new ReadingFullSetOccurrenceCache();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    if (loads === 1) throw new Error("prefetch failed");
    return { occurrenceId: "next" };
  };
  await assert.rejects(cache.acquire("key", loader).promise, /prefetch failed/);
  const retry = cache.acquire("key", loader, { retryError: true });
  assert.equal(retry.source, "miss");
  assert.deepEqual(await retry.promise, { occurrenceId: "next" });
  assert.equal(loads, 2);
});

test("clearing the runner cache aborts active prefetches", async () => {
  const cache = new ReadingFullSetOccurrenceCache();
  const pending = cache.acquire("key", (signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })).promise;
  await Promise.resolve();
  cache.clear();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(cache.status("key"), "idle");
});

test("RDL image preload decodes once and deduplicates a canonical URL", async () => {
  const OriginalImage = global.Image;
  let instances = 0;
  let decodes = 0;
  global.Image = class MockImage {
    constructor() {
      instances += 1;
      this.onload = null;
      this.onerror = null;
    }
    set src(value) {
      if (value) queueMicrotask(() => this.onload?.());
    }
    async decode() { decodes += 1; }
  };
  try {
    const cache = new ReadingFullSetImagePreloadCache();
    const first = cache.acquire("https://assets.test/RDL-001/material.png");
    const duplicate = cache.acquire("https://assets.test/RDL-001/material.png");
    assert.equal(first.source, "miss");
    assert.equal(duplicate.source, "hit");
    assert.strictEqual(first.promise, duplicate.promise);
    await first.promise;
    assert.equal(instances, 1);
    assert.equal(decodes, 1);
  } finally {
    global.Image = OriginalImage;
  }
});

test("cache keys are attempt, module, and occurrence scoped", () => {
  assert.equal(readingFullSetOccurrenceCacheKey({
    attemptId: "attempt-a",
    moduleNumber: 2,
    occurrenceId: "occurrence-b"
  }), "attempt-a:2:occurrence-b");
});

test("runner performs rolling one-ahead prefetch only after first interactive", () => {
  const prefetchEffect = runner.slice(
    runner.indexOf("interactiveOccurrenceId !== currentOccurrence.occurrenceId"),
    runner.indexOf("const commitActiveQuestionTime")
  );
  assert.match(prefetchEffect, /position\.occurrenceIndex \+ 1/);
  assert.doesNotMatch(prefetchEffect, /\.map\(|Promise\.all|beginLoadPause/);
  assert.match(prefetchEffect, /next_prefetch_start/);
  assert.match(prefetchEffect, /acquireOccurrence\([\s\S]*prefetch: true/);
  assert.match(prefetchEffect, /\.promise\.catch\([\s\S]*PREFETCH_FAILED/);
});

test("navigation enqueues a save without awaiting the network, then uses hit, wait, or miss cache semantics", () => {
  const move = runner.slice(runner.indexOf("const move = useCallback"), runner.indexOf("const leavePractice"));
  assert.match(move, /commitActiveQuestionTime\(\)[\s\S]*stageCurrentOccurrenceSave\(trace\)[\s\S]*navigation_after_enqueue[\s\S]*setPosition\(nextPosition\)/);
  assert.doesNotMatch(move, /await\s+flushPendingSave|await\s+fetch/);
  assert.match(move, /navigation_cache_hit/);

  const load = runner.slice(
    runner.indexOf("if \(!accessToken \|\| !currentOccurrence \|\| currentPayload\) return"),
    runner.indexOf("const handleWorkspaceReady")
  );
  assert.match(load, /navigation_cache_\$\{navigationSource\}/);
  assert.match(load, /navigationSource !== "hit" && !pause[\s\S]*beginLoadPause/);
  assert.ok(load.indexOf("beginLoadPause") < load.indexOf("let acquisition = acquireOccurrence"));
  assert.match(load, /acquisition\.source !== "wait"[\s\S]*retryError: true/);
});

test("prefetched mutable answers never replace an existing local answer state", () => {
  assert.match(runner, /Object\.prototype\.hasOwnProperty\.call\(current, occurrenceId\)\) return current/);
  assert.match(runner, /revisionRef\.current = Math\.max\(revisionRef\.current, completePayload\.answerRevision\)/);
});

test("submit, timeout, and pagehide preserve answer durability boundaries", () => {
  const submit = runner.slice(runner.indexOf("const submitModule = useCallback"), runner.indexOf("useEffect(() => {", runner.indexOf("const submitModule = useCallback")));
  assert.match(submit, /submittingRef\.current = true[\s\S]*commitActiveQuestionTime\(\)[\s\S]*stageCurrentOccurrenceSave[\s\S]*await flushPendingSave[\s\S]*if \(!saved\) throw[\s\S]*await fetch/);
  assert.doesNotMatch(submit, /if \(automatic\) \{[\s\S]*pendingSaveRef\.current = null/);
  assert.match(runner, /remaining === 0[\s\S]*void submitModule\(true\)/);

  const pagehide = runner.slice(runner.indexOf("const saveBeforeLeaving"), runner.indexOf("const move = useCallback"));
  assert.match(pagehide, /commitActiveQuestionTime\(\)[\s\S]*stageCurrentOccurrenceSave\(\)/);
  assert.match(runner, /keepalive:\s*true/);
});

test("question time is committed before navigation snapshots and snapshots are immutable request payloads", () => {
  const move = runner.slice(runner.indexOf("const move = useCallback"), runner.indexOf("const leavePractice"));
  assert.ok(move.indexOf("commitActiveQuestionTime()") < move.indexOf("stageCurrentOccurrenceSave(trace)"));
  assert.match(runner, /buildReadingSubmissionAnswers\([\s\S]*snapshotQuestionTimes\(pending\.occurrenceId\)[\s\S]*saveQueueRef\.current!\.enqueue/);
  assert.match(runner, /answers: snapshot\.value\.answers/);
});

test("stale CAS responses refresh server truth but remain a blocking conflict without changing local answers", () => {
  const persist = runner.slice(runner.indexOf("const persistSave"), runner.indexOf("saveTransportRef.current = persistSave"));
  assert.match(persist, /if \(result\.attempt\) applyAttempt\(result\.attempt\)/);
  assert.match(persist, /result\.reason === "stale_revision"[\s\S]*答案状态已在其他页面更新，请刷新后继续/);
  assert.doesNotMatch(persist, /retryable: result\.reason === "stale_revision"/);
  assert.doesNotMatch(persist, /setAnswersByOccurrence/);
});

test("module transitions, submit, retry, and unmount clear runner-local prefetch state", () => {
  assert.match(runner, /previousModuleKey !== nextModuleKey\) \{[\s\S]*clearOccurrenceCaches\(\)/);
  assert.match(runner, /submittingRef\.current = true;[\s\S]*clearOccurrenceCaches\(\)/);
  assert.match(runner, /retryOccurrence[\s\S]*clearOccurrenceCaches\(\)/);
  assert.match(runner, /useEffect\(\(\) => \(\) => \{[\s\S]*occurrenceCacheRef\.current\.clear\(\)/);
});

test("occurrence endpoint uses one date-scoped definition resolution, not a catalog rebuild", () => {
  assert.match(occurrenceRoute, /loadReadingFullSet\(/);
  assert.doesNotMatch(occurrenceRoute, /loadReadingFullSets|findValidReadingFullSet/);
  assert.match(occurrenceRoute, /definition_resolution/);
  assert.match(occurrenceRoute, /occurrence_content/);
});

test("transition trace includes navigation, cache, save, workspace, and image phases without content", () => {
  for (const phase of [
    "next_prefetch_start",
    "next_prefetch_content_end",
    "rdl_image_preload_start",
    "rdl_image_preload_end",
    "next_prefetch_ready",
    "navigation_click",
    "answer_snapshot_created",
    "background_save_enqueued",
    "background_save_started",
    "background_save_success",
    "background_save_retry",
    "background_save_error",
    "navigation_after_enqueue",
    "durability_flush_start",
    "durability_flush_end",
    "navigation_cache_hit",
    "navigation_cache_wait",
    "navigation_cache_miss",
    "next_workspace_mounted",
    "next_first_interactive"
  ]) assert.match(performanceClient, new RegExp(`"${phase}"`));
  assert.doesNotMatch(performanceClient, /studentAnswer|student_answer|questionText|selectionMap/);
});
