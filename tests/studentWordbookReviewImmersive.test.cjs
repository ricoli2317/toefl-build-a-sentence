const test=require('node:test'),assert=require('node:assert/strict');
const h=require('./helpers/wordbookFixedPoolFixture.cjs');
const {presentReviewState,reviewExample,spellingShape}=require('../lib/lexical/wordbookReviewPresentation.ts');
const sql='supabase/student_wordbook_review_v1_immersive_migration.sql';
const flow=async(db,s,action='read',item=null,answer=null,user=h.U)=>
  (await db.query('select wordbook_review_flow_state($1,$2,$3,$4,$5::jsonb) result',[user,s,action,item,answer===null?null:JSON.stringify(answer)])).rows[0].result;

test('examples preserve exact source text, word boundaries, all repeated targets and a single continuous spelling blank',()=>{
  assert.deepEqual(reviewExample('Run, then RUN daily.','run',false),[{text:'Run',target:true},{text:', then '},{text:'RUN',target:true},{text:' daily.'}]);
  assert.deepEqual(reviewExample('We take   care daily.','take care',true),[{text:'We '},{text:'',target:true},{text:' daily.'}]);
  assert.equal(reviewExample('The runner runs.','run',true),null);
  assert.equal(spellingShape('take care-of'), '____ ____-__');
  const raw={flow:{phase:'test'},item:{kind:'spelling_pos'},presentation:{expression:'run',meaning:'运行',pos:'verb',examples:[{kind:'sentence',text:'We run daily.'}]}};
  const projected=presentReviewState(raw);
  assert.equal(projected.item.spellingShape,'___');assert.equal(projected.presentation,undefined);
  assert.doesNotMatch(JSON.stringify(projected),/We run|"expression"|"meaning"|"pos"/);
  assert.equal(presentReviewState({...raw,flow:{phase:'study'}}).item.study.expression,'run');
  assert.equal(presentReviewState({...raw,presentation:{...raw.presentation,examples:[]}}).item.example,null);
});

