const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const h=require('./helpers/wordbookReviewFixture.cjs');
const {parseReviewSettings,ReviewError}=require('../lib/lexical/wordbookReview.ts');
const {reviewRpc}=require('../lib/lexical/wordbookReview.server.ts');
const engineTest=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const query=async(db,sql,args=[])=>(await db.query(sql,args)).rows;
const items=async(db,id)=>query(db,'select * from student_wordbook_review_items where session_id=$1 order by position',[id]);
const counts=async(db)=>query(db,'select wordbook_entry_id,count(*)::integer n from student_wordbook_review_items group by wordbook_entry_id');

test('strict API settings and RPC errors reject injected owners, invalid source combinations/counts, and never expose private DB errors',async()=>{
  assert.deepEqual(parseReviewSettings(h.settings(['rap','ctw'])).sources,['ctw','rap']);
  for(const v of [{...h.settings(),student_id:h.V},{...h.settings(),sources:[]},{...h.settings(),sources:['ctw','ctw']},
    {...h.settings(),sources:['bas']},{...h.settings(),count:0},{...h.settings(),count:1.5},{...h.settings(),timeZone:'bad'}])assert.throws(()=>parseReviewSettings(v),ReviewError);
  await assert.rejects(reviewRpc({rpc:async()=>({error:{message:'REVIEW_INSUFFICIENT:7'},data:null})},'x',{}),e=>e.status===409&&e.message.includes('7'));
  await assert.rejects(reviewRpc({rpc:async()=>({error:{message:'secret SQL failure'},data:null})},'x',{}),e=>e.status===503&&!e.message.includes('secret'));
});

engineTest('approved cleanup and fresh evidence/review schema install atomically; Verify is read-only and corpus/users are unchanged',async()=>{
  const db=await h.beforeMigration();try{
    const before=await query(db,'select to_jsonb(e) v from lexical_entries e order by entry_id');
    const users=await query(db,'select * from auth.users order by id');
    await db.exec(h.read('supabase/student_wordbook_review_v1_preflight.sql'));
    await db.exec(h.read('supabase/student_wordbook_review_v1_migration.sql'));
    assert.equal((await query(db,'select count(*)::int n from student_wordbook_entries'))[0].n,0);
    assert.deepEqual(await query(db,'select to_jsonb(e) v from lexical_entries e order by entry_id'),before);
    assert.deepEqual(await query(db,'select * from auth.users order by id'),users);
    await db.exec(h.read('supabase/student_wordbook_review_v1_verify.sql'));
    await assert.rejects(db.exec(h.read('supabase/student_wordbook_review_v1_migration.sql')),/COUNT_DRIFT|ALREADY_INSTALLED/);await db.exec('rollback');
    const source=h.read('supabase/student_wordbook_review_v1_migration.sql');
    assert.doesNotMatch(source,/\b(delete from|update|alter table|insert into) public\.(lexical_|profiles|auth\.)/i);
  }finally{await db.close();}
});

