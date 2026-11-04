const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createWritingCorrectionClient, correctionAnnotations, WRITING_CORRECTION_ENTRY_ENABLED } = require("../lib/writingCorrectionUi.ts");
const { createCorrectionFixtureTransport, writingCorrectionFixture, FIXTURE_ORIGINAL_ID } = require("./fixtures/writingCorrectionFixture.ts");
const { writingCorrectionDiff } = require("../lib/writingCorrectionDiff.ts");
const { orderedPublishedReviewItems } = require("../lib/writingPublishedReview.ts");
const root = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const storage = () => { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };

for (const task of ["email", "academic_discussion"]) for (const assignment of [false, true]) {
  test(`fixture API contract: ${task} / ${assignment ? "assignment" : "bank"} creates, saves and restores frozen source`, async () => {
    const store = storage();
    const { client } = createCorrectionFixtureTransport(store, task, assignment);
    const initial = await client.create(FIXTURE_ORIGINAL_ID);
    const source = structuredClone(initial.correction_source_snapshot);
    assert.equal(initial.response_text, source.original_response_text);
    assert.ok(writingCorrectionDiff(source.original_response_text, initial.response_text).every((p) => !p.added));
    assert.equal(source.question_source, assignment ? "custom" : "question_bank");
    assert.equal(Boolean(initial.assignment_id), assignment);
    assert.equal(initial.writing_mode, null);
    const review = correctionAnnotations(initial);
    assert.deepEqual(Object.keys(review).sort(), ["content_feedback", "language_edits"]);
    assert.equal(orderedPublishedReviewItems(review).length, 2);
    assert.equal(review.language_edits[0].restored, false);
    assert.equal(review.content_feedback.items[0].included, true);
    const text = initial.response_text + "\nMy own correction. 中文 😀  ";
    const saved = await client.save(initial.attempt_id, text, initial.draft_version);
    assert.equal(saved.draft_version, 1);
    const afterReload = createCorrectionFixtureTransport(store, task, assignment).client;
    const loaded = await afterReload.load(saved.attempt_id);
    const resumed = await afterReload.create(FIXTURE_ORIGINAL_ID);
    for (const result of [loaded, resumed]) {
      assert.equal(result.attempt_id, initial.attempt_id);
      assert.equal(result.response_text, text);
      assert.equal(result.draft_version, 1);
      assert.deepEqual(result.correction_source_snapshot, source);
    }
  });
}

test("409 CAS conflicts never overwrite the saved body; reading latest is a separate explicit request", async () => {
  const { client } = createCorrectionFixtureTransport(storage(), "email", false);
  const draft = await client.create(FIXTURE_ORIGINAL_ID);
  await client.save(draft.attempt_id, "Other session's text", 0);
  await assert.rejects(client.save(draft.attempt_id, "Local unsaved text", 0), (e) => e.status === 409);
  const latest = await client.load(draft.attempt_id);
  assert.equal(latest.response_text, "Other session's text");
  assert.equal(latest.draft_version, 1);
});

test("503 gate and network failures do not change last successfully saved fixture", async () => {
  const fixture = createCorrectionFixtureTransport(storage(), "email", false);
  fixture.failNext("gate");
  await assert.rejects(fixture.client.create(FIXTURE_ORIGINAL_ID), (e) => e.status === 503 && e.code === "WRITING_CORRECTION_NOT_ENABLED");
  const draft = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  for (const failure of ["gate", "network"]) {
    fixture.failNext(failure);
    await assert.rejects(fixture.client.save(draft.attempt_id, "Unsaved", 0));
    const restored = await fixture.client.load(draft.attempt_id);
    assert.equal(restored.response_text, draft.response_text);
    assert.equal(restored.draft_version, 0);
  }
});