test('immersive SQL preserves candidate/POS/pool/grading, saves source-exact study and feedback cursor, accepts blanks and keeps immutable history',
  {skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},async()=>{
  const db=await h.fixture();try{
    await db.exec(h.read('supabase/student_wordbook_review_v1_choice_preference_migration.sql'));
    const protectedBefore=(await db.query(`select proname,prosrc from pg_proc where proname in
      ('wordbook_review_candidates','wordbook_review_pos','wordbook_review_spelling','wordbook_review_public_item','wordbook_review_create') order by proname`)).rows;
    const submitBefore=(await db.query("select prosrc from pg_proc where oid='wordbook_review_submit(uuid,uuid,uuid,jsonb)'::regprocedure")).rows[0].prosrc;
    await db.exec(h.read(sql));
    await db.exec(h.read('supabase/student_wordbook_review_v1_immersive_verify.sql'));
    assert.deepEqual((await db.query(`select proname,prosrc from pg_proc where proname in
      ('wordbook_review_candidates','wordbook_review_pos','wordbook_review_spelling','wordbook_review_public_item','wordbook_review_create') order by proname`)).rows,protectedBefore);
    const submitAfter=(await db.query("select prosrc from pg_proc where oid='wordbook_review_submit(uuid,uuid,uuid,jsonb)'::regprocedure")).rows[0].prosrc;
    assert.equal(submitAfter.slice(submitAfter.indexOf('    sc:=')),submitBefore.slice(submitBefore.indexOf('    sc:='))
      .replace("or not exists(select 1 from jsonb_array_elements(i.snapshot->'options') o where o->>'id'=p_answer->>'optionId')",
      "or (p_answer->>'optionId'<>'' and not exists(select 1 from jsonb_array_elements(i.snapshot->'options') o where o->>'id'=p_answer->>'optionId'))"));
    await h.pool(db);
    await h.save(db,{expression:'run',pos:'verb',meaning:'运行'});
    await h.save(db,{expression:'oceanic',source:'rap',pos:'noun',meaning:'深海领域'});
    const s=await h.create(db,h.settings(['ctw','rap'],'reading',2)),id=s.session.session_id;
    const snapshots=(await db.query('select snapshot from student_wordbook_review_items where session_id=$1 order by position',[id])).rows;
    await db.exec('set role service_role');let r=await flow(db,id);await db.exec('reset role');
    assert.equal(r.flow.phase,'study');assert.equal(r.session.answered,0);
    await assert.rejects(flow(db,id,'answer',r.item.itemId,{spelling:'run',pos:'verb'}),/INVALID_ACTION/);
    const first=r.item.itemId;
    r=await flow(db,id,'study_next',first);assert.equal(r.flow.position,2);
    assert.deepEqual(await flow(db,id,'study_next',first),r); // stale request cannot skip
    r=await flow(db,id,'repeat',r.item.itemId);assert.equal(r.item.itemId,first);
    assert.equal(r.session.answered,0);assert.equal(r.summary.correct,0);
    await assert.rejects(flow(db,id,'read',null,null,h.V),/NOT_FOUND/);
    await h.remove(db,(await db.query('select wordbook_entry_id from student_wordbook_entries where student_id=$1',[h.U])).rows.map(x=>x.wordbook_entry_id));
    assert.ok(r.presentation.examples.length); // saved before deletion; flow retains it
    assert.deepEqual((await flow(db,id)).presentation,r.presentation);
    r=await flow(db,id,'start_test',r.item.itemId);assert.equal(r.flow.phase,'test');
    assert.equal(r.item.itemId,first);
    for(let n=0;n<2;n++){
      const item=r.item;
      await assert.rejects(flow(db,id,'advance',item.itemId),/INVALID_POSITION/);
      const invalid=item.kind==='spelling_pos'?{spelling:'',pos:'not-a-pos'}:{optionId:'not-an-option'};
      await assert.rejects(flow(db,id,'answer',item.itemId,invalid),/INVALID_ANSWER/);
      const blank=item.kind==='spelling_pos'?{spelling:'',pos:''}:{optionId:''};
      r=await flow(db,id,'answer',item.itemId,blank);
      assert.equal(r.item.answer.correct,false);assert.equal(r.flow.phase,'test');
      assert.deepEqual(await flow(db,id),r); // wrong feedback persists on refresh, even final answer
      assert.deepEqual(await flow(db,id,'answer',item.itemId,blank),r);
      r=await flow(db,id,'advance',item.itemId);
      assert.deepEqual(await flow(db,id,'advance',item.itemId),r); // duplicate advance
    }
    assert.equal(r.flow.phase,'result');assert.equal(r.summary.incorrect,2);assert.equal(r.session.answered,2);
    assert.deepEqual((await db.query('select snapshot from student_wordbook_review_items where session_id=$1 order by position',[id])).rows,snapshots);
    const retry=await h.create(db,{},h.U,id),retryId=retry.session.session_id;
    r=await flow(db,retryId);assert.equal(r.flow.phase,'study');assert.equal(r.session.total,2);
    assert.ok(r.presentation.examples.length); // retry retains parent source example after unfavourite
    r=await flow(db,retryId,'start_test',r.item.itemId);
    for(let n=0;n<2;n++){
      const privateItem=(await db.query('select snapshot from student_wordbook_review_items where item_id=$1',[r.item.itemId])).rows[0].snapshot;
      const correct=r.item.kind==='spelling_pos'?{spelling:privateItem.expression.toUpperCase(),pos:privateItem.pos}:{optionId:privateItem.correctOptionId};
      r=await flow(db,retryId,'answer',r.item.itemId,correct);assert.equal(r.item.answer.correct,true);
      assert.deepEqual(await flow(db,retryId),r); // automatic UI advance uses this same cursor
      r=await flow(db,retryId,'advance',r.item.itemId);
    }
    assert.equal(r.flow.phase,'result');assert.equal(r.summary.correct,2);
    assert.equal((await flow(db,id)).summary.incorrect,2);
    for(const role of ['anon','authenticated']){
      await db.exec(`set role ${role}`);
      await assert.rejects(flow(db,id),/permission denied/);
      await assert.rejects(db.exec('select * from student_wordbook_review_flow'),/permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');assert.equal((await flow(db,id)).flow.phase,'result');await db.exec('reset role');
  }finally{await db.close();}
});

test('incremental SQL rejects baseline drift and duplicate installation; a late failure rolls back submit, audit and new schema',
  {skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},async()=>{
  const db=await h.fixture();try{
    const original=(await db.query("select pg_get_functiondef('public.wordbook_review_submit(uuid,uuid,uuid,jsonb)'::regprocedure) definition")).rows[0].definition;
    const audit=(await db.query("select function_hashes from student_wordbook_review_installation where version='v1'")).rows[0].function_hashes;
    await db.exec(original.replace('begin\n','begin\n-- isolated drift\n'));
    await assert.rejects(db.exec(h.read(sql)),/BASELINE_DRIFT/);await db.exec('rollback');await db.exec(original);
    const failed=h.read(sql).replace("notify pgrst,'reload schema';","select 1/0;");
    await assert.rejects(db.exec(failed),/division by zero/);await db.exec('rollback');
    assert.equal((await db.query("select to_regclass('public.student_wordbook_review_flow') t")).rows[0].t,null);
    assert.equal((await db.query("select pg_get_functiondef('public.wordbook_review_submit(uuid,uuid,uuid,jsonb)'::regprocedure) definition")).rows[0].definition,original);
    assert.deepEqual((await db.query("select function_hashes from student_wordbook_review_installation where version='v1'")).rows[0].function_hashes,audit);
    await db.exec(h.read(sql));await assert.rejects(db.exec(h.read(sql)),/VALIDATION_DRIFT/);await db.exec('rollback');
    await db.exec(h.read('supabase/student_wordbook_review_v1_immersive_verify.sql'));
  }finally{await db.close();}
});

test('no usable example or cross-source example does not block study; old completed rounds open results',
  {skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},async()=>{
  const db=await h.fixture();try{
    await h.save(db,{example:false});await h.save(db,{source:'rap'});
    const s=await h.create(db);await db.exec(h.read(sql));
    let r=await flow(db,s.session.session_id);assert.deepEqual(r.presentation.examples,[]);
    assert.equal(presentReviewState(r).item.example,null);
    // Existing submit path remains compatible and completed legacy rounds need no backfill.
    const old=await h.create(db);await h.submit(db,old.session.session_id,old.item.itemId,{spelling:'run',pos:'verb'});
    assert.equal((await flow(db,old.session.session_id)).flow.phase,'result');
    r=await flow(db,s.session.session_id,'start_test',r.item.itemId);
    const partial=await flow(db,s.session.session_id,'answer',r.item.itemId,{spelling:'run',pos:''});
    assert.equal(partial.item.answer.assessments.spelling,true);assert.equal(partial.item.answer.assessments.pos,false);
  }finally{await db.close();}
});

test('actual setup/session/history handlers run the full flow against isolated SQL; owner/answer allowlists and source themes stay intact',
  {skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},async()=>{
  const db=await h.fixture();try{
    await db.exec(h.read(sql));await h.pool(db);
    for(const source of ['ctw','rdl','rap','bas','write_email','academic_discussion'])
      await h.save(db,{source,expression:`word${source}`,pos:'noun',meaning:'词条'});
    const ts=require('typescript'),vm=require('node:vm');let user=h.U;
    const rpcArgs={wordbook_review_availability:['p_student','p_settings'],wordbook_review_create:['p_student','p_settings','p_request','p_parent'],
      wordbook_review_flow_state:['p_student','p_session','p_action','p_item','p_answer'],wordbook_review_history:['p_student','p_page']};
    const client={rpc:async(name,args)=>{try{
      const values=rpcArgs[name].map(k=>args[k]&&typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);
      return {data:(await db.query(`select ${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0].result};
    }catch(error){return {error};}}};
    const load=file=>{const exports={};vm.runInNewContext(ts.transpileModule(h.read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL,Request,require(name){
      if(name.includes('attemptServer'))return {requireReadingAttemptStudent:async()=>({userId:user}),readingAttemptJson:(body,init)=>({body,status:init?.status??200})};
      if(name.includes('supabase/server'))return {createServiceSupabase:()=>client};
      if(name.endsWith('wordbookReview.server'))return require('../lib/lexical/wordbookReview.server.ts');
      if(name.endsWith('wordbookReviewPresentation'))return require('../lib/lexical/wordbookReviewPresentation.ts');
      if(name.endsWith('wordbookReview'))return require('../lib/lexical/wordbookReview.ts');throw Error(name);
    }});return exports;};
    const setup=load('app/api/student/wordbook/review/route.ts'),session=load('app/api/student/wordbook/review/[sessionId]/route.ts');
    const url='https://offline.invalid/review',post=body=>new Request(url,{method:'POST',body:JSON.stringify(body)});
    for(const domain of ['reading','writing']){
      const sources=domain==='reading'?['ctw','rap']:['write_email','bas'];
      const settings=h.settings(sources,domain,2);
      assert.equal((await setup.GET(new Request(url+'?'+new URLSearchParams({action:'availability',settings:JSON.stringify(settings)})))).body.total,2);
      const created=await setup.POST(post({settings,requestId:h.uuid()}));assert.equal(created.status,200);
      const ctx={params:{sessionId:created.body.session.session_id}},read=()=>session.GET(new Request(url),ctx);
      let r=(await read()).body;assert.equal(r.flow.phase,'study');assert.equal(r.session.domain,domain);
      assert.ok(r.item.study.expression);assert.equal(r.item.answer,undefined);
      const id=r.item.itemId;
      assert.equal((await session.POST(post({action:'start_test',itemId:id,answer:{}}),ctx)).status,400);
      r=(await session.POST(post({action:'start_test',itemId:id}),ctx)).body;
      assert.equal(r.item.itemId,id);assert.equal(r.flow.phase,'test');assert.equal(r.item.study,undefined);assert.equal(r.presentation,undefined);
      if(r.item.kind==='spelling_pos')assert.equal(r.item.spellingShape.includes('word'),false);
      for(let n=0;n<2;n++){
        const itemId=r.item.itemId,answer=r.item.kind==='spelling_pos'?{spelling:'',pos:''}:{optionId:''};
        assert.equal((await session.POST(post({action:'answer',itemId,answer:{...answer,correct:true}}),ctx)).status,400);
        r=(await session.POST(post({action:'answer',itemId,answer}),ctx)).body;assert.equal(r.item.answer.correct,false);
        assert.deepEqual((await read()).body,r);
        r=(await session.POST(post({action:'advance',itemId}),ctx)).body;
      }
      assert.equal(r.flow.phase,'result');assert.equal(r.summary.incorrect,2);
      const retry=(await session.POST(post({action:'retry',requestId:h.uuid()}),ctx)).body;
      assert.equal(retry.session.parent_session_id,ctx.params.sessionId);
      assert.equal((await session.GET(new Request(url),{params:{sessionId:retry.session.session_id}})).body.flow.phase,'study');
      user=h.V;assert.equal((await read()).status,404);user=h.U;
    }
    const history=await setup.GET(new Request(url+'?action=history&page=1'));
    assert.equal(history.body.total,4);assert.equal(history.body.items.filter(x=>x.status==='completed').length,2);
    await db.exec(h.read('supabase/student_wordbook_review_v1_immersive_verify.sql'));
  }finally{await db.close();}
});