engineTest('count/account/extra-owner/inbound FK drift stops cleanup; late installation error rolls back the 81 parent rows',async()=>{
  const db=await h.beforeMigration();try{
    const before=(await query(db,'select count(*)::int n from student_wordbook_entries'))[0].n;
    await db.query("update auth.users set email='different@offline.invalid' where id=$1",[h.approved[0][0]]);
    await assert.rejects(db.exec(h.read('supabase/student_wordbook_review_v1_migration.sql')),/ACCOUNT_DRIFT/);await db.exec('rollback');
    assert.equal((await query(db,'select count(*)::int n from student_wordbook_entries'))[0].n,before);
    await db.query('update auth.users set email=$2 where id=$1',[h.approved[0][0],h.approved[0][1]]);
    await h.save(db,{expression:'outside'});
    await assert.rejects(db.exec(h.read('supabase/student_wordbook_review_v1_migration.sql')),/UNAPPROVED/);await db.exec('rollback');
    await db.query('delete from student_wordbook_entries where student_id=$1',[h.U]);
    await db.exec('create table unexpected_child(id uuid references student_wordbook_entries(wordbook_entry_id) on delete cascade)');
    await assert.rejects(db.exec(h.read('supabase/student_wordbook_review_v1_migration.sql')),/UNKNOWN_INBOUND_FK/);await db.exec('rollback');
    await db.exec('drop table unexpected_child');
    const altered=h.read('supabase/student_wordbook_review_v1_migration.sql').replace("notify pgrst,'reload schema';","select 1/0;");
    await assert.rejects(db.exec(altered),/division by zero/);await db.exec('rollback');
    assert.equal((await query(db,'select count(*)::int n from student_wordbook_entries'))[0].n,81);
    assert.equal((await query(db,"select to_regclass('student_wordbook_source_evidence') t"))[0].t,null);
    await db.query("delete from student_wordbook_entries where wordbook_entry_id=(select wordbook_entry_id from student_wordbook_entries limit 1)");
    await assert.rejects(db.exec(h.read('supabase/student_wordbook_review_v1_preflight.sql')),/COUNT_DRIFT/);await db.exec('rollback');
  }finally{await db.close();}
});

engineTest('source-to-sense evidence is exact across CTW/RAP and shared senses, no-example, repeats, source changes and deletion cascades',async()=>{
  const db=await h.fixture();try{
    const a=await h.save(db,{pos:'verb',meaning:'运行',example:false});
    await h.save(db,{source:'rap',pos:'noun',meaning:'运行过程'});
    const initial=(await h.events(db)).length;
    await h.save(db,{source:'rap',pos:'noun',meaning:'运行过程'});
    assert.equal((await h.events(db)).length,initial);
    const edges=await query(db,`select s.context_pos,ev.source_type from student_wordbook_source_evidence ev
      join student_wordbook_senses s using(sense_id) order by s.context_pos,ev.source_type`);
    assert.deepEqual(edges,[{context_pos:'noun',source_type:'rap'},{context_pos:'verb',source_type:'ctw'}]);
    await h.save(db,{source:'rap',pos:'verb',meaning:'运行',example:false});
    assert.equal((await query(db,'select count(*)::int n from student_wordbook_senses'))[0].n,2);
    assert.equal((await query(db,'select count(*)::int n from student_wordbook_source_evidence'))[0].n,3);
    const activityBefore=(await h.events(db)).length;
    // Same sense/source from another legitimate occurrence adds evidence, not a false collection activity.
    await db.exec(`update lexical_occurrences set occurrence_id=gen_random_uuid()`);
    const occurrence=(await query(db,'select occurrence_id from lexical_occurrences'))[0].occurrence_id;
    const p=await h.payload(db,occurrence);Object.assign(p,{example_text:null,context_kind:null,extraction_method:'verified_no_example_boundary'});
    await db.query('select operate_student_wordbook_v1($1,$2,$3,$4::jsonb)',[h.U,occurrence,'save',JSON.stringify(p)]);
    assert.equal((await h.events(db)).length,activityBefore);
    // Restore the test helper's occurrence transport identity in the isolated fixture.
    await db.query('update lexical_occurrences set occurrence_id=$1',[h.O]);
    await h.remove(db,[a.wordbookEntryId]);assert.equal((await query(db,'select count(*)::int n from student_wordbook_source_evidence'))[0].n,0);
    const b=await h.save(db,{source:'bas'});await h.save(db,{source:'write_email'});
    assert.equal((await h.list(db,{domain:'writing'})).total,1);
    await h.remove(db,[b.wordbookEntryId],'writing');
    assert.equal((await query(db,'select count(*)::int n from student_wordbook_source_evidence'))[0].n,0);
  }finally{await db.close();}
});

