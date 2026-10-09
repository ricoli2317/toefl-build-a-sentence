const test=require('node:test'),assert=require('node:assert/strict');
const h=require('./helpers/wordbookOccurrenceChoiceFixture.cjs');
const engineTest=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const rows=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
const tables=['lexical_entries','lexical_occurrences','student_wordbook_entries','student_wordbook_senses',
  'student_wordbook_examples','student_wordbook_source_evidence','student_wordbook_activities',
  'student_wordbook_review_sessions','student_wordbook_review_items','student_wordbook_review_answers'];
async function preserved(db){const result={};for(const name of tables)result[name]=await rows(db,`select to_jsonb(t) v from ${name} t order by to_jsonb(t)::text`);return result;}

test('manual patch is incremental; concurrent index is standalone; checks do not scan corpus or invoke candidates',()=>{
  const index=h.read(h.files.index);assert.match(index,/create index concurrently/);assert.doesNotMatch(index,/\bbegin\b/i);
  for(const file of [h.files.verify]){const sql=h.read(file);assert.match(sql,/begin transaction read only/);
    assert.doesNotMatch(sql,/\bfrom public\.(lexical_|student_wordbook_(entries|senses|review_items|review_sessions))/i);}
  const migration=h.read(h.files.migration);assert.doesNotMatch(migration,/\b(delete from|truncate|alter table|create (table|materialized))/i);
});

engineTest('common_senses empty: uncollected canonical occurrences enable RAP/BAS/RDL with exact source answers; highest modes/POS7 unaffected',async()=>{
  const db=await h.fixture();try{
    await h.save(db,{expression:'system',source:'ctw',meaning:'机制',pos:'noun'});
    await h.save(db,{expression:'system',source:'rap',meaning:'系统',pos:'noun'});
    await h.save(db,{expression:'system',source:'rdl',meaning:'体系',pos:'noun'});
    await h.save(db,{expression:'class',source:'bas',meaning:'班级',pos:'noun'});
    await h.save(db,{expression:'class',source:'write_email',meaning:'课程',pos:'noun'});
    await h.pool(db);
    assert.equal((await h.availability(db,h.settings(['rap']))).reasons.insufficient_distractors,1);
    assert.equal((await rows(db,"select sum(jsonb_array_length(common_senses))::int n from lexical_entries"))[0].n,0);
    await h.install(db);
    for(const [sources,domain,kind,meaning] of [[['rap'],'reading','meaning_choice','系统'],[['rdl'],'reading','meaning_choice','体系'],
      [['bas'],'writing','meaning_choice','班级'],[['ctw'],'reading','spelling_pos','机制'],
      [['ctw','rap'],'reading','spelling_pos','机制'],[['write_email'],'writing','spelling_pos','课程'],
      [['bas','write_email'],'writing','spelling_pos','课程']]){
      const a=await h.availability(db,h.settings(sources,domain));assert.equal(a.total,1);assert.equal(a.unavailable,0);
      const s=await h.create(db,h.settings(sources,domain));assert.equal(s.item.kind,kind);assert.equal(s.session.total,1);
      assert.equal(s.item.answer,undefined);assert.ok(!JSON.stringify(s.item).includes('correctOptionId'));
      if(kind==='meaning_choice'){
        assert.equal(s.item.options.length,4);assert.equal(s.item.options.filter(o=>o.text===meaning).length,1);
        const answer=await h.submit(db,s.session.session_id,s.item.itemId,{optionId:s.item.options.find(o=>o.text===meaning).id});
        assert.equal(answer.summary.choiceCorrect,1);assert.equal(answer.item.answer.meaning,meaning);
      }else{assert.equal(s.item.prompt,meaning);assert.equal(s.item.options.length,7);}
    }
    assert.equal((await rows(db,'select count(*)::int n from student_wordbook_entries'))[0].n,2);
  }finally{await db.close();}
});

