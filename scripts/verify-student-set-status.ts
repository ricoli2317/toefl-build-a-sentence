import assert from "node:assert/strict";
import {
  buildLatestOfficialAttemptMap,
  mergeOfficialAttemptIntoSetsPayload
} from "../lib/studentSetStatus";

const initialPayload: {
  sets: Array<{
    set_id: string;
    completed: boolean;
    latest_attempt_id: string | null;
    latest_accuracy?: number | null;
    latest_submitted_at?: string | null;
  }>;
} = {
  sets: [
    {
      set_id: "202602-0202-2",
      completed: false,
      latest_attempt_id: null
    },
    {
      set_id: "202607-0708-2",
      completed: false,
      latest_attempt_id: null
    }
  ]
};

const attempts = [
  {
    attempt_id: "july-older",
    set_id: " 202607-0708-2 ",
    submitted_at: "2026-07-30T10:00:00.000Z",
    correct_count: 7,
    total_questions: 10
  },
  {
    attempt_id: "july-latest",
    set_id: "202607-0708-2",
    submitted_at: "2026-07-31T10:00:00.000Z",
    correct_count: 9,
    total_questions: 10
  },
  {
    attempt_id: "wrongbook-attempt",
    set_id: "wrongbook-today-20260731",
    submitted_at: "2026-07-31T11:00:00.000Z",
    correct_count: 10,
    total_questions: 10
  }
];

const latest = buildLatestOfficialAttemptMap(attempts);
assert.equal(latest.size, 1);
assert.equal(latest.get("202607-0708-2")?.attempt_id, "july-latest");

const submittedAttempt = {
  attempt_id: "just-submitted",
  set_id: "202602-0202-2",
  submitted_at: "2026-07-31T12:00:00.000Z",
  correct_count: 8,
  total_questions: 10,
  accuracy: 0.8
};
const merged = mergeOfficialAttemptIntoSetsPayload(
  initialPayload,
  submittedAttempt
);
assert.equal(merged.matched, true);
assert.equal(merged.payload.sets[0].completed, true);
assert.equal(
  merged.payload.sets[0].latest_attempt_id,
  submittedAttempt.attempt_id
);
assert.equal(merged.payload.sets[0].latest_accuracy, 0.8);

const newerServerResponse = {
  sets: [
    {
      set_id: "202602-0202-2",
      completed: true,
      latest_attempt_id: "newer-server-attempt",
      latest_submitted_at: "2026-07-31T13:00:00.000Z"
    }
  ]
};
const protectedNewerResult = mergeOfficialAttemptIntoSetsPayload(
  newerServerResponse,
  submittedAttempt
);
assert.equal(
  protectedNewerResult.payload.sets[0].latest_attempt_id,
  "newer-server-attempt"
);

const wrongbookMerge = mergeOfficialAttemptIntoSetsPayload(initialPayload, {
  attempt_id: "wrongbook-new",
  set_id: "wrongbook-random-20260731-120000",
  submitted_at: "2026-07-31T12:00:00.000Z",
  correct_count: 1,
  total_questions: 1
});
assert.equal(wrongbookMerge.matched, false);
assert.deepEqual(wrongbookMerge.payload, initialPayload);

console.log("Student set completion regression checks passed.");
