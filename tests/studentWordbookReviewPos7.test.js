const test=require('node:test'),assert=require('node:assert/strict');
const h=require('./helpers/wordbookReviewFixture.cjs');
const engineTest=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const files={migration:'supabase/student_wordbook_review_v1_pos7_migration.sql',verify:'supabase/student_wordbook_review_v1_pos7_verify.sql'};
const expected=[['noun','n.'],['verb','v.'],['adjective','adj.'],['adverb','adv.'],
  ['preposition','prep.'],['conjunction','conj.'],['pronoun','pron.']].map(([id,label])=>({id,label}));
const rows=async(db,sql,params=[])=>(await db.query(sql,params)).rows;
const patch=async db=>{for(const f of [files.migration,files.verify])await db.exec(h.read(f));};
const preserved=async db=>{
  const result={};
  for(const name of ['lexical_entries','lexical_occurrences','student_wordbook_entries','student_wordbook_senses',
    'student_wordbook_examples','student_wordbook_example_senses','student_wordbook_source_evidence',
    'student_wordbook_activities','student_wordbook_review_sessions','student_wordbook_review_items','student_wordbook_review_answers'])
    result[name]=await rows(db,`select to_jsonb(t) v from ${name} t order by to_jsonb(t)::text`);
  return result;
};