engineTest('all six source modes, selected intersection priority, exact matching sense and per-entry uniqueness',async()=>{
  const db=await h.fixture();try{
    await h.pool(db);await h.save(db,{pos:'verb',meaning:'运行'});await h.save(db,{source:'rap',pos:'noun',meaning:'运行过程'});await h.save(db,{source:'rdl',pos:'noun',meaning:'运行过程'});
    for(const [sources,kind,prompt] of [[['rap'],'meaning_choice','run'],[['rdl'],'meaning_choice','run'],[['ctw'],'spelling_pos','运行'],
      [['ctw','rap'],'spelling_pos','运行'],[['rdl','rap'],'meaning_choice','run'],[['ctw','rdl','rap'],'spelling_pos','运行']]){
      const a=await h.availability(db,h.settings(sources));assert.equal(a.total,1);const s=await h.create(db,h.settings(sources));
      assert.equal(s.item.kind,kind);assert.equal(s.item.prompt,prompt);assert.equal((await items(db,s.session.session_id)).length,1);
    }
    await h.save(db,{source:'bas',meaning:'运行过程',pos:'noun'});await h.save(db,{source:'write_email',meaning:'运行',pos:'verb'});await h.save(db,{source:'academic_discussion',meaning:'运行',pos:'verb'});
    for(const [sources,kind] of [[['bas'],'meaning_choice'],[['write_email'],'spelling_pos'],[['academic_discussion'],'spelling_pos'],
      [['bas','write_email'],'spelling_pos'],[['bas','academic_discussion'],'spelling_pos'],[['bas','write_email','academic_discussion'],'spelling_pos']]){
      assert.equal((await h.create(db,h.settings(sources,'writing'))).item.kind,kind);
    }
    await h.save(db,{expression:'letter',source:'bas',meaning:'信件',pos:'noun'});
    await h.save(db,{expression:'letter',source:'write_email',meaning:'写信',pos:'verb'});
    const selected=await h.create(db,h.settings(['bas','academic_discussion'],'writing',2));
    assert.equal((await items(db,selected.session.session_id)).find(i=>i.snapshot.expression==='letter').kind,'meaning_choice');
  }finally{await db.close();}
});

engineTest('POS options come from observed canonical values, normalize aliases, remain answer-independent; spelling/POS score separately',async()=>{
  const db=await h.fixture();try{
    await h.pool(db);await h.save(db);
    const pos=(await h.availability(db)).posOptions;
    assert.deepEqual(pos.map(p=>p.id),['noun','verb','adjective','adverb','preposition']);
    assert.ok(!pos.some(p=>p.id==='conjunction'));
    for(const [raw,expected] of [['n.','noun'],['v.','verb'],['adj.','adjective'],['adv.','adverb'],['proper_noun','proper_noun'],['other',null],['invented',null]])
      assert.equal((await query(db,'select wordbook_review_pos($1) p',[raw]))[0].p,expected);
    for(const [spelling,p,sc,pc] of [['  RUN  ','noun',true,false],['rnu','verb',false,true],['Run','verb',true,true]]){
      const s=await h.create(db);assert.deepEqual(s.item.options,pos);
      const serialized=JSON.stringify(s);assert.ok(!serialized.includes('"expression"')&&!serialized.includes('"standardPos"')&&!serialized.includes('"answer"'));
      const a=await h.submit(db,s.session.session_id,s.item.itemId,{spelling,pos:p});
      assert.equal(a.item.answer.assessments.spelling,sc);assert.equal(a.item.answer.assessments.pos,pc);assert.equal(a.item.answer.correct,sc&&pc);
      const again=await h.submit(db,s.session.session_id,s.item.itemId,{spelling:'tamper',pos:'noun'});
      assert.deepEqual(again,a);assert.equal(a.summary.posTotal,1);
    }
    await h.save(db,{expression:'take care',meaning:'照料'});
    assert.equal((await query(db,"select wordbook_review_spelling(E' Take   care\\t') p"))[0].p,'take care');
    const evidenceBefore=await query(db,'select to_jsonb(ev) v from student_wordbook_source_evidence ev order by evidence_id');
    await db.query('update lexical_entries set entry_id=$1 where entry_id=$2',[h.uuid(),h.E]);
    assert.deepEqual(await query(db,'select to_jsonb(ev) v from student_wordbook_source_evidence ev order by evidence_id'),evidenceBefore);
  }finally{await db.close();}
});