engineTest('entry/meaning and cross-entry repeats never duplicate choices; indexed seek preserves exhaustive occurrence greedy result',async()=>{
  const db=await h.fixture();try{
    await h.save(db,{source:'rap',meaning:'系统',pos:'noun'});await h.pool(db);
    for(let n=0;n<25;n++)await h.occurrence(db,{expression:'ocean',meaning:n%2?' 海洋 ':'海洋'});
    await h.occurrence(db,{expression:'another-ocean',meaning:'海洋'});
    // First UUID with this meaning is disabled; a later valid entry must not be skipped.
    await h.occurrence(db,{expression:'bad-first',meaning:'火山',entryStatus:'disabled',id:'00000000-0000-0000-0000-000000000001'});
    await h.occurrence(db,{expression:'run',meaning:'火山'});
    await h.occurrence(db,{expression:'good-later',meaning:'火山',id:'ffffffff-ffff-ffff-ffff-ffffffffffff'});
    await h.install(db);
    const c=(await rows(db,'select * from wordbook_review_candidates($1,$2,$3,null,null)',[h.U,'reading',['rap']]))[0];
    const all=await rows(db,`select distinct o.entry_id,btrim(o.context_meaning_zh) collate "C" meaning from lexical_occurrences o
      join lexical_entries e using(entry_id) where o.review_status='generated' and e.review_status='generated'
      and o.context_meaning_zh~'[一-龥]' and length(o.context_meaning_zh) between 1 and 160
      and e.normalized_expression<>'run' order by meaning,o.entry_id`);
    const selected=[];for(const p of all){const conflict=(await rows(db,`select wordbook_review_meaning_conflict('系统',$1)
      or exists(select 1 from unnest($2::text[]) m where wordbook_review_meaning_conflict(m,$1)) bad`,[p.meaning,selected.map(s=>s.text)]))[0].bad;
      if(!conflict)selected.push({text:p.meaning,lexicalEntryId:p.entry_id});if(selected.length===3)break;}
    assert.deepEqual(c.snapshot.distractors,selected);
    const s=await h.create(db,h.settings(['rap']));assert.equal(new Set(s.item.options.map(o=>o.text)).size,4);
    assert.deepEqual((await h.get(db,s.session.session_id)).item.options,s.item.options);
  }finally{await db.close();}
});

engineTest('reliability/target/variant/synonym/pairwise conflicts still fail closed; occurrence data cannot replace the selected saved sense',async()=>{
  const db=await h.fixture();try{
    await h.save(db,{expression:'class',source:'bas',meaning:'班级',pos:'noun'});
    await h.save(db,{expression:'class',source:'write_email',meaning:'课程',pos:'noun'});
    for(const p of [
      {expression:'class',meaning:'班群',variant:'other'}, {expression:'near',meaning:'班组'},
      {expression:'course',meaning:'课程'}, {expression:'pending',meaning:'火山',status:'needs_review'},
      {expression:'disabled',meaning:'岩石',entryStatus:'disabled'}, {expression:'english',meaning:'English'},
      {expression:'long',meaning:'中'.repeat(161)}, {expression:'ocean',meaning:'海洋'}, {expression:'coast',meaning:'海岸'}
    ])await h.occurrence(db,p);
    await h.install(db);const a=await h.availability(db,h.settings(['bas'],'writing'));
    assert.equal(a.total,0);assert.equal(a.reasons.insufficient_distractors,1);
    await h.occurrence(db,{expression:'forest',meaning:'森林'});await h.occurrence(db,{expression:'music',meaning:'音乐'});
    const s=await h.create(db,h.settings(['bas'],'writing'));assert.ok(s.item.options.some(o=>o.text==='班级'));
    for(const o of s.item.options)assert.ok(!['班群','班组','课程','火山','岩石','English','中'.repeat(161)].includes(o.text));
    const wrong=s.item.options.find(o=>o.text!=='班级').id;
    const answer=await h.submit(db,s.session.session_id,s.item.itemId,{optionId:wrong});assert.equal(answer.summary.correct,0);
    const retry=await h.create(db,{},h.U,s.session.session_id);assert.notEqual(retry.session.session_id,s.session.session_id);
    assert.deepEqual(retry.item.options.map(o=>o.text).sort(),s.item.options.map(o=>o.text).sort());
    assert.deepEqual((await h.get(db,s.session.session_id)).summary,answer.summary);
  }finally{await db.close();}
});