test('POS7 patch is incremental and read-only checks contain no corpus census or candidate invocation',()=>{
  for(const f of [files.verify]){
    const sql=h.read(f);assert.match(sql,/begin transaction read only/);
    assert.doesNotMatch(sql,/\bfrom public\.(lexical_|student_wordbook_(entries|senses|activities|review_items))/i);
    assert.doesNotMatch(sql,/select public\.wordbook_review_(availability|candidates|create|submit)\(/);
  }
  const migration=h.read(files.migration);
  assert.doesNotMatch(migration,/\b(delete from|truncate|alter table|create (table|index|materialized))/i);
  assert.doesNotMatch(migration,/\b(update|insert into) public\.(lexical_|student_wordbook_(entries|senses|activities|source_evidence|review_items|review_sessions|review_answers))/i);
});

engineTest('guarded patch preserves real-shaped collection/evidence/old session snapshots, owner/ACLs and unchanged grading RPCs',async()=>{
  const db=await h.fixture();try{
    await h.pool(db);await h.save(db,{pos:'proper_noun'});
    const historical=await h.create(db);
    assert.ok(historical.item.options.some(o=>o.id==='proper_noun'));
    await h.submit(db,historical.session.session_id,historical.item.itemId,{spelling:'run',pos:'verb'});
    const before=await preserved(db);
    const metadata=await rows(db,`select oid,proowner,proacl,proname,prosrc from pg_proc where proname in
      ('wordbook_review_pos','wordbook_review_submit','wordbook_review_public_item','wordbook_review_summary','operate_student_wordbook_v1') order by oid`);
    const owners=await rows(db,`select oid,proowner,proacl from pg_proc where proname in
      ('wordbook_review_pos_options','wordbook_review_candidates','wordbook_review_create') order by oid`);
    await patch(db);
    assert.deepEqual(await preserved(db),before);
    assert.deepEqual(await rows(db,`select oid,proowner,proacl,proname,prosrc from pg_proc where proname in
      ('wordbook_review_pos','wordbook_review_submit','wordbook_review_public_item','wordbook_review_summary','operate_student_wordbook_v1') order by oid`),metadata);
    assert.deepEqual(await rows(db,`select oid,proowner,proacl from pg_proc where proname in
      ('wordbook_review_pos_options','wordbook_review_candidates','wordbook_review_create') order by oid`),owners);
    const retry=await h.create(db,{},h.U,historical.session.session_id);
    assert.deepEqual(retry.item.options,expected);
    const result=await h.submit(db,retry.session.session_id,retry.item.itemId,{spelling:'run',pos:'noun'});
    assert.equal(result.item.answer.correct,true);assert.equal(result.item.answer.standardPos,'proper_noun');
    assert.equal((await h.get(db,historical.session.session_id)).summary.correct,0);
    for(const role of ['anon','authenticated']){
      await db.exec('set role '+role);
      await assert.rejects(db.exec("select public.wordbook_review_teaching_pos('noun')"),/permission denied/);
      await assert.rejects(db.exec('select public.wordbook_review_pos_options()'),/permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');assert.equal((await h.availability(db)).total,1);await db.exec('reset role');
    await assert.rejects(db.exec(h.read(files.migration)),/ALREADY_PRESENT/);await db.exec('rollback');
  }finally{await db.close();}
});

engineTest('fixed seven options require no corpus table permission or scan, and raw normalization is untouched',async()=>{
  const db=await h.fixture();try{
    await patch(db);
    await db.exec('revoke select on lexical_entries,lexical_occurrences from service_role; set role service_role');
    assert.deepEqual((await rows(db,'select wordbook_review_pos_options() p'))[0].p,expected);
    for(const [raw,want,original] of [['proper_noun','noun','proper_noun'],['prop. n.','noun','proper_noun'],
      ['phrasal_verb','verb','phrasal_verb'],['phr. v.','verb','phrasal_verb'],['aux. v.','verb','auxiliary'],['modal verb','verb','modal'],
      ['n.','noun','noun'],['v.','verb','verb'],['adj.','adjective','adjective'],['adv.','adverb','adverb'],
      ['prep.','preposition','preposition'],['conj.','conjunction','conjunction'],['pron.','pronoun','pronoun'],
      ['particle',null,'particle'],['determiner',null,'determiner'],['interjection',null,'interjection'],['numeral',null,'numeral'],
      ['other',null,null],['unknown',null,null],[null,null,null]]){
      const result=(await rows(db,'select wordbook_review_teaching_pos($1) teaching,wordbook_review_pos($1) original',[raw]))[0];
      assert.equal(result.teaching,want);assert.equal(result.original,original);
    }
    await db.exec('reset role');
    const source=(await rows(db,"select prosrc from pg_proc where oid='wordbook_review_pos_options()'::regprocedure"))[0].prosrc;
    assert.doesNotMatch(source,/lexical_|union|observed|jsonb_array_elements/i);
  }finally{await db.close();}
});

engineTest('CTW/WE/AD POS7 generation, aliases and all grading cases preserve raw collection POS and independent scores',async()=>{
  const db=await h.fixture();try{
    await patch(db);
    const cases=[['proper_noun','noun','ctw'],['phrasal_verb','verb','ctw'],['auxiliary','verb','write_email'],['modal','verb','academic_discussion'],
      ['adjective','adjective','ctw'],['adverb','adverb','ctw'],['preposition','preposition','ctw'],['conjunction','conjunction','ctw'],['pronoun','pronoun','ctw']];
    for(let n=0;n<cases.length;n++){
      const [raw,want,source]=cases[n],expression='entry'+n,domain=source==='ctw'?'reading':'writing';
      await h.save(db,{expression,source,pos:raw,meaning:'语境义'+n});
      const s=await h.create(db,h.settings([source],domain,1));
      assert.deepEqual(s.item.options,expected);assert.equal(s.item.kind,'spelling_pos');
      assert.equal(s.item.answer,undefined);assert.ok(!JSON.stringify(s.item).includes('standardPos'));
      await assert.rejects(h.submit(db,s.session.session_id,s.item.itemId,{spelling:expression,pos:'particle'}),/INVALID_ANSWER/);
      // Read only the isolated private snapshot to answer the RANDOMLY selected
      // entry, not an assumption that entryN was drawn.
      const snap=(await rows(db,'select snapshot from student_wordbook_review_items where item_id=$1',[s.item.itemId]))[0].snapshot;
      assert.equal(snap.pos,want);
      const a=await h.submit(db,s.session.session_id,s.item.itemId,{spelling:snap.expression,pos:want});
      assert.equal(a.item.answer.correct,true);assert.equal(a.summary.posCorrect,1);
      assert.equal((await rows(db,'select context_pos from student_wordbook_senses where sense_id=$1',[snap.senseId]))[0].context_pos,snap.standardPos);
    }
    // Single known source/entry fixture isolates all three score combinations.
    await h.save(db,{source:'write_email',expression:'scoreword',pos:'verb'});
    for(const [spelling,pos,sc,pc] of [['scoreword','verb',true,true],['scoreword','noun',true,false],['wrong','verb',false,true]]){
      const selected=await rows(db,"select wordbook_entry_id from student_wordbook_entries where domain='writing' and expression<>'scoreword'");
      if(selected.length)await h.remove(db,selected.map(e=>e.wordbook_entry_id),'writing');
      const s=await h.create(db,h.settings(['write_email'],'writing'));
      const a=await h.submit(db,s.session.session_id,s.item.itemId,{spelling,pos});
      assert.equal(a.item.answer.assessments.spelling,sc);assert.equal(a.item.answer.assessments.pos,pc);
      assert.equal(a.item.answer.correct,sc&&pc);assert.equal(a.summary.posCorrect,pc?1:0);
      assert.deepEqual(await h.submit(db,s.session.session_id,s.item.itemId,{spelling:'tamper',pos:'noun'}),a);
    }
    assert.deepEqual((await h.availability(db)).posOptions,(await h.availability(db,h.settings(['write_email'],'writing'))).posOptions);
  }finally{await db.close();}
});

engineTest('unsupported POS fail closed without downgrading mixed sources; four-choice eligibility/options and exact evidence unchanged',async()=>{
  const db=await h.fixture();try{
    await h.pool(db);await h.save(db,{source:'rap',pos:'particle',meaning:'保持'});
    const before=(await rows(db,'select * from wordbook_review_candidates($1,$2,$3,null,null)',[h.U,'reading',['rap']]))[0];
    await patch(db);
    const after=(await rows(db,'select * from wordbook_review_candidates($1,$2,$3,null,null)',[h.U,'reading',['rap']]))[0];
    for(const key of ['posOptions']){delete before.snapshot[key];delete after.snapshot[key];}
    assert.deepEqual(after,before);assert.equal(after.snapshot.standardPos,'particle');
    const choice=await h.create(db,h.settings(['rap']));assert.equal(choice.item.options.length,4);
    assert.ok(!JSON.stringify(choice.item).includes('correctOptionId'));
    const correct=choice.item.options.find(o=>o.text==='保持').id;
    assert.equal((await h.submit(db,choice.session.session_id,choice.item.itemId,{optionId:correct})).summary.choiceCorrect,1);
    for(const [n,pos] of ['particle','determiner','interjection','numeral','other',null].entries()){
      await h.save(db,{expression:'unsupported'+n,pos});
    }
    const a=await h.availability(db);assert.equal(a.total,0);assert.equal(a.reasons.missing_reliable_pos,6);
    await h.save(db,{source:'ctw',pos:'particle',meaning:'保持'});
    assert.equal((await h.availability(db,h.settings(['ctw','rap']))).total,0);
    assert.equal((await h.availability(db,h.settings(['rap']))).total,1);
    assert.equal((await h.create(db,h.settings(['rap']))).item.kind,'meaning_choice');
    // Existing no-example collections still qualify via direct evidence, not
    // inferred example-source arrays, after this function-only patch.
    await h.save(db,{expression:'noexample',pos:'phrasal verb',meaning:'照料',example:false});
    const c=(await rows(db,'select snapshot from wordbook_review_candidates($1,$2,$3,null,null) where snapshot->>\'expression\'=\'noexample\'',[h.U,'reading',['ctw']]))[0].snapshot;
    assert.equal(c.pos,'verb');assert.equal(c.examples.length,0);assert.equal(c.evidence[0].source_type,'ctw');
  }finally{await db.close();}
});

engineTest('all six source modes and matched-source highest difficulty still use one accurate sense per entry',async()=>{
  const db=await h.fixture();try{
    await patch(db);await h.pool(db);
    await h.save(db,{source:'ctw',pos:'proper_noun',meaning:'专用系统'});
    await h.save(db,{source:'rap',pos:'noun',meaning:'系统'});
    await h.save(db,{source:'rdl',pos:'noun',meaning:'系统'});
    await h.save(db,{source:'bas',pos:'noun',meaning:'班级'});
    await h.save(db,{source:'write_email',pos:'modal',meaning:'能够'});
    await h.save(db,{source:'academic_discussion',pos:'auxiliary',meaning:'助力'});
    const cases=[['reading',['ctw'],'spelling_pos','专用系统','noun'],['reading',['rap'],'meaning_choice','run',null],
      ['reading',['rdl'],'meaning_choice','run',null],['reading',['ctw','rap'],'spelling_pos','专用系统','noun'],
      ['writing',['bas'],'meaning_choice','run',null],['writing',['write_email'],'spelling_pos','能够','verb'],
      ['writing',['academic_discussion'],'spelling_pos','助力','verb'],['writing',['bas','write_email'],'spelling_pos','能够','verb']];
    for(const [domain,sources,kind,prompt,pos] of cases){
      const a=await h.availability(db,h.settings(sources,domain));assert.equal(a.total,1);
      const s=await h.create(db,h.settings(sources,domain));assert.equal(s.item.kind,kind);assert.equal(s.item.prompt,prompt);
      const items=await rows(db,'select snapshot from student_wordbook_review_items where session_id=$1',[s.session.session_id]);
      assert.equal(items.length,1);
      if(pos){assert.deepEqual(s.item.options,expected);assert.equal(items[0].snapshot.pos,pos);}
      else assert.equal(s.item.options.length,4);
      assert.ok(s.item.sourceTypes.every(source=>sources.includes(source)));
      assert.ok(items[0].snapshot.evidence.every(ev=>s.item.sourceTypes.includes(ev.source_type)));
    }
  }finally{await db.close();}
});

engineTest('migration rejects body or ACL drift, and a late patch failure rolls back every replacement',async()=>{
  const db=await h.fixture();try{
    await db.exec('grant execute on function wordbook_review_pos_options() to authenticated');
    await assert.rejects(db.exec(h.read(files.migration)),/ACL_DRIFT/);await db.exec('rollback');
    await db.exec('revoke execute on function wordbook_review_pos_options() from authenticated');
    const definitions=await rows(db,"select oid,prosrc from pg_proc where proname like 'wordbook_review_%' order by oid");
    const original=(await rows(db,"select prosrc from pg_proc where oid='wordbook_review_pos_options()'::regprocedure"))[0].prosrc;
    await db.exec("create or replace function wordbook_review_pos_options() returns jsonb language sql stable set search_path=pg_catalog as $$ select '[]'::jsonb $$");
    await assert.rejects(db.exec(h.read(files.migration)),/BASELINE_DRIFT/);await db.exec('rollback');
    await db.exec('create or replace function wordbook_review_pos_options() returns jsonb language sql stable set search_path=pg_catalog as $restore$'+original+'$restore$');
    const broken=h.read(files.migration).replace('  -- Preserve cleanup/protected-count/installation history;',"  perform 1/0;\n  -- Preserve cleanup/protected-count/installation history;");
    await assert.rejects(db.exec(broken),/division by zero/);await db.exec('rollback');
    assert.deepEqual(await rows(db,"select oid,prosrc from pg_proc where proname like 'wordbook_review_%' order by oid"),definitions);
    await patch(db);
    // Verify must reject a changed body even if someone also updates the audit
    // to match it. This patch has independent expected definition fingerprints.
    await db.exec("create or replace function wordbook_review_pos_options() returns jsonb language sql stable set search_path=pg_catalog as $$ select '[]'::jsonb $$");
    await db.exec(`update student_wordbook_review_installation set function_hashes=jsonb_set(function_hashes,
      array['wordbook_review_pos_options()'],to_jsonb((select md5(btrim(replace(prosrc,E'\\r\\n',E'\\n'),E' \\t\\r\\n')) from pg_proc where oid='wordbook_review_pos_options()'::regprocedure)))`);
    await assert.rejects(db.exec(h.read(files.verify)),/PATCH_DEFINITION_DRIFT/);await db.exec('rollback');
  }finally{await db.close();}
});