engineTest('choice uses canonical real meanings only, excludes all target senses/synonyms/overlap, fixes options and skips insufficient pools',async()=>{
  const db=await h.fixture();try{
    await h.save(db,{source:'rap',meaning:'保持'});
    const first=await h.availability(db,h.settings(['rap']));assert.equal(first.total,0);assert.equal(first.reasons.insufficient_distractors,1);
    await h.pool(db);
    for(const [a,b] of [['保持','维持'],['允许','禁止'],['增加','提升'],['运行','运行过程'],[' 好处； ','好处'],['满意','不满意']])
      assert.equal((await query(db,'select wordbook_review_meaning_conflict($1,$2) c',[a,b]))[0].c,true);
    const s=await h.create(db,h.settings(['rap']));assert.equal(s.item.options.length,4);assert.equal(s.item.options.filter(o=>o.text==='保持').length,1);
    const allPublic=JSON.stringify(s);assert.ok(!allPublic.includes('correctOptionId')&&!allPublic.includes('lexicalEntryId'));
    const meanings=new Set((await query(db,"select v->>'meaning_zh' m from lexical_entries,jsonb_array_elements(common_senses) v")).map(r=>r.m));
    assert.ok(s.item.options.filter(o=>o.text!=='保持').every(o=>meanings.has(o.text)));
    assert.deepEqual((await h.get(db,s.session.session_id)).item.options,s.item.options);
    const answer=s.item.options.find(o=>o.text==='保持').id;
    assert.equal((await h.submit(db,s.session.session_id,s.item.itemId,{optionId:answer})).summary.choiceCorrect,1);
    const other=await h.create(db,h.settings(['rap']));
    await h.submit(db,other.session.session_id,other.item.itemId,{optionId:other.item.options.find(o=>o.text!=='保持').id});
    const retry=await h.create(db,{},h.U,other.session.session_id);
    assert.deepEqual(retry.item.options.map(o=>o.text).sort(),other.item.options.map(o=>o.text).sort());
    assert.ok(retry.item.options.every(o=>!other.item.options.some(previous=>previous.id===o.id)));
    assert.equal((await h.submit(db,retry.session.session_id,retry.item.itemId,{optionId:retry.item.options.find(o=>o.text==='保持').id})).summary.correct,1);
  }finally{await db.close();}
});

engineTest('missing meaning/POS/source fails closed; high difficulty never silently falls back; same spelling different variants stays distinct',async()=>{
  const db=await h.fixture();try{
    await h.pool(db);await h.save(db,{pos:null});await h.save(db,{source:'rap',pos:'noun'});
    assert.equal((await h.availability(db,h.settings(['ctw','rap']))).reasons.missing_reliable_pos,1);
    assert.equal((await h.availability(db,h.settings(['rap']))).total,1);
    await h.save(db,{expression:'second',meaning:'English only'});
    await h.save(db,{expression:'third'});
    await db.query('delete from student_wordbook_source_evidence where wordbook_entry_id=(select wordbook_entry_id from student_wordbook_entries where expression=$1)',['third']);
    const a=await h.availability(db);assert.equal(a.total,0);assert.equal(a.unavailable,3);
    await h.save(db,{expression:'variant',variant:'one'});await h.save(db,{expression:'variant',variant:'two'});
    const s=await h.create(db,h.settings(['ctw'],'reading',2));const rows=await items(db,s.session.session_id);
    assert.equal(new Set(rows.map(r=>r.wordbook_entry_id)).size,2);
    assert.deepEqual(rows.map(r=>r.snapshot.identity.identityVariant).sort(),['one','two']);
  }finally{await db.close();}
});