engineTest('installation preserves all existing data/snapshots/other RPCs/ACLs; spelling does not read occurrences; audit drift rejects',async()=>{
  const db=await h.fixture();try{
    await h.save(db,{expression:'system',meaning:'系统',pos:'noun'});const historical=await h.create(db);
    await h.submit(db,historical.session.session_id,historical.item.itemId,{spelling:'system',pos:'noun'});
    const before=await preserved(db);const metadata=await rows(db,"select oid,proowner,proacl,prosrc from pg_proc where proname like 'wordbook_review_%' and proname<>'wordbook_review_candidates' order by oid");
    const candidateMetadata=await rows(db,"select oid,proowner,proacl from pg_proc where proname='wordbook_review_candidates'");
    await h.install(db);assert.deepEqual(await preserved(db),before);
    assert.deepEqual(await rows(db,"select oid,proowner,proacl,prosrc from pg_proc where proname like 'wordbook_review_%' and proname<>'wordbook_review_candidates' order by oid"),metadata);
    assert.deepEqual(await rows(db,"select oid,proowner,proacl from pg_proc where proname='wordbook_review_candidates'"),candidateMetadata);
    // Spelling must not prepare a global pool (even without table permission).
    await db.exec('revoke select on lexical_occurrences from service_role; set role service_role');
    assert.equal((await h.availability(db)).spellingPos,1);await db.exec('reset role');
    for(const role of ['anon','authenticated']){await db.exec('set role '+role);
      await assert.rejects(h.availability(db),/permission denied/);await db.exec('reset role');}
    await assert.rejects(db.exec(h.read(h.files.migration)),/BASELINE_DRIFT/);await db.exec('rollback');
    const body=(await rows(db,"select pg_get_functiondef('wordbook_review_candidates(uuid,text,text[],timestamptz,timestamptz)'::regprocedure) v"))[0].v;
    await db.exec(body.replace('if not found then exit; end if;','if not found then exit; end if; -- DRIFT'));
    await assert.rejects(db.exec(h.read(h.files.verify)),/DEFINITION_DRIFT/);await db.exec('rollback');
  }finally{await db.close();}
});

engineTest('migration refuses missing/wrong index or body/ACL drift and rolls back a late failure',async()=>{
  const db=await h.fixture();try{
    await assert.rejects(db.exec(h.read(h.files.migration)),/VALID_INDEX_REQUIRED/);await db.exec('rollback');
    await db.exec('create index wordbook_review_occurrence_meaning_idx on lexical_occurrences(entry_id)');
    await assert.rejects(db.exec(h.read(h.files.migration)),/VALID_INDEX_REQUIRED/);await db.exec('rollback');
    await db.exec('drop index wordbook_review_occurrence_meaning_idx');
    await db.exec(h.read(h.files.index).replace('index concurrently','index'));
    const before=await rows(db,"select prosrc from pg_proc where proname='wordbook_review_candidates'");
    const broken=h.read(h.files.migration).replace('  update public.student_wordbook_review_installation','  perform 1/0;\n  update public.student_wordbook_review_installation');
    await assert.rejects(db.exec(broken),/division by zero/);await db.exec('rollback');
    assert.deepEqual(await rows(db,"select prosrc from pg_proc where proname='wordbook_review_candidates'"),before);
    await db.exec('grant execute on function wordbook_review_candidates(uuid,text,text[],timestamptz,timestamptz) to authenticated');
    await assert.rejects(db.exec(h.read(h.files.migration)),/ACL_DRIFT/);await db.exec('rollback');
  }finally{await db.close();}
});