test("draft methods retain Phase 1 request fields without timer or diff", async () => {
  const calls = [];
  const attempt = writingCorrectionFixture("email", false);
  const client = createWritingCorrectionClient(async (path, init) => {
    calls.push([path, init]); return Response.json({ attempt });
  });
  await client.create(FIXTURE_ORIGINAL_ID);
  await client.load(attempt.attempt_id);
  await client.save(attempt.attempt_id, "Local text", 12);
  assert.deepEqual(JSON.parse(calls[0][1].body), { originalAttemptId: FIXTURE_ORIGINAL_ID });
  assert.deepEqual(JSON.parse(calls[2][1].body), { action: "save", responseText: "Local text", expectedDraftVersion: 12 });
  assert.equal(calls[1][1].method, "GET");
  assert.ok(calls.every(([, init]) => init.cache === "no-store"));
  assert.deepEqual(Object.keys(client).sort(), ["create", "history", "load", "save", "submit"]);
});

test("client rejects original, malformed submitted, invalid-version and mismatched responses", async () => {
  for (const change of [{ attempt_kind: "original" }, { status: "submitted" }, { draft_version: -1 }, { attempt_id: "other" }]) {
    const attempt = { ...writingCorrectionFixture("email", false), ...change };
    const client = createWritingCorrectionClient(async () => Response.json({ attempt }));
    await assert.rejects(client.load("44444444-4444-4444-8444-444444444444"));
  }
});

test("client reads submitted records, rejects editing them, and retries alreadySubmitted with targeted invalidation", async () => {
  const attempt = { ...writingCorrectionFixture("email", false), status: "submitted", submitted_at: "2026-11-03T00:00:00Z", draft_version: 2 };
  const calls = [], updated = [];
  const client = createWritingCorrectionClient(async (path, init) => {
    calls.push([path, init]); return Response.json({ attempt, alreadySubmitted: true, cacheInvalidation: null });
  }, (row) => updated.push(row));
  assert.equal((await client.load(attempt.attempt_id)).status, "submitted");
  await assert.rejects(client.create(FIXTURE_ORIGINAL_ID));
  await assert.rejects(client.save(attempt.attempt_id, "overwrite", 2));
  const retried = await client.submit(attempt.attempt_id, 1);
  assert.equal(retried.draft_version, 2);
  assert.deepEqual(JSON.parse(calls.at(-1)[1].body), { action: "submit", expectedDraftVersion: 1 });
  assert.equal(updated.length, 1);
});

for (const task of ["email", "academic_discussion"]) for (const assignment of [false, true]) {
  test(`Phase 3 Mock: two independent submissions, return same ID, draft conflict: ${task}/${assignment}`, async () => {
    const fixture = createCorrectionFixtureTransport(storage(), task, assignment);
    const first = await fixture.client.create(FIXTURE_ORIGINAL_ID);
    assert.equal((await fixture.client.create(FIXTURE_ORIGINAL_ID)).attempt_id, first.attempt_id);
    const saved = await fixture.client.save(first.attempt_id, "First correction body", 0);
    const submitted = await fixture.client.submit(first.attempt_id, saved.draft_version);
    const next = await fixture.client.create(FIXTURE_ORIGINAL_ID);
    assert.notEqual(next.attempt_id, first.attempt_id);
    assert.equal(next.response_text, first.correction_source_snapshot.original_response_text);
    assert.equal((await fixture.client.create(FIXTURE_ORIGINAL_ID)).attempt_id, next.attempt_id);
    const moderate = () => fixture.teacherSend("/api/teacher/writing/reviews/moderate", { method: "POST", body: JSON.stringify({ action: "return", attemptIds: [first.attempt_id] }) }).then((r) => r.json());
    assert.equal((await moderate()).results[0].reason, "draft_exists");
    await fixture.client.submit(next.attempt_id, next.draft_version);
    const history = await fixture.client.history(FIXTURE_ORIGINAL_ID);
    assert.equal(history.length, 2);
    assert.ok(history.every((row) => row.status === "submitted" && row.reviewStatus === "pending"));
    assert.equal((await fixture.client.load(first.attempt_id)).response_text, "First correction body");
    assert.equal((await moderate()).results[0].outcome, "returned");
    const resumed = await fixture.client.create(FIXTURE_ORIGINAL_ID);
    assert.equal(resumed.attempt_id, first.attempt_id);
    assert.equal(resumed.draft_version, submitted.draft_version + 1);
    assert.deepEqual(resumed.correction_source_snapshot, first.correction_source_snapshot);
    await assert.rejects(fixture.client.save(first.attempt_id, "stale", saved.draft_version), (e) => e.status === 409);
    assert.equal((await fixture.client.history(FIXTURE_ORIGINAL_ID)).filter((row) => row.status === "draft").length, 1);
  });
}

