const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { fixture, client, read, U, V, T, A, X } = require('./helpers/ctwVocabularyFixture.cjs');
const store = require('../lib/ctw-vocabulary/store.server.ts');
const server = require('../lib/ctw-vocabulary/review.server.ts');
const { buildVocabularyImportSql } = require('../lib/ctw-vocabulary/import.ts');
const migration = 'supabase/ctw_vocabulary_overall_progress.sql';
async function setup(install = true) {
  const db = await fixture();
  try {
    for (const file of ['outputs/ctw-vocabulary-phase3/ctw-vocabulary-phase3-install.sql',
      'supabase/ctw_vocabulary_phase3_start_owner_fix.sql', 'supabase/ctw_vocabulary_review_sync.sql']) await db.exec(read(file));
    if (install) await db.exec(read(migration));
    return db;
  } catch (e) { await db.close(); throw e; }
}
const progress = (db, owner = U) => store.readVocabularyOverallProgress(client(db, 'authenticated', owner));
async function entries(db) { return (await db.query('select * from ctw_vocabulary_entries order by list_number,list_position')).rows; }
async function save(db, words, owner = U, wrong = false, mode = 'base_form', attemptId = randomUUID()) {
  return store.saveVocabularyAttempt(client(db, 'service_role', owner), owner, { attemptId, mode,
    answers: words.map(e => ({ entryId: e.entry_id, spelling: wrong ? 'wrong' : mode === 'irregular' ? e.irregular_forms[0].answers[0] : e.word,
      ...(mode === 'irregular' ? { formType: e.irregular_forms[0].form_type } : {}) })) });
}
async function firstAnswer(db, source, wrong = false, owner = U) {
  const round = await server.createCtwReview(client(db, 'authenticated', owner), client(db, 'service_role', owner), owner,
    { requestId: randomUUID(), source });
  const card = round.cards[0], service = client(db, 'service_role', owner);
  await server.syncCtwReview(service, owner, round.session.session_id, { id: randomUUID(), itemId: card.itemId, action: 'start_test' });
  const command = { id: randomUUID(), itemId: card.itemId, action: 'answer', answer: { spellings: Object.fromEntries(card.spellingGroups.map(g =>
    [g.id, wrong ? 'wrong' : g.requiredAll ? g.accepted.join(' / ') : g.accepted[0]])) } };
  await server.syncCtwReview(service, owner, round.session.session_id, command);
  return { round, command };
}

test('fresh totals, no correct records, wrong-only history and an empty vocabulary', async () => {
  const db = await setup(); try {
    const words = await entries(db), total = words.length;
    assert.deepEqual(await progress(db), { total, mastered: 0 });
    await save(db, words.slice(0, 3), U, true);
    assert.deepEqual(await progress(db), { total, mastered: 0 });
    await db.exec('delete from ctw_vocabulary_cefr_memberships; delete from ctw_vocabulary_entries');
    assert.deepEqual(await progress(db), { total: 0, mastered: 0 });
  } finally { await db.close(); }
});

test('cross-attempt and spelling-mode deduplication uses entry_id, never sum of scores or display positions', async () => {
  const db = await setup(); try {
    const words = await entries(db), form = words.find(e => e.irregular_forms.length);
    const id = randomUUID();
    await save(db, [form], U, false, 'base_form', id);
    await save(db, [form], U, false, 'base_form', id); // ACK retry
    await save(db, [form]);
    await save(db, [form], U, false, 'irregular');
    assert.deepEqual(await progress(db), { total: words.length, mastered: 1 });
    await save(db, words.filter(e => e.entry_id !== form.entry_id).slice(0, 2));
    await save(db, [form], U, true);
    assert.deepEqual(await progress(db), { total: words.length, mastered: 3 });
    const calls = [];
    await store.readVocabularyOverallProgress(client(db, 'authenticated', U, calls));
    assert.equal(calls.length, 1); assert.equal(calls[0].operation, 'rpc');
    assert.doesNotMatch(calls[0].sql, /attempts|review_sessions|jsonb_array_elements/);
  } finally { await db.close(); }
});

