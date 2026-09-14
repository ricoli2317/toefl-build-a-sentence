const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ReadingFullSetSaveError,
  ReadingFullSetSaveQueue
} = require("../lib/reading/fullSetSaveQueue.client.ts");
const {
  sameReadingFullSetAnswers
} = require("../lib/reading/fullSetSaveIdempotency.server.ts");

function input(occurrenceId, value, moduleAttemptId = "module-1") {
  return {
    key: `attempt-1:${moduleAttemptId}:${occurrenceId}`,
    moduleAttemptId,
    moduleNumber: moduleAttemptId === "module-1" ? 1 : 2,
    occurrenceId,
    value
  };
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((onResolve, onReject) => {
    reject = onReject;
    resolve = onResolve;
  });
  return { promise, reject, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("same-occurrence saves serialize and coalesce to the latest snapshot", async () => {
  const requests = [];
  const queue = new ReadingFullSetSaveQueue({
    transport: (snapshot) => {
      const request = deferred();
      requests.push({ request, snapshot });
      return request.promise;
    }
  });

  queue.enqueue(input("ctw", "revision-1"));
  queue.enqueue(input("ctw", "revision-2"));
  queue.enqueue(input("ctw", "revision-3"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].snapshot.value, "revision-1");
  assert.equal(queue.getState("attempt-1:module-1:ctw").status, "saving");

  requests[0].request.resolve();
  await nextTurn();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].snapshot.value, "revision-3");
  assert.equal(requests[1].snapshot.localRevision, 3);
  requests[1].request.resolve();

  assert.equal(await queue.flush("module-1"), true);
  assert.deepEqual(queue.getState("attempt-1:module-1:ctw"), {
    dirty: false,
    latestDurableRevision: 3,
    latestLocalRevision: 3,
    status: "saved"
  });
});

test("the Module-wide CAS sender never overlaps different occurrences", async () => {
  const requests = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const queue = new ReadingFullSetSaveQueue({
    transport: (snapshot) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const request = deferred();
      requests.push({
        request: {
          resolve: () => {
            concurrent -= 1;
            request.resolve();
          }
        },
        snapshot
      });
      return request.promise;
    }
  });

  queue.enqueue(input("ctw", "ctw-answer"));
  queue.enqueue(input("rdl", "rdl-answer"));
  assert.equal(requests.length, 1);
  requests[0].request.resolve();
  await nextTurn();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].snapshot.occurrenceId, "rdl");
  requests[1].request.resolve();
  assert.equal(await queue.flush("module-1"), true);
  assert.equal(maxConcurrent, 1);
});

test("transient failures retry without losing dirty state", async () => {
  let attempts = 0;
  const events = [];
  const queue = new ReadingFullSetSaveQueue({
    maxRetries: 2,
    onEvent: (event) => events.push(event.type),
    retryDelayMs: () => 0,
    transport: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new ReadingFullSetSaveError("temporary", { retryable: true });
      }
    }
  });
  queue.enqueue(input("ctw", "latest"));
  assert.equal(await queue.flush("module-1"), true);
  assert.equal(attempts, 3);
  assert.equal(events.filter((event) => event === "retry").length, 2);
  assert.equal(queue.hasPending("module-1"), false);
});

test("terminal failure stays dirty and blocks automatic durability retries", async () => {
  let fail = true;
  let attempts = 0;
  const queue = new ReadingFullSetSaveQueue({
    transport: async () => {
      attempts += 1;
      if (fail) throw new ReadingFullSetSaveError("validation failed");
    }
  });
  queue.enqueue(input("rap", "latest"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queue.hasPending("module-1"), true);
  assert.equal(await queue.flush("module-1"), false);
  assert.equal(queue.getState("attempt-1:module-1:rap").status, "error");

  fail = false;
  queue.enqueue(input("rap", "still-blocked"));
  assert.equal(await queue.flush("module-1"), false);
  assert.equal(queue.hasPending("module-1"), true);
  assert.equal(attempts, 1);
});

test("an exhausted transient error can be retried by a later durability flush", async () => {
  let fail = true;
  let attempts = 0;
  const queue = new ReadingFullSetSaveQueue({
    maxRetries: 0,
    retryDelayMs: () => 0,
    transport: async () => {
      attempts += 1;
      if (fail) throw new ReadingFullSetSaveError("network", { retryable: true });
    }
  });
  queue.enqueue(input("rap", "latest"));
  await nextTurn();
  assert.equal(queue.getState("attempt-1:module-1:rap").status, "error");
  fail = false;
  assert.equal(await queue.flush("module-1"), true);
  assert.equal(attempts, 2);
});

test("an older completion only marks its own revision durable", async () => {
  const requests = [];
  const queue = new ReadingFullSetSaveQueue({
    transport: (snapshot) => {
      const request = deferred();
      requests.push({ request, snapshot });
      return request.promise;
    }
  });
  queue.enqueue(input("ctw", { answer: "old" }));
  queue.enqueue(input("ctw", { answer: "new" }));
  requests[0].request.resolve();
  await nextTurn();
  assert.deepEqual(queue.getState("attempt-1:module-1:ctw"), {
    dirty: true,
    latestDurableRevision: 1,
    latestLocalRevision: 2,
    status: "saving"
  });
  assert.deepEqual(requests[1].snapshot.value, { answer: "new" });
  requests[1].request.resolve();
  assert.equal(await queue.flush("module-1"), true);
});

test("a durability flush waits for an already in-flight request", async () => {
  const request = deferred();
  const queue = new ReadingFullSetSaveQueue({
    transport: () => request.promise
  });
  queue.enqueue(input("rdl", "answer"));
  let finished = false;
  const flush = queue.flush("module-1").then((saved) => {
    finished = true;
    return saved;
  });
  await nextTurn();
  assert.equal(finished, false);
  request.resolve();
  assert.equal(await flush, true);
});

test("a lost successful response can be reconciled as an idempotent stale retry", () => {
  const incoming = [
    { kind: "option", questionId: "q2", questionTimeSeconds: 8, studentAnswer: "b" },
    { kind: "ctw_slot", questionId: "q1", questionTimeSeconds: 4, slotId: "s1", studentAnswer: "at" }
  ];
  const saved = [
    { answer_kind: "ctw_slot", question_id: "q1", question_time_seconds: 4, slot_id: "s1", student_answer: "at" },
    { answer_kind: "option", question_id: "q2", question_time_seconds: 8, slot_id: null, student_answer: "b" }
  ];
  assert.equal(sameReadingFullSetAnswers(incoming, saved), true);
});

test("a genuinely stale snapshot cannot be reconciled as durable", () => {
  const incoming = [
    { kind: "option", questionId: "q1", questionTimeSeconds: 8, studentAnswer: "b" }
  ];
  const saved = [
    { answer_kind: "option", question_id: "q1", question_time_seconds: 9, slot_id: null, student_answer: "c" }
  ];
  assert.equal(sameReadingFullSetAnswers(incoming, saved), false);
  assert.equal(sameReadingFullSetAnswers([{ questionId: "q1" }], saved), false);
});