test("only confirmed mutation metadata publishes correction-specific invalidation", async () => {
  const attempt = writingCorrectionFixture("email", false);
  const updated = [];
  let cacheInvalidation = null;
  const client = createWritingCorrectionClient(async () => Response.json({ attempt, cacheInvalidation }), (value) => updated.push(value));
  await client.create(FIXTURE_ORIGINAL_ID);
  assert.equal(updated.length, 0);
  cacheInvalidation = { type: "WRITING_CORRECTION_UPDATED" };
  await client.save(attempt.attempt_id, attempt.response_text, 0);
  assert.equal(updated.length, 1);
  assert.doesNotMatch(read("lib/writingCorrectionClient.ts"), /WRITING_DRAFT_UPDATED|WRITING_ATTEMPT_SUBMITTED/);
});

test("production entry stays explicitly closed; no development fixture routes or components ship", () => {
  assert.equal(WRITING_CORRECTION_ENTRY_ENABLED, false);
  assert.match(read("components/student/StudentWritingReview.tsx"), /WRITING_CORRECTION_ENTRY_ENABLED \? <WritingCorrectionEntry/);
  for (const file of [
    "app/dev/writing-correction/page.tsx",
    "app/dev/writing-correction-review/page.tsx",
    "components/writing/WritingCorrectionFixture.tsx",
    "components/writing/WritingCorrectionReviewFixture.tsx"
  ]) assert.equal(fs.existsSync(path.join(__dirname, "..", file)), false, file);
  assert.doesNotMatch(read("tests/fixtures/writingCorrectionFixture.ts"), /\bfetch\(|supabase|service_role/);
});

test("two tab panels stay mounted; editing never renders teacher markers and frozen view never reads current reviews", () => {
  const source = read("components/writing/WritingCorrection.tsx");
  assert.match(source, /useState<"edit" \| "annotations">\("edit"\)/);
  assert.match(source, /hidden=\{tab !== "edit"\}/);
  assert.match(source, /hidden=\{tab !== "annotations"\}/);
  assert.doesNotMatch(source, /key=\{tab\}|tab === "edit" \? <|\/api\/writing\/reviews/);
  const editPanel = source.slice(source.indexOf('<section aria-labelledby="correction-tab-edit"'), source.indexOf('<section aria-labelledby="correction-tab-annotations"'));
  assert.match(editPanel, /<WritingRevisionEditor/);
  assert.doesNotMatch(editPanel, /PublishedReviewDetail|WritingRevisionMarkedText|scores|teacher_comment/);
  assert.match(source, /initializeWritingRevision\(source\.original_response_text, initialAttempt\.response_text, initialAttempt\.revision_state\)/);
  assert.match(source, /<FrozenCorrectionAnnotations attempt=\{initialAttempt\}/);
  assert.doesNotMatch(source, /Time Left|setInterval|requestUpdate|elapsedSeconds|remainingSeconds|sample_essay|PublishedScorePanel/);
  assert.match(editPanel, /<WritingPracticeActions/);
  assert.match(editPanel, /onSubmit=\{\(\) => setSubmitOpen\(true\)\}/, "the shared action opens correction confirmation, not ordinary timed submission");
});

test("conflict refresh requires confirmation, retains local text, and failed saves cannot claim saved", () => {
  const source = read("components/writing/WritingCorrection.tsx");
  assert.match(source, /reason\.status === 409/);
  assert.match(source, /重新读取最新草稿/);
  assert.match(source, /确认读取并替换/);
  assert.match(source, /setPreviousLocalText\(editor\.text\)/);
  assert.match(source, /setAttempt\(saved\); setSavedText\(text\)/);
  assert.match(source, /editor\.text !== savedText/);
  assert.match(source, /beforeunload/);
  assert.match(source, /addEventListener\("click", click, true\)/);
  assert.match(source, /addEventListener\("popstate", pop, true\)/);
  assert.doesNotMatch(source, /pagehide|keepalive|sendBeacon/);
});