engineTest('date/range boundaries include both days, dedupe activities, reject future/before-July/cross-domain and excessive random quantities',async()=>{
  const db=await h.fixture();try{
    for(let n=0;n<3;n++)await h.save(db,{expression:`entry${n}`});
    await db.exec('alter table student_wordbook_activities disable trigger student_wordbook_activities_append_guard');
    const ws=await query(db,'select wordbook_entry_id from student_wordbook_entries order by expression');
    await db.query("update student_wordbook_activities set activity_at='2026-07-01T00:00:00Z' where wordbook_entry_id=$1",[ws[0].wordbook_entry_id]);
    await db.query("update student_wordbook_activities set activity_at='2026-07-02T23:59:59Z' where wordbook_entry_id=$1",[ws[1].wordbook_entry_id]);
    await db.query("update student_wordbook_activities set activity_at='2026-07-03T00:00:00Z' where wordbook_entry_id=$1",[ws[2].wordbook_entry_id]);
    await db.query("insert into student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at) values($1,$2,'reading','append','2026-07-01T12:00:00Z')",[ws[0].wordbook_entry_id,h.U]);
    const range={domain:'reading',sources:['ctw'],mode:'range',timeZone:'UTC',start:'2026-07-01',end:'2026-07-02'};
    assert.equal((await h.availability(db,range)).total,2);assert.equal((await h.create(db,range)).session.total,2);
    assert.equal((await h.create(db,{...range,mode:'date',end:range.start})).session.total,1);
    for(const q of [{...range,start:'2026-06-30'},{...range,end:'2099-01-01'},{...range,start:'2026-07-03',end:'2026-07-02'},h.settings(['bas'],'reading')])await assert.rejects(h.create(db,q));
    for(const n of [10,20,50])await assert.rejects(h.create(db,h.settings(['ctw'],'reading',n)),/INSUFFICIENT:3/);
  }finally{await db.close();}
});

engineTest('50-entry daily rotation: 20+20+10 new, lowest-count refill, combinations share history; unfinished/resume do not redraw',async()=>{
  const db=await h.fixture();try{
    for(let n=0;n<50;n++){await h.save(db,{expression:`entry${n}`});await h.save(db,{expression:`entry${n}`,source:'rap'});}
    const seen=new Set();
    for(let round=0;round<4;round++){
      const s=await h.create(db,h.settings(round%2?['ctw','rap']:['ctw'],'reading',20));
      const ids=(await items(db,s.session.session_id)).map(i=>i.wordbook_entry_id);
      assert.equal(new Set(ids).size,20);
      const newCount=ids.filter(id=>!seen.has(id)).length;
      assert.equal(newCount,[20,20,10,0][round]);ids.forEach(id=>seen.add(id));
      const again=await h.get(db,s.session.session_id);assert.equal(again.item.itemId,s.item.itemId);
      assert.equal((await items(db,s.session.session_id)).length,20);
    }
    const ns=(await counts(db)).map(r=>r.n);assert.equal(Math.min(...ns),1);assert.equal(Math.max(...ns),2);
    await h.save(db,{expression:'entry0',user:h.V});assert.equal((await h.create(db,h.settings(),h.V)).session.total,1);
    await h.save(db,{expression:'entry0',source:'write_email'});assert.equal((await h.create(db,h.settings(['write_email'],'writing'))).session.domain,'writing');
    // Simulate a prior day only in the isolated database; retained history isn't deleted.
    await db.exec("alter table student_wordbook_review_sessions disable trigger review_session_guard; update student_wordbook_review_sessions set started_at=started_at-interval '2 days' where domain='reading'; alter table student_wordbook_review_sessions enable trigger review_session_guard;");
    const s=await h.create(db,h.settings(['ctw'],'reading',50));assert.equal(s.session.total,50);
    assert.equal((await h.create(db,h.settings(['ctw'],'reading',10))).session.total,10);
    assert.ok((await query(db,'select count(*)::int n from student_wordbook_review_sessions'))[0].n>4);
  }finally{await db.close();}
});

