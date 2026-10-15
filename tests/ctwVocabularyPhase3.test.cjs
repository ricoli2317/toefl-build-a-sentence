const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { fixture, client, source, U, V, X, read } = require('./helpers/ctwVocabularyFixture.cjs');
const store = require('../lib/ctw-vocabulary/store.server.ts');
const input = require('../lib/ctw-vocabulary/input.ts');
const round = require('../lib/ctw-vocabulary/round.ts');
const { insertReviewSpelling, constrainReviewSpelling } = require('../lib/lexical/wordbookReviewInput.ts');
const install = () => read('outputs/ctw-vocabulary-phase3/ctw-vocabulary-phase3-install.sql');
const startFix = () => read('supabase/ctw_vocabulary_phase3_start_owner_fix.sql');
async function dbFixture() { const db=await fixture(); try { await db.exec(install()); await db.exec(startFix()); return db; } catch(e) { await db.close(); throw e; } }
const base = {kind:'list',listNumber:1};
function submission(entries, source, wrong = false, id = randomUUID()) {
  return input.parseAttemptSubmission({attemptId:id,mode:'base_form',source,answers:entries.map((entry,i)=>({
    entryId:entry.entry_id,spelling:wrong&&i===0?'wrong':entry.word,
    irregularSpellings:entry.irregular_forms.map(form=>({formType:form.form_type,spelling:form.answers.at(-1)}))
  }))});
}

