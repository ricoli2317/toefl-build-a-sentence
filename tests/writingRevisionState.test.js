const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Schema, Slice, Fragment } = require('@tiptap/pm/model');
const { EditorState, TextSelection } = require('@tiptap/pm/state');
const { history, closeHistory, undo, redo } = require('@tiptap/pm/history');
const { textDocument, textPosition } = require('../lib/writingRevisionDocument.ts');
const { transactionRevisionExtension, transactionRevisionKey, restoreDeletion } = require('../lib/writingRevisionPlugin.ts');
const { initializeWritingRevision, parseWritingRevisionState, revisionStateKey } = require('../lib/writingRevisionState.ts');
const { transactionDiagnostics } = require('../lib/writingRevisionLedger.ts');
const { createCorrectionFixtureTransport, FIXTURE_ORIGINAL_ID } = require('./fixtures/writingCorrectionFixture.ts');

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } } });
function editor(seed) {
  const ext = transactionRevisionExtension(seed.ledger.original, [], seed.ledger);
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(textDocument(seed.ledger.text)), plugins: [history(), ...ext.config.addProseMirrorPlugins.call({})] });
  const snapshot = () => ({ schema_version: 1, ledger: transactionRevisionKey.getState(state).ledger });
  const dispatch = tr => { state = state.applyTransaction(tr).state; parseWritingRevisionState(snapshot(), seed.ledger.original, snapshot().ledger.text); };
  const view = { get state() { return state; }, editable: true, dispatch, focus() {} };
  return { snapshot, view,
    edit(from, to, text) { dispatch(closeHistory(state.tr)); dispatch(state.tr.setSelection(TextSelection.create(state.doc, textPosition(snapshot().ledger.text, from), textPosition(snapshot().ledger.text, to))).replaceSelection(new Slice(Fragment.from(schema.nodeFromJSON(textDocument(text)).content), 1, 1))); },
    restore(id) { return restoreDeletion(view, id); }, undo() { return undo(state, dispatch); }, redo() { return redo(state, dispatch); }
  };
}

test('durable round trip preserves original identity, PM anchors, insertion IDs and independent restore after reload', () => {
  const before = editor(initializeWritingRevision('A first second third\n😀 end', 'A first second third\n😀 end'));
  before.edit(2, 7, ''); before.edit(3, 9, ''); before.edit(0, 0, 'NEW\n');
  const saved = before.snapshot(); const calls = transactionDiagnostics.exactDiffCalls;
  const after = editor(parseWritingRevisionState(JSON.parse(JSON.stringify(saved)), saved.ledger.original, saved.ledger.text));
  assert.deepEqual(after.snapshot(), saved); assert.equal(transactionDiagnostics.exactDiffCalls, calls);
  const [first, second] = saved.ledger.deletions;
  assert.equal(after.restore(first.id), true); assert.equal(after.restore(first.id), false);
  assert.deepEqual(after.snapshot().ledger.deletions.map(d => d.id), [second.id]);
  assert.ok(after.snapshot().ledger.text.startsWith('NEW\nA first '));
  const restored = after.snapshot(); after.undo(); assert.deepEqual(after.snapshot(), saved); after.redo(); assert.deepEqual(after.snapshot(), restored);
  after.edit(after.snapshot().ledger.text.length, after.snapshot().ledger.text.length, '!');
  assert.equal(after.restore(second.id), true); assert.equal(after.snapshot().ledger.text, 'NEW\nA first second third\n😀 end!');
});

test('new IDs never collide with persisted IDs, including undo branches and another editor session', () => {
  const h = editor(initializeWritingRevision('abc', 'abc')); h.edit(1,2,'');
  const id = h.snapshot().ledger.deletions[0].id;
  const loaded = editor(JSON.parse(JSON.stringify(h.snapshot()))); loaded.restore(id); loaded.edit(1,2,'');
  assert.notEqual(loaded.snapshot().ledger.deletions[0].id, id);
});