test('correct answer counts immediately before round completion; mixed/CEFR share IDs and ACK retries cannot double count', async () => {
  const db = await setup(); try {
    const total = (await entries(db)).length;
    const { round, command } = await firstAnswer(db, { kind: 'list', listNumber: 1 });
    assert.deepEqual(await progress(db), { total, mastered: 1 });
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n, 0);
    await server.syncCtwReview(client(db, 'service_role'), U, round.session.session_id, command);
    const entry = (await entries(db)).find(e => e.entry_id === command.itemId);
    const member = (await db.query('select * from ctw_vocabulary_cefr_memberships where entry_id=$1', [entry.entry_id])).rows[0];
    const cefr = await server.createCtwReview(client(db, 'authenticated'), client(db, 'service_role'), U,
      { requestId: randomUUID(), source: { kind: 'cefr_list', group: member.cefr_group, listNumber: member.list_number } });
    assert.ok(cefr.cards.some(c => c.itemId === entry.entry_id));
    await save(db, [entry]); // final attempt coexists with correct session answer
    assert.deepEqual(await progress(db), { total, mastered: 1 });
    await firstAnswer(db, { kind: 'list', listNumber: 2 }, true);
    assert.deepEqual(await progress(db), { total, mastered: 1 });
  } finally { await db.close(); }
});

test('migration backfills old final results and unfinished correct answers once, without rewriting history', async () => {
  const db = await setup(false); try {
    const words = await entries(db);
    await save(db, words.slice(0, 2));
    await save(db, [words[0]]);
    await save(db, [words[2]], U, true);
    await firstAnswer(db, { kind: 'list', listNumber: 2 });
    const before = (await db.query('select * from student_ctw_vocabulary_attempts order by attempt_id')).rows;
    await db.exec(read(migration));
    assert.deepEqual(await progress(db), { total: words.length, mastered: 3 });
    assert.deepEqual((await db.query('select * from student_ctw_vocabulary_attempts order by attempt_id')).rows, before);
  } finally { await db.close(); }
});

test('completed mixed and CEFR rounds deduplicate their overlap and their final attempt/session copies', async () => {
  const db = await setup(); try {
    const words = await entries(db), mastered = new Set();
    const member = (await db.query('select * from ctw_vocabulary_cefr_memberships where entry_id=$1', [words[0].entry_id])).rows[0];
    for (const source of [{ kind: 'list', listNumber: 1 }, { kind: 'cefr_list', group: member.cefr_group, listNumber: member.list_number }]) {
      const round = await server.createCtwReview(client(db, 'authenticated'), client(db, 'service_role'), U, { requestId: randomUUID(), source });
      const service = client(db, 'service_role');
      const act = (action, card, answer) => server.syncCtwReview(service, U, round.session.session_id,
        { id: randomUUID(), action, itemId: card.itemId, ...(answer ? { answer } : {}) });
      await act('start_test', round.cards[0]);
      for (const card of round.cards) {
        await act('answer', card, { spellings: Object.fromEntries(card.spellingGroups.map(g =>
          [g.id, g.requiredAll ? g.accepted.join(' / ') : g.accepted[0]])) });
        mastered.add(card.itemId);
        assert.equal((await progress(db)).mastered, mastered.size);
        await act('advance', card);
      }
      assert.equal((await progress(db)).mastered, mastered.size);
    }
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n, 2);
    assert.ok(mastered.size < 100); // Same entry really appeared in both editions.
    assert.deepEqual(await progress(db), { total: words.length, mastered: mastered.size });
  } finally { await db.close(); }
});

test('a partly correct word with a wrong required irregular form never counts as mastered', async () => {
  const db = await setup(); try {
    const words = await entries(db), entry = words.find(e => e.irregular_forms.length);
    const request = { attemptId: randomUUID(), mode: 'base_form', answers: [{ entryId: entry.entry_id, spelling: entry.word,
      irregularSpellings: entry.irregular_forms.map(form => ({ formType: form.form_type, spelling: 'wrong' })) }] };
    const result = await store.saveVocabularyAttempt(client(db, 'service_role'), U, request);
    assert.equal(result.answers[0].baseCorrect, true); assert.equal(result.answers[0].correct, false);
    assert.deepEqual(await progress(db), { total: words.length, mastered: 0 });
  } finally { await db.close(); }
});