test('incremental install keeps every Phase2 word/ID/content/order and history byte-for-byte; 21 mixed + 23 CEFR Lists', async()=>{
  const db=await fixture();try {
    const before=(await db.query('select * from ctw_vocabulary_entries order by list_number,list_position')).rows;
    await store.saveVocabularyAttempt(client(db,'service_role'),U,input.parseAttemptSubmission({attemptId:randomUUID(),mode:'base_form',
      answers:[{entryId:before[0].entry_id,spelling:before[0].word}]}));
    const historyBefore=(await db.query('select * from student_ctw_vocabulary_attempts')).rows;
    await db.exec(install());
    await db.exec(startFix());
    await db.exec(read('supabase/ctw_vocabulary_phase3_verify.sql'));
    assert.deepEqual((await db.query('select * from ctw_vocabulary_entries order by list_number,list_position')).rows,before);
    assert.deepEqual((await db.query('select * from student_ctw_vocabulary_attempts')).rows,historyBefore);
    const c=client(db,'authenticated',U), mixed=await store.readVocabularyLists(c,'mixed'), cefr=await store.readVocabularyLists(c,'cefr');
    assert.equal(mixed.lists.length,21);assert.equal(mixed.lists.at(-1).count,32);assert.equal(cefr.lists.length,23);
    assert.deepEqual(Object.fromEntries(['A1','A2','B1','B2','C1-C2'].map(g=>[g,cefr.lists.filter(l=>l.group===g).map(l=>l.count)])),
      {A1:[50,50,50,50,42],A2:[50,50,50,34],B1:[50,50,50,3],B2:[50,50,50,50,50,50,5],'C1-C2':[50,50,48]});
    assert.ok([...mixed.lists,...cefr.lists].every(l=>l.count<=50&&l.count>0&&l.status==='not_started'&&l.bestAccuracy===null));
    assert.equal(JSON.stringify(cefr).includes('senses'),false);assert.equal(JSON.stringify(cefr).includes('entry_id'),false);
    const coverage=(await db.query('select count(*)::int n,count(distinct entry_id)::int unique_n from ctw_vocabulary_cefr_memberships')).rows[0];
    assert.deepEqual(coverage,{n:1032,unique_n:1032});
    await assert.rejects(db.exec(install()),/already exists/); await db.exec('rollback');
  }finally{await db.close();}
});
test('real profiles.owner_id reproduces the start ambiguity; guarded hotfix alone fixes both editions without changing data or ACLs',async()=>{
  const db=await fixture();try{
    await db.exec(install());
    const before=(await db.query(`select p.oid,p.proacl,p.proowner,p.prosecdef,p.proconfig from pg_proc p
      where p.oid='public.start_ctw_vocabulary_list_v1(text,text,integer)'::regprocedure`)).rows;
    const content=(await db.query('select * from ctw_vocabulary_entries order by entry_id')).rows;
    const membership=(await db.query('select * from ctw_vocabulary_cefr_memberships order by entry_id')).rows;
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[U]);await db.exec('set role authenticated');
    await assert.rejects(db.query("select public.start_ctw_vocabulary_list_v1('mixed','',21)"),/owner_id.*ambiguous/);
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_list_progress')).rows[0].n,0);
    await assert.rejects(db.exec(read('supabase/ctw_vocabulary_phase3_verify.sql')),/START_OWNER_FIX_REQUIRED/);await db.exec('rollback');
    await db.exec(startFix());await db.exec(startFix());
    assert.deepEqual((await db.query(`select p.oid,p.proacl,p.proowner,p.prosecdef,p.proconfig from pg_proc p
      where p.oid='public.start_ctw_vocabulary_list_v1(text,text,integer)'::regprocedure`)).rows,before);
    assert.deepEqual((await db.query('select * from ctw_vocabulary_entries order by entry_id')).rows,content);
    assert.deepEqual((await db.query('select * from ctw_vocabulary_cefr_memberships order by entry_id')).rows,membership);
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_list_progress')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,0);
    const c=client(db,'authenticated',U);
    assert.equal((await store.startVocabularyList(c,{kind:'list',listNumber:21})).items.length,32);
    assert.equal((await store.startVocabularyList(c,{kind:'cefr_list',group:'B1',listNumber:4})).items.length,3);
    await db.exec(read('supabase/ctw_vocabulary_phase3_verify.sql'));
    for(const user of [V,X]){
      const other=client(db,'authenticated',user);
      if(user===X)await assert.rejects(store.startVocabularyList(other,base));
      else assert.ok((await store.readVocabularyLists(other,'mixed')).lists.every(l=>l.status==='not_started'));
    }
  }finally{await db.close();}
});
test('start hotfix refuses an unknown function body and rolls back without changing unrelated schema/data',async()=>{
  const db=await fixture();try{
    await db.exec(install());
    await db.exec(`comment on function public.start_ctw_vocabulary_list_v1(text,text,integer) is 'must survive';
      create or replace function public.start_ctw_vocabulary_list_v1(p_edition text,p_group text,p_list integer)
      returns jsonb language plpgsql security definer set search_path='' as $$begin return '{}'::jsonb; end$$;`);
    const before=(await db.query("select pg_get_functiondef('public.start_ctw_vocabulary_list_v1(text,text,integer)'::regprocedure) body")).rows;
    await assert.rejects(db.exec(startFix()),/START_FUNCTION_DRIFT/);await db.exec('rollback');
    assert.deepEqual((await db.query("select pg_get_functiondef('public.start_ctw_vocabulary_list_v1(text,text,integer)'::regprocedure) body")).rows,before);
  }finally{await db.close();}
});
test('CEFR append fills the entire tail then creates only the next List, preserves C1/C2 shared identity and mixed tail rollover',async()=>{
  const db=await dbFixture();try{
    const {buildVocabularyImportSql}=require('../lib/ctw-vocabulary/import.ts');
    const before=(await db.query('select * from ctw_vocabulary_cefr_memberships order by entry_id')).rows;
    const rows=Array.from({length:20},(_,i)=>({word:`future${String.fromCharCode(97+i)}`,list_id:'List 01',cefr:i%2?'C1':'C2',
      senses:[{pos:'noun',meaning_zh:'增量验收',example_en:'This is an isolated fixture.'}],irregular_forms:[]}));
    await db.exec(buildVocabularyImportSql(rows,'b'.repeat(64),'append'));
    assert.deepEqual((await db.query('select * from ctw_vocabulary_cefr_memberships where entry_id=any($1::uuid[]) order by entry_id',[before.map(m=>m.entry_id)])).rows,before);
    const appended=(await db.query(`select m.list_number,m.list_position,e.list_number mixed_number,e.list_position mixed_position
      from ctw_vocabulary_cefr_memberships m join ctw_vocabulary_entries e using(entry_id) where e.word=any($1::text[]) order by e.word`,[rows.map(r=>r.word)])).rows;
    assert.deepEqual(appended.map(r=>[r.list_number,r.list_position]),[[3,49],[3,50],...Array.from({length:18},(_,i)=>[4,i+1])]);
    assert.deepEqual(appended.map(r=>[r.mixed_number,r.mixed_position]),[...Array.from({length:18},(_,i)=>[21,i+33]),[22,1],[22,2]]);
    await db.exec(read('supabase/ctw_vocabulary_phase3_verify.sql'));
  }finally{await db.close();}
});
test('List source/input allowlists reject owner, score, mixed groups, duplicate forms, unknown type, and removed random query',()=>{
  const id=randomUUID(), entryId=randomUUID();
  for(const source of [{kind:'list',listNumber:0},{kind:'cefr_list',group:'C2',listNumber:1},{kind:'cefr_list',group:'B1',listNumber:1,studentId:U},
    {kind:'cefr',levels:['B2']},{kind:'list',listNumber:1,bestAccuracy:100}])assert.throws(()=>input.parseListSource(source));
  for(const q of ['edition=bad','edition=cefr&edition=mixed','edition=cefr&count=10','student_id=x'])assert.throws(()=>input.parseListEdition(new URLSearchParams(q)));
  const raw={attemptId:id,mode:'base_form',source:base,answers:[{entryId,spelling:'get',irregularSpellings:[{formType:'past',spelling:'got'}]}]};
  assert.throws(()=>input.parseAttemptSubmission({...raw,answers:[{...raw.answers[0],irregularSpellings:[...raw.answers[0].irregularSpellings,...raw.answers[0].irregularSpellings]}]}));
  assert.throws(()=>input.parseAttemptSubmission({...raw,answers:[{entryId,spelling:'get'}]}));
  assert.throws(()=>input.parseAttemptSubmission({...raw,correct_count:1}));
});
test('actual List routes authenticate before queries or start mutations and never accept student identity/score or random settings',async()=>{
  const vm=require('node:vm'),ts=require('typescript');let allowed=false,calls=[];
  const deps={
    'http.server':{vocabularyRoute:async(req,work)=>{
      if(!allowed)return{status:401};try{return{status:200,data:await work({scoped:true},U)};}catch{return{status:400};}
    }},'input':input,'store.server':{
      readVocabularyLists:async(c,e)=>{calls.push(['read',e]);return{lists:[]};},
      startVocabularyList:async(c,s)=>{calls.push(['start',s]);return{items:[]};}
    }
  };
  const load=file=>{const exported={};vm.runInNewContext(ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,
    {exports:exported,URL,Request,JSON,Error,require:name=>deps[Object.keys(deps).find(k=>name.endsWith(k))]});return exported;};
  const lists=load('app/api/student/ctw-vocabulary/lists/route.ts'),start=load('app/api/student/ctw-vocabulary/lists/start/route.ts');
  const req=(query='',body)=>new Request('https://offline.invalid/api'+query,body===undefined?undefined:{method:'POST',body:JSON.stringify(body)});
  assert.equal((await lists.GET(req('?edition=cefr'))).status,401);assert.equal((await start.POST(req('',base))).status,401);assert.equal(calls.length,0);
  allowed=true;
  assert.equal((await lists.GET(req('?edition=cefr'))).status,200);
  for(const query of ['?student_id=x','?edition=cefr&count=10','?edition=cefr&edition=mixed'])assert.equal((await lists.GET(req(query))).status,400);
  for(const body of [{...base,student_id:V},{...base,correctCount:50},{kind:'cefr',levels:['B2']},{kind:'cefr_list',group:'C2',listNumber:1}])assert.equal((await start.POST(req('',body))).status,400);
  assert.equal((await start.POST(req('',{kind:'cefr_list',group:'C1-C2',listNumber:3}))).status,200);
  assert.deepEqual(calls,[['read','cefr'],['start',{kind:'cefr_list',group:'C1-C2',listNumber:3}]]);
});
test('CEFR initial mapping preserves original balancing: dispersed function words and all eight themes where capacity allows',()=>{
  const audit=JSON.parse(read('outputs/ctw-vocabulary-phase3/cefr-balancing-audit.json'));
  for(const g of ['A1','A2','B1','B2','C1-C2']){
    const lists=audit.filter(l=>l.group===g), counts=lists.map(l=>l.function_count);
    assert.ok(Math.max(...counts)-Math.min(...counts)<=1,g);
    assert.ok(lists.filter(l=>l.count>=34).every(l=>l.topic_coverage.length===8),g);
  }
  assert.equal(audit.find(l=>l.group==='B1'&&l.count===3).topic_coverage.length,4);
});
test('start is self-scoped, immediately in progress without a score, idempotent; editions and students independent',async()=>{
  const db=await dbFixture();try{
    const c=client(db,'authenticated',U), entries=(await store.startVocabularyList(c,base)).items;
    assert.equal(entries.length,50);assert.deepEqual(entries.map(e=>e.list_position),Array.from({length:50},(_,i)=>i+1));
    const first=(await db.query('select * from student_ctw_vocabulary_list_progress')).rows;
    await store.startVocabularyList(c,base);assert.deepEqual((await db.query('select * from student_ctw_vocabulary_list_progress')).rows,first);
    assert.equal((await store.readVocabularyLists(c,'mixed')).lists[0].status,'in_progress');
    assert.equal((await store.readVocabularyLists(c,'mixed')).lists[0].bestAccuracy,null);
    assert.equal((await store.readVocabularyLists(c,'cefr')).lists[0].status,'not_started');
    assert.equal((await store.readVocabularyLists(client(db,'authenticated',V),'mixed')).lists[0].status,'not_started');
    await assert.rejects(store.startVocabularyList(client(db,'authenticated',X),base));
    await assert.rejects(store.startVocabularyList(client(db,'anon',U),base));
  }finally{await db.close();}
});
test('full combined spelling grades by entry, stores all form details, completes List atomically and never lowers historical best',async()=>{
  const db=await dbFixture();try{
    const c=client(db,'authenticated',U), entries=(await store.startVocabularyList(c,base)).items;
    const service=client(db,'service_role',U), raw=submission(entries,base);
    const result=await store.saveVocabularyAttempt(service,U,raw);
    assert.equal(result.answer_count,50);assert.equal(result.correct_count,50);
    assert.ok(result.answers.some(a=>a.irregularResults?.length));
    assert.equal((await store.readVocabularyLists(c,'mixed')).lists[0].status,'completed');
    assert.equal((await store.readVocabularyLists(c,'mixed')).lists[0].bestAccuracy,100);
    assert.deepEqual(await store.saveVocabularyAttempt(service,U,raw),result);
    assert.equal((await store.saveVocabularyAttempt(service,U,submission(entries,base,true))).correct_count,49);
    assert.equal((await store.readVocabularyLists(c,'mixed')).lists[0].bestAccuracy,100);
    assert.equal((await store.readVocabularyLists(c,'mixed')).lists[0].status,'completed');
    assert.equal((await store.readVocabularyLists(c,'cefr')).lists[0].bestAccuracy,null);
  }finally{await db.close();}
});
test('one wrong irregular spelling makes the entire word wrong, missing/extra required form groups rejected before INSERT',async()=>{
  const db=await dbFixture();try{
    const entries=(await store.startVocabularyList(client(db,'authenticated',U),base)).items;
    const raw=submission(entries,base), target=raw.answers.find(a=>a.irregularSpellings.length);
    target.irregularSpellings[0].spelling='wrong';
    const result=await store.saveVocabularyAttempt(client(db,'service_role',U),U,raw);
    const answer=result.answers.find(a=>a.entryId===target.entryId);
    assert.equal(answer.baseCorrect,true);assert.equal(answer.correct,false);assert.equal(result.correct_count,49);
    assert.equal((await store.readVocabularyLists(client(db,'authenticated',U),'mixed')).lists[0].bestAccuracy,98);
    const bad=submission(entries,base);bad.answers.find(a=>a.irregularSpellings.length).irregularSpellings=[];
    await assert.rejects(store.saveVocabularyAttempt(client(db,'service_role'),U,bad),/INVALID_FORM/);
  }finally{await db.close();}
});
test('CEFR small Lists (3 and 5 words), stable order, full results, separate status and highest score work identically',async()=>{
  const db=await dbFixture();try{
    for(const [group,listNumber,count] of [['B1',4,3],['B2',7,5]]){
      const source={kind:'cefr_list',group,listNumber}, c=client(db,'authenticated',U);
      const entries=(await store.startVocabularyList(c,source)).items;assert.equal(entries.length,count);
      const result=await store.saveVocabularyAttempt(client(db,'service_role'),U,submission(entries,source));
      assert.equal(result.correct_count,count);assert.equal(result.answers[0].source.group,group);
      assert.equal((await store.readVocabularyLists(c,'cefr')).lists.find(l=>l.group===group&&l.listNumber===listNumber).status,'completed');
      assert.equal(round.sourceReturnHref(result.answers[0].source),'/student/ctw-vocabulary?tab=cefr');
    }
  }finally{await db.close();}
});
test('append fills CEFR tail only, keeps all previous memberships/order, invalidates completion but retains 100% best',async()=>{
  const db=await dbFixture();try{
    const src={kind:'cefr_list',group:'B1',listNumber:4}, c=client(db,'authenticated',U);
    const entries=(await store.startVocabularyList(c,src)).items;
    await store.saveVocabularyAttempt(client(db,'service_role'),U,submission(entries,src));
    const before=(await db.query('select * from ctw_vocabulary_cefr_memberships order by entry_id')).rows;
    const old=(await db.query('select * from ctw_vocabulary_entries limit 1')).rows[0];
    await db.query(`insert into ctw_vocabulary_entries(word,list_number,list_position,cefr,senses,irregular_forms,source_sha256)
      values('futureword',21,33,'B1',$1::jsonb,'[]',$2)`,[JSON.stringify(old.senses),old.source_sha256]);
    assert.deepEqual((await db.query('select * from ctw_vocabulary_cefr_memberships where entry_id=any($1::uuid[]) order by entry_id',[before.map(m=>m.entry_id)])).rows,before);
    const card=(await store.readVocabularyLists(c,'cefr')).lists.find(l=>l.group==='B1'&&l.listNumber===4);
    assert.equal(card.count,4);assert.equal(card.status,'in_progress');assert.equal(card.bestAccuracy,100);
    const updated=(await store.startVocabularyList(c,src)).items;
    await store.saveVocabularyAttempt(client(db,'service_role'),U,submission(updated,src));
    assert.equal((await store.readVocabularyLists(c,'cefr')).lists.find(l=>l.group==='B1'&&l.listNumber===4).status,'completed');
  }finally{await db.close();}
});
test('late insert failure rolls back attempt and progress; old partial snapshot cannot complete a grown List',async()=>{
  const db=await dbFixture();try{
    const src={kind:'cefr_list',group:'B1',listNumber:4}, c=client(db,'authenticated',U);
    const entries=(await store.startVocabularyList(c,src)).items;
    await db.exec(`create function public.fail_progress() returns trigger language plpgsql as $$ begin raise exception 'test rollback'; end $$;
      create trigger fail_progress before update on student_ctw_vocabulary_list_progress for each row execute function fail_progress();`);
    const raw=submission(entries,src);
    await assert.rejects(store.saveVocabularyAttempt(client(db,'service_role'),U,raw),/DATABASE/);
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,0);
    await db.exec('drop trigger fail_progress on student_ctw_vocabulary_list_progress');
    const old=(await db.query('select * from ctw_vocabulary_entries limit 1')).rows[0];
    await db.query(`insert into ctw_vocabulary_entries(word,list_number,list_position,cefr,senses,irregular_forms,source_sha256)
      values('lateword',21,33,'B1',$1::jsonb,'[]',$2)`,[JSON.stringify(old.senses),old.source_sha256]);
    await store.saveVocabularyAttempt(client(db,'service_role'),U,raw);
    const card=(await store.readVocabularyLists(c,'cefr')).lists.find(l=>l.group==='B1'&&l.listNumber===4);
    assert.equal(card.status,'in_progress');assert.equal(card.bestAccuracy,null);
  }finally{await db.close();}
});
test('browser cannot write memberships/progress or execute private triggers; self-only progress RLS',async()=>{
  const db=await dbFixture();try{
    await store.startVocabularyList(client(db,'authenticated',U),base);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[V]);await db.exec('set role authenticated');
    assert.equal((await db.query('select * from student_ctw_vocabulary_list_progress')).rows.length,0);
    for(const sql of ['delete from ctw_vocabulary_cefr_memberships','update student_ctw_vocabulary_list_progress set best_accuracy=100',
      'select ctw_vocab_private.record_list_result()']) await assert.rejects(db.exec(sql),/permission denied/);
    await db.exec('reset role');
  }finally{await db.close();}
});
test('input shapes allow every accepted alternative length, phrases, hyphens and independent people without changing input rules',()=>{
  for(const entry of source().rows){
    for(const answers of [[entry.word],...entry.irregular_forms.map(f=>f.answers)]){
      const shape=round.vocabularySpellingShape(answers);
      for(const word of answers){
        assert.equal(insertReviewSpelling(shape,'',0,0,word).value,word);
        assert.equal(constrainReviewSpelling(shape,'',word).value,word);
      }
    }
  }
  for(const word of ['per capita','long-term','people']) assert.ok(source().rows.some(e=>e.word===word));
});
test('old v1 pending batches remain readable for one-way migration; bad storage/owner never silently replace state',()=>{
  const entry={entry_id:randomUUID(),word:'get',list_number:1,list_position:1,cefr:'A1',senses:[],irregular_forms:[{form_type:'past',answers:['got']}],source_sha256:'a'.repeat(64)};
  const data=new Map(),storage={setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k)??null},id=randomUUID();
  const local={version:1,owner:U,attemptId:id,source:base,entries:[entry],phase:'study',index:0,answers:[],
    draft:{entryId:entry.entry_id,spelling:'',irregularSpellings:[{formType:'past',spelling:''}]}};
  storage.setItem(round.roundKey(U,id),JSON.stringify(local));
  assert.deepEqual(round.readVocabularyRound(storage,U,id),local);assert.equal(round.readVocabularyRound(storage,V,id),null);
  local.phase='saving';local.answers=[{entryId:entry.entry_id,spelling:'get',irregularSpellings:[{formType:'past',spelling:'got'}]}];
  storage.setItem(round.roundKey(U,id),JSON.stringify(local));assert.equal(round.readVocabularyRound(storage,U,id).answers[0].spelling,'get');
  data.set(round.roundKey(U,id),'bad');assert.throws(()=>round.readVocabularyRound(storage,U,id));
});
test('UI uses the exact shared assignment badge and native spelling component; no independent setting/sample route remains',()=>{
  const ui=read('components/student/CtwVocabulary.tsx'), workspace=read('components/student/CtwVocabularyWorkspace.tsx');
  assert.match(ui,/<AssignmentStatusBadge/);assert.match(ui,/label=\{list.status === "not_started" \? "未开始"/);
  assert.doesNotMatch(ui,/CtwVocabularySetup|开始测试<|\/sample/);
  assert.equal(fs.existsSync('app/student/ctw-vocabulary/test/page.tsx'),false);
  assert.match(workspace,/<WordbookReviewWorkspace/);assert.match(workspace,/useCtwReview/);
  const shared=read('components/student/WordbookReviewWorkspace.tsx');assert.match(shared,/<LetterSpelling/);assert.match(shared,/<ReviewProgress/);assert.match(shared,/useReviewViewport/);
  assert.doesNotMatch(workspace,/radiogroup|<Options|item\.example/);
  const badge=read('components/assignments/AssignmentPresentation.tsx');assert.match(badge,/label \?\? progress.label/);
  assert.equal(round.POS_LABELS.verb,'v.');assert.equal(round.POS_LABELS.preposition,'prep.');
  assert.doesNotMatch(ui+workspace,/Base form/);
  assert.match(read('lib/ctw-vocabulary/review.ts'),/groups.length \? \{ label: "原形" \} : \{\}/);
});
