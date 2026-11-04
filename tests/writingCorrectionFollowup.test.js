const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
const { createLedger, originalProjection } = require("../lib/writingRevisionLedger.ts");
const { correctionIssueLocation } = require("../lib/writingCorrectionLocation.ts");
const { correctionReviewState, buildCorrectionPublishedSnapshot } = require("../lib/writingCorrectionReview.ts");

test("issue location uses provenance for deleted paragraphs without selecting unrelated surviving words", () => {
  const original = "Keep this.\nDelete this paragraph.\nKeep that.";
  const ledger = createLedger(original, "Keep this.\nKeep that.");
  const before = JSON.stringify(ledger);
  const location = correctionIssueLocation(ledger, { original_text: "Delete this paragraph.", original_sentence: null });
  assert.ok(location.deletions.length);
  for (const range of location.ranges) assert.ok(!ledger.text.slice(range.from, range.to).includes("Keep"));
  assert.equal(JSON.stringify(ledger), before);
  assert.equal(originalProjection(ledger), original);
});

test("location respects original offsets for duplicate quotations and refuses ambiguous fallback", () => {
  const ledger = createLedger("same. same.", "same. same.");
  assert.equal(correctionIssueLocation(ledger, { original_text: "same.", original_sentence: null }), null);
  assert.deepEqual(correctionIssueLocation(ledger, { original_text: "same.", original_sentence: null, source_start: 6, source_end: 11 }).ranges, [{ from: 6, to: 11 }]);
});

test("AI defaults stay separate; teacher can edit or clear rationale/delta; only adopted issues are published", () => {
  const ai = { correction_score: 3, score_rationale: "AI explanation", score_change_explanation: "AI delta", issue_resolutions: [], new_issues: [
    { type: "grammar", severity: "minor", evidence: "one", explanation: "first", score_impact: "small" },
    { type: "grammar", severity: "minor", evidence: "two", explanation: "second", score_impact: "small" }
  ] };
  const before = structuredClone(ai);
  const state = correctionReviewState({ issues: [], originalScore: 3, ai, teacher: {
    issue_statuses: {}, correction_score: 4, score_rationale: "", score_change_explanation: "teacher delta",
    new_issue_reviews: { "1": { status: "dismissed", note: "" } }
  } });
  assert.equal(state.new_issues[0].review_status, "accepted");
  const snapshot = buildCorrectionPublishedSnapshot({ state, aiModel: "test", aiGeneratedAt: null, publishedAt: "2026-11-04" });
  assert.equal(snapshot.score_rationale, "");
  assert.equal(snapshot.score_change_explanation, "teacher delta");
  assert.equal(snapshot.new_issues.length, 1);
  assert.equal(state.new_issues.length, 2);
  assert.deepEqual(ai, before);
});

test("minimal followup SQL executes locally: status rules, independent logs, ignore lifecycle, server-only access", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.writing_attempts(attempt_id uuid PRIMARY KEY, task_type text, attempt_kind text, status text);
      CREATE FUNCTION public.test_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER writing_attempts_correction_closed_gate BEFORE INSERT ON public.writing_attempts FOR EACH ROW EXECUTE FUNCTION public.test_gate();
    `);
    const historical = fs.readFileSync("supabase/writing_correction_phase4/10_writing_correction_phase4.sql", "utf8");
    await db.exec(historical);
    const ordinaryLogs = fs.readFileSync("supabase/writing_review_ai_logs.sql", "utf8");
    const tableSql = ordinaryLogs.slice(ordinaryLogs.indexOf("create table"), ordinaryLogs.indexOf("create index"));
    await db.exec(tableSql);
    await db.exec(fs.readFileSync("supabase/writing_correction_followup/10_writing_correction_followup.sql", "utf8"));
    const id = "11111111-1111-4111-8111-111111111111";
    const original = "22222222-2222-4222-8222-222222222222";
    await db.query("INSERT INTO writing_attempts VALUES ($1,'email','correction','submitted'),($2,'email','original','submitted')", [id, original]);
    assert.equal((await db.query("SELECT * FROM ignore_teacher_writing_corrections(ARRAY[$1::uuid,$2::uuid])", [id, original])).rows.find(row => row.attempt_id === id).outcome, "ignored");
    assert.equal((await db.query("SELECT * FROM ignore_teacher_writing_corrections(ARRAY[$1::uuid])", [id])).rows[0].reason, "already_reviewed");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM writing_correction_reviews")).rows[0].n, 1);
    await db.query("UPDATE writing_correction_reviews SET status='published', published_review='{}', published_at=now() WHERE attempt_id=$1", [id]);
    await db.query("UPDATE writing_correction_reviews SET teacher_overrides='{\"correction_score\":4}' WHERE attempt_id=$1", [id]);
    await assert.rejects(db.query("UPDATE writing_correction_reviews SET status='ignored' WHERE attempt_id=$1", [id]), /writing_correction_reviews_publish_state/);
    await db.exec("SET ROLE authenticated");
    await assert.rejects(db.query("SELECT * FROM writing_correction_ai_logs"), /permission denied/);
    await assert.rejects(db.query("SELECT * FROM ignore_teacher_writing_corrections('{}'::uuid[])"), /permission denied/);
    await db.exec("RESET ROLE");
    const gate = (await db.query("SELECT tgenabled FROM pg_trigger WHERE tgname='writing_attempts_correction_closed_gate'")).rows[0];
    assert.equal(gate.tgenabled, "O");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM writing_review_ai_logs")).rows[0].n, 0);
  } finally { await db.close(); }
});
