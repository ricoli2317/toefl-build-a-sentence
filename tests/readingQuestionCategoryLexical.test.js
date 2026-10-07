const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLookupRequest } = require("../lib/lexical/lookup.ts");
const { authorizeLexicalSource, LexicalAccessError } = require("../lib/lexical/lookup.server.ts");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const sessionId = "00000000-0000-4000-8000-000000000001";
const request = (extra = {}) => ({ access: { kind: "reading_category", attemptId: sessionId },
  sourceType: "rap", sourceItemId: "passage-item", contentBlockId: "question:q1:stem",
  blockText: "green energy", startOffset: 0, endOffset: 5, selectedText: "green", ...extra });
const tables = (extra = {}) => ({
  reading_question_category_sessions: [{ session_id: sessionId, student_id: "student", status: "completed", completed_at: "now",
    manifest: { groups: [{ logicalItemId: "passage-item", targets: [{ questionId: "q1", slotId: null }] }] },
    progress: { "passage-item": { totalPoints: 1 } }, ...extra }],
  reading_logical_items: [{ logical_item_id: "passage-item", module: "rap" }],
  reading_questions: [{ logical_item_id: "passage-item", module: "rap", question_id: "q1", question_type: "rap_multiple_choice", stem: "green energy" },
    { logical_item_id: "passage-item", module: "rap", question_id: "outside", question_type: "rap_multiple_choice", stem: "green energy" }],
  reading_passages: [{ logical_item_id: "passage-item", passage_id: "passage" }],
  reading_passage_paragraphs: [{ passage_id: "passage", paragraph_id: "p1", paragraph_text: "green energy" }]
});
test("category lexical request carries a session proof, not a fabricated child attempt", () => {
  assert.ok(parseLookupRequest(request()));
  assert.equal(parseLookupRequest(request({ access: { kind: "reading_category", attemptId: "not-a-session" } })), null);
});
test("completed category review authorizes canonical RAP passage and frozen question", async () => {
  const db = createMockSupabase(tables());
  assert.equal((await authorizeLexicalSource(db, db, "student", request(), {})).text, "green energy");
  assert.equal((await authorizeLexicalSource(db, db, "student", request({ contentBlockId: "passage:passage:paragraph:p1" }), {})).text, "green energy");
});
test("category lookup rejects stranger, active session, other source, untargeted question and missing progress before corpus reads", async () => {
  for (const [userId, r, extra] of [
    ["other", request(), {}], ["student", request(), { status: "active", completed_at: null }],
    ["student", request({ sourceItemId: "other" }), {}], ["student", request({ sourceType: "rdl" }), {}],
    ["student", request({ contentBlockId: "question:outside:stem" }), {}], ["student", request(), { progress: {} }]
  ]) {
    const db = createMockSupabase(tables(extra));
    const touched = [];
    const original = db.from;
    db.from = (table) => { touched.push(table); return original(table); };
    await assert.rejects(authorizeLexicalSource(db, db, userId, r, {}), LexicalAccessError);
    assert.ok(!touched.some(table => table.startsWith("lexical_")));
    assert.ok(!touched.includes("reading_attempts") && !touched.includes("reading_wrongbook_attempts"));
  }
});