engineTest('progress/submission/create are idempotent and owner scoped; snapshots survive unfavourite; retry inherits requirements without changing grades',async()=>{
  const db=await h.fixture();try{
    await h.pool(db);const entry=await h.save(db);const request=h.uuid(),s=await h.create(db,h.settings(),h.U,null,request);
    assert.equal((await h.create(db,h.settings(),h.U,null,request)).session.session_id,s.session.session_id);
    await assert.rejects(h.create(db,h.settings(['ctw','rap']),h.U,null,request),/REQUEST_CONFLICT/);
    await assert.rejects(h.get(db,s.session.session_id,h.V),/NOT_FOUND/);
    await assert.rejects(h.submit(db,s.session.session_id,s.item.itemId,{spelling:'run',pos:'verb'},h.V),/NOT_FOUND/);
    await assert.rejects(h.submit(db,s.session.session_id,h.uuid(),{spelling:'run',pos:'verb'}),/NOT_FOUND/);
    await assert.rejects(h.submit(db,s.session.session_id,s.item.itemId,{spelling:'run',pos:'verb',correct:true}),/INVALID_ANSWER/);
    await h.remove(db,[entry.wordbookEntryId]);assert.equal((await h.get(db,s.session.session_id)).item.prompt,'运行');
    const bad=await h.submit(db,s.session.session_id,s.item.itemId,{spelling:'run',pos:'noun'});assert.equal(bad.item.answer.correct,false);
    const retry=await h.create(db,{},h.U,s.session.session_id);assert.equal(retry.session.mode,'retry');assert.equal(retry.session.total,1);
    assert.equal(retry.item.kind,s.item.kind);assert.equal(retry.item.answer,undefined);
    assert.deepEqual((await h.get(db,s.session.session_id)).summary,bad.summary);
    const correct=await h.submit(db,retry.session.session_id,retry.item.itemId,{spelling:'run',pos:'verb'});assert.equal(correct.summary.correct,1);
    assert.deepEqual((await h.get(db,s.session.session_id)).summary,bad.summary);
    assert.equal((await query(db,'select wordbook_review_history($1,1) result',[h.U]))[0].result.total,2);
    assert.equal((await query(db,'select wordbook_review_history($1,1) result',[h.V]))[0].result.total,0);
    assert.equal((await query(db,'select wordbook_review_errors($1,$2,1) result',[h.U,s.session.session_id]))[0].result.items.length,1);
  }finally{await db.close();}
});

engineTest('late session failure is atomic, browser roles cannot access private tables/functions, and immutable snapshots reject edits',async()=>{
  const db=await h.fixture();try{
    await h.pool(db);await h.save(db);
    await db.exec(`create function fail_review_test() returns trigger language plpgsql as $$ begin raise exception 'OFFLINE_FAILURE'; end; $$;
      create trigger fail_review_test before insert on student_wordbook_review_items for each row execute function fail_review_test();`);
    await assert.rejects(h.create(db),/OFFLINE_FAILURE/);
    assert.equal((await query(db,'select count(*)::int n from student_wordbook_review_sessions'))[0].n,0);
    await db.exec('drop trigger fail_review_test on student_wordbook_review_items');const s=await h.create(db);
    for(const role of ['anon','authenticated']){
      await db.exec(`set role ${role}`);
      for(const table of ['source_evidence','review_sessions','review_items','review_answers'])await assert.rejects(db.exec(`select * from student_wordbook_${table}`),/permission denied/i);
      await assert.rejects(h.get(db,s.session.session_id),/permission denied/i);await assert.rejects(h.create(db),/permission denied/i);await db.exec('reset role');
    }
    await assert.rejects(db.exec('update student_wordbook_review_items set snapshot=\'{}\''),/IMMUTABLE/);
    await assert.rejects(db.exec('update student_wordbook_review_sessions set settings=\'{}\''),/IMMUTABLE/);
    await h.submit(db,s.session.session_id,s.item.itemId,{spelling:'run',pos:'verb'});
    await assert.rejects(db.exec('update student_wordbook_review_answers set item_correct=false'),/IMMUTABLE/);
    await db.exec('set role service_role');assert.equal((await h.get(db,s.session.session_id)).summary.correct,1);await db.exec('reset role');
    await db.query('update profiles set is_active=false where id=$1',[h.U]);
    await assert.rejects(h.get(db,s.session.session_id),/STUDENT_REQUIRED/);await assert.rejects(h.create(db,{},h.U,s.session.session_id),/STUDENT_REQUIRED/);
  }finally{await db.close();}
});