test('corrupt versions, foreign baselines, stale text, duplicate sources/IDs and invalid PM anchors fail closed', () => {
  const h = editor(initializeWritingRevision('aabbcc', 'aabbcc')); h.edit(1,2,''); h.edit(3,4,'');
  const valid = h.snapshot();
  const cases = [s => { s.schema_version = 2; }, s => { s.ledger.original = 'foreign'; }, s => { s.ledger.text += 'x'; },
    s => { s.ledger.sources[0] = s.ledger.sources[1]; }, s => { s.ledger.deletions[0].position = -1; },
    s => { s.ledger.deletions[1].id = s.ledger.deletions[0].id; }, s => { s.ledger.deletions[0].text = 'wrong'; }];
  for (const mutate of cases) { const bad = structuredClone(valid); mutate(bad); assert.throws(() => parseWritingRevisionState(bad, valid.ledger.original, valid.ledger.text)); }
  assert.throws(() => parseWritingRevisionState({ schema_version: 1, ledger: { original: 'aa', text: 'aa', sources: [1,0], deletions: [] } }, 'aa', 'aa'));
});

test('legacy initialization preserves responseText exactly, uses Diff once and makes no historical-operation claim', () => {
  const start = transactionDiagnostics.exactDiffCalls;
  const seed = initializeWritingRevision('one\n\nold\n', 'one\n\nnew\n');
  assert.equal(seed.ledger.text, 'one\n\nnew\n'); assert.equal(transactionDiagnostics.exactDiffCalls, start + 1);
  const h = editor(seed); for (let i=0;i<100;i++) h.edit(h.snapshot().ledger.text.length,h.snapshot().ledger.text.length,'x');
  assert.equal(transactionDiagnostics.exactDiffCalls, start + 1);
});

test('save confirmation compares semantic state, independent of JSON property order', () => {
  const h = editor(initializeWritingRevision('abc', 'abc')); h.edit(1,2,'X');
  const state = h.snapshot(); const parsed = parseWritingRevisionState(JSON.parse(JSON.stringify(state)), 'abc', 'aXc');
  assert.equal(revisionStateKey(state), revisionStateKey(parsed));
});

for (const task of ['email','academic_discussion']) for (const assignment of [false,true]) {
  test(`formal transport ledger contract / ${task} / ${assignment ? 'assignment' : 'bank'} (synthetic only)`, async () => {
    const store = new Map(); const storage = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v) };
    const fixture = createCorrectionFixtureTransport(storage,task,assignment);
    const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
    const h = editor(initializeWritingRevision(attempt.response_text,attempt.response_text));
    h.edit(0,4,''); h.edit(5,8,''); h.edit(0,0,'NEW ');
    const state = h.snapshot(); const id = state.ledger.deletions[0].id;
    await fixture.client.save(attempt.attempt_id,state.ledger.text,0,state);
    const reopened = createCorrectionFixtureTransport(storage,task,assignment);
    const loaded = await reopened.client.load(attempt.attempt_id);
    assert.equal(revisionStateKey(loaded.revision_state),revisionStateKey(state));
    const resumed = await reopened.client.create(FIXTURE_ORIGINAL_ID); assert.deepEqual(resumed.revision_state,state);
    const restored = editor(loaded.revision_state); assert.ok(restored.restore(id));
    const final = restored.snapshot(); const saved = await reopened.client.save(attempt.attempt_id,final.ledger.text,1,final);
    await reopened.client.submit(attempt.attempt_id,saved.draft_version);
    const teacher = await reopened.teacherSend(`/correction-review/${attempt.attempt_id}/correction-review`).then(r=>r.json());
    assert.deepEqual(teacher.workspace.revision_state,final);
    assert.equal(teacher.workspace.corrected_response_text,final.ledger.text);
  });
}

test('revision SQL static security and atomicity contract (NOT database execution)', () => {
  const sql = fs.readFileSync('supabase/writing_correction_revisions/10_writing_correction_revisions.sql','utf8');
  assert.match(sql,/PRIMARY KEY REFERENCES public\.writing_attempts/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/); assert.doesNotMatch(sql,/CREATE POLICY|DISABLE TRIGGER|DROP TRIGGER/);
  assert.match(sql,/GRANT SELECT ON public\.writing_correction_revision_states TO service_role/);
  assert.match(sql,/result := public\.save_writing_correction\(p_student,p_attempt,p_expected_version,p_response_text\)/);
  assert.match(sql,/DEFERRABLE INITIALLY DEFERRED/); assert.match(sql,/REVOKE EXECUTE ON FUNCTION public\.save_writing_correction\(uuid,uuid,bigint,text\) FROM service_role/);
  assert.doesNotMatch(sql,/ALTER TABLE public\.writing_attempts|SET draft_version|WRITING_CORRECTION_ENTRY_ENABLED/);
});