test('real append importer adds new words only; duplicate import, deletion and RLS visibility changes keep numerator intersected', async () => {
  const db = await setup(); try {
    const words = await entries(db), total = words.length;
    await save(db, words.slice(0, 2));
    const payload = [{ word: 'syntheticfutureword', list_id: 'List 21', cefr: 'B1', senses: words[0].senses, irregular_forms: [] },
      { word: words[0].word.toUpperCase(), list_id: 'List 21', cefr: words[0].cefr, senses: words[0].senses, irregular_forms: [] }];
    const sql = buildVocabularyImportSql(payload, 'b'.repeat(64), 'append');
    await db.exec(sql);
    assert.deepEqual(await progress(db), { total: total + 1, mastered: 2 });
    await db.exec(sql);
    assert.deepEqual(await progress(db), { total: total + 1, mastered: 2 });
    const added = (await entries(db)).find(e => e.word === 'syntheticfutureword');
    await save(db, [added]);
    assert.deepEqual(await progress(db), { total: total + 1, mastered: 3 });
    await db.query('delete from ctw_vocabulary_cefr_memberships where entry_id=$1', [added.entry_id]);
    await db.query('delete from ctw_vocabulary_entries where entry_id=$1', [added.entry_id]);
    assert.deepEqual(await progress(db), { total, mastered: 2 });
    // Actual schema has no is_active; simulate an effective-set restriction via
    // the same RLS that all catalog reads obey, without adding a feature flag.
    await db.exec(`create policy synthetic_effective_set on ctw_vocabulary_entries as restrictive for select to authenticated
      using (entry_id <> '${words[0].entry_id}'::uuid)`);
    assert.deepEqual(await progress(db), { total: total - 1, mastered: 1 });
    await db.exec('drop policy synthetic_effective_set on ctw_vocabulary_entries');
    assert.deepEqual(await progress(db), { total, mastered: 2 });
  } finally { await db.close(); }
});

test('self-only student/teacher/admin data, inactive denial and no browser/service mastery forgery', async () => {
  const db = await setup(); try {
    const words = await entries(db), total = words.length;
    await save(db, words.slice(0, 2), U);
    for (const owner of [V, T, A]) {
      assert.deepEqual(await progress(db, owner), { total, mastered: 0 });
      await save(db, words.slice(2, 3), owner);
      assert.deepEqual(await progress(db, owner), { total, mastered: 1 });
    }
    assert.deepEqual(await progress(db, U), { total, mastered: 2 });
    assert.deepEqual(await progress(db, X), { total: 0, mastered: 0 });
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [V]);
    await db.exec('set role authenticated');
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_mastered_words')).rows[0].n, 1);
    for (const sql of ['delete from student_ctw_vocabulary_mastered_words',
      `insert into student_ctw_vocabulary_mastered_words values('${V}','${words[0].entry_id}')`,
      'select ctw_vocab_private.record_mastered_attempt()', 'select ctw_vocab_private.record_mastered_review()'])
      await assert.rejects(db.exec(sql), /permission denied/);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.exec('select public.read_ctw_vocabulary_overall_progress_v1()'), /permission denied/);
    await db.exec('reset role; set role service_role');
    await assert.rejects(db.exec(`insert into student_ctw_vocabulary_mastered_words values('${V}','${words[0].entry_id}')`), /permission denied/);
    await db.exec('reset role');
  } finally { await db.close(); }
});

test('mastery rolls back with a failed submission instead of getting ahead of saved answers', async () => {
  const db = await setup(); try {
    const words = await entries(db);
    await db.exec(`create function public.synthetic_fail() returns trigger language plpgsql as $$ begin raise exception 'synthetic rollback'; end $$;
      create trigger z_synthetic_fail after insert on student_ctw_vocabulary_attempts for each row execute function public.synthetic_fail()`);
    await assert.rejects(save(db, words.slice(0, 1)), /DATABASE/);
    assert.deepEqual(await progress(db), { total: words.length, mastered: 0 });
  } finally { await db.close(); }
});