engineTest('spelling prompts cannot leak English/POS answers; future items cannot be read or submitted before current item is answered',async()=>{
  const db=await h.fixture();try{
    await h.pool(db);await h.save(db,{expression:'maintain',meaning:'保持（maintain）'});
    await h.save(db,{expression:'otherword',meaning:'形容词：满意的',pos:'adjective'});
    assert.equal((await h.availability(db)).reasons.answer_in_prompt,2);
    await h.save(db,{expression:'first',meaning:'第一个'});await h.save(db,{expression:'second',meaning:'第二个'});
    const s=await h.create(db,h.settings(['ctw'],'reading',2)),rows=await items(db,s.session.session_id);
    await assert.rejects(h.get(db,s.session.session_id,h.U,2),/INVALID_POSITION/);
    await assert.rejects(h.submit(db,s.session.session_id,rows[1].item_id,{spelling:rows[1].snapshot.expression,pos:'verb'}),/INVALID_POSITION/);
    await h.submit(db,s.session.session_id,rows[0].item_id,{spelling:rows[0].snapshot.expression,pos:'verb'});
    assert.equal((await h.get(db,s.session.session_id)).item.itemId,rows[1].item_id);
  }finally{await db.close();}
});

test('real review handlers authenticate before database access, whitelist all actions, and reject client identities/scoring',async()=>{
  const ts=require('typescript');
  for(const file of ['app/api/student/wordbook/review/route.ts','app/api/student/wordbook/review/[sessionId]/route.ts']){
    let authorized=false,calls=[];const exports={};
    vm.runInNewContext(ts.transpileModule(h.read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL,Request,require(name){
      if(name.includes('attemptServer'))return{requireReadingAttemptStudent:async()=>authorized?{userId:h.U}:{error:{status:401}},readingAttemptJson:(body,init)=>({body,status:init?.status??200})};
      if(name.includes('supabase/server'))return{createServiceSupabase:()=>({rpc:async(name,args)=>{calls.push({name,args});return{data:{ok:true}};}})};
      if(name.endsWith('wordbookReview.server'))return{reviewRpc};
      if(name.endsWith('wordbookReview'))return require('../lib/lexical/wordbookReview.ts');throw Error(name);
    }});
    const context={params:{sessionId:h.uuid()}},url='https://offline.invalid/review';
    assert.equal((await exports.GET(new Request(url),context)).status,401);assert.equal(calls.length,0);authorized=true;
    assert.equal((await exports.GET(new Request(url+'?student_id='+h.V),context)).status,400);
    const body=file.includes('[sessionId]')?{action:'answer',itemId:h.uuid(),answer:{spelling:'run',pos:'verb'}}:{settings:h.settings(),requestId:h.uuid()};
    assert.equal((await exports.POST(new Request(url,{method:'POST',body:JSON.stringify({...body,student_id:h.V})}),context)).status,400);
    assert.equal(calls.length,0);
    assert.equal((await exports.POST(new Request(url,{method:'POST',body:JSON.stringify(body)}),context)).status,200);
    assert.equal(calls[0].args.p_student,h.U);
  }
});
