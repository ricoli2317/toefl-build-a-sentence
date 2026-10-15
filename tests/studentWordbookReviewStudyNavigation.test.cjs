const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {randomUUID}=require('node:crypto');
const fixture=require('./helpers/wordbookStudyHookFixture.cjs');
const {round,engine,owner,session}=fixture;
const command=(action,state,answer)=>({id:randomUUID(),action,itemId:state.round.cards[state.position-1].itemId,...(answer?{answer}:{})});
const step=(state,action,at=0,answer)=>engine.applyReviewAction(state,command(action,state,answer),at);
const read=file=>fs.readFileSync(file,'utf8');
const hasRenderer=Boolean(process.env.WORDBOOK_REVIEW_REACT_RENDERER);

test('shared study navigation is bounded, 3→2→3 tracks displayed progress, and never changes answers/deadlines/session identity',()=>{
  let state=engine.localReview(owner,round());assert.equal(step(state,'study_previous'),state);
  state=step(step(state,'study_next'),'study_next');assert.equal(state.position,3);
  const snapshots=JSON.stringify({round:state.round,answers:state.answers,deadlines:state.deadlines});
  state=step(state,'study_previous');assert.equal(state.position,2);assert.equal(engine.reviewLocalState(state).item.position,2);
  assert.equal(engine.reviewLocalState(state).item.study.expression,'two');
  state=step(state,'study_next');assert.equal(state.position,3);assert.equal(engine.reviewLocalState(state).flow.position,3);
  assert.equal(engine.reviewLocalState(state).item.study.expression,'three');
  assert.equal(step(state,'study_next'),state);assert.equal(step(state,'advance',86400000),state);
  assert.equal(JSON.stringify({round:state.round,answers:state.answers,deadlines:state.deadlines}),snapshots);
  const memory=new Map(),storage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
  for(const namespace of ['wordbook-review','ctw-vocabulary-review']){
    engine.saveLocalReview(storage,state,namespace);assert.deepEqual(engine.readLocalReview(storage,owner,session,namespace),state);
  }
  const stale=command('study_previous',state);state=engine.applyReviewAction(state,stale);
  assert.equal(engine.applyReviewAction(state,stale),state);assert.equal(state.position,2);
  assert.equal(step(state,'unknown'),state);
  const testState=step(state,'start_test');assert.equal(testState.position,1);assert.equal(step(testState,'study_previous'),testState);
});

test('delayed ACK only removes its own queued command, never rewinds or advances a study cursor',()=>{
  let state=engine.localReview(owner,round());state=step(step(state,'study_next'),'study_next');
  const old=state.queue[0];state=step(state,'study_previous');
  state=engine.acknowledgeReview(state,old);assert.equal(state.position,2);assert.equal(state.phase,'study');
  assert.equal(state.queue.length,2);assert.equal(state.confirmed,0);assert.equal(engine.acknowledgeReview(state,old),state);
  assert.equal(step(state,'advance',Number.MAX_SAFE_INTEGER),state);
});

test('actual shared workspace renders two equal columns at every study position; first is disabled and CTW label is a parameter',()=>{
  const React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),exports={};
  const mocks={react:{...React,useEffect:()=>{},useLayoutEffect:()=>{}},'react/jsx-runtime':require('react/jsx-runtime'),
    'next/link':({children,href,...props})=>React.createElement('a',{...props,href},children),
    '@/lib/lexical/wordbookReview':fixture.model,'@/lib/lexical/wordbookReviewInput':require('../lib/lexical/wordbookReviewInput.ts'),
    './WordbookReviewWorkspace.module.css':{}};
  vm.runInNewContext(ts.transpileModule(read('components/student/WordbookReviewWorkspace.tsx'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,
    {exports,require:name=>mocks[name]});
  for(const spellingOnly of [false,true])for(const position of [1,2,3]){
    const local=engine.localReview(owner,round());local.position=position;
    const html=renderToStaticMarkup(React.createElement(exports.WordbookReviewWorkspace,{state:engine.reviewLocalState(local),spellingOnly,
      ...(spellingOnly?{skipStudyLabel:'跳过学习'}:{}),busy:false,onAction:async()=>{},onReload:()=>{},onRetry:()=>{}}));
    assert.match(html,/class="grid grid-cols-2 gap-3" aria-label="学习导航"/);
    assert.match(html,new RegExp(`${position}/3`));assert.match(html,/>下一个<\/button>/);
    const previous=html.match(/<button[^>]*>上一个<\/button>/)[0];assert.equal(previous.includes('disabled=""'),position===1);
    assert.match(html,spellingOnly?/跳过学习/:/跳过复习/);assert.doesNotMatch(html,/再看一遍/);
    assert.doesNotMatch(html,/sm:grid-cols|md:grid-cols/);
  }
  assert.match(read('components/student/CtwVocabularyWorkspace.tsx'),/skipStudyLabel="跳过学习"/);
});

for(const adapter of [undefined,{root:'/api/student/ctw-vocabulary/review',namespace:'ctw-vocabulary-review',cacheKey:url=>url}]){
 const domain=adapter?'CTW':'wordbook';
 test(`${domain}: real hook stays at word 2 through 24 hours, blur/focus/TAB/pageshow/online/ACK, refresh and backward navigation`,{skip:!hasRenderer},async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
  const ack=fixture.deferred(),hook=await fixture.mount({adapter,request:async(_url,body)=>body?ack.promise:round()});
  try{
    await hook.action('study_next');assert.equal(hook.value.local.position,2);
    const oldAction=hook.value.action;
    await hook.act(async()=>t.mock.timers.tick(86400000));
    for(const event of ['blur','focus','visibilitychange','pageshow','online'])await hook.wake(event);
    assert.equal(hook.value.local.position,2);assert.equal(hook.calls.filter(c=>c.body).length,1);
    await hook.act(async()=>ack.resolve({acknowledged:hook.calls.find(c=>c.body).body.command.id}));
    assert.equal(hook.value.local.position,2);assert.equal(hook.value.pending,0);
    // A late callback from the old rendered card cannot act on a newer revision,
    // even after revisiting the same card.
    await hook.action('study_previous');assert.equal(hook.value.local.position,1);
    await hook.action('study_next');assert.equal(hook.value.local.position,2);
    const count=hook.value.local.queue.length;
    await hook.act(async()=>oldAction('study_next'));assert.equal(hook.value.local.position,2);assert.equal(hook.value.local.queue.length,count);
    const persisted=engine.readLocalReview(hook.storage,owner,session,hook.namespace);
    await hook.close();
    const resumed=await fixture.mount({adapter,initial:persisted,request:async(_url,body)=>body?fixture.deferred().promise:round()});
    try{assert.equal(resumed.value.local.position,2);assert.equal(resumed.value.local.round.session.session_id,session);}
    finally{await resumed.close();}
  }finally{await hook.close();}
 });

 test(`${domain}: delayed server restoration cannot overwrite a newer durable study position`,{skip:!hasRenderer},async()=>{
  const response=fixture.deferred(),hook=await fixture.mount({adapter,request:()=>response.promise});
  try{
    const newer=step(engine.localReview(owner,round()),'study_next');
    await hook.storageEvent(newer);assert.equal(hook.value.local.position,2);
    const stale=round();stale.flow.position=3;
    await hook.act(async()=>response.resolve(stale));
    assert.equal(hook.value.local.position,2);assert.equal(engine.readLocalReview(hook.storage,owner,session,hook.namespace).position,2);
  }finally{await hook.close();}
 });

 test(`${domain}: completion in another tab replaces an old active cursor when its pending record is removed`,{skip:!hasRenderer},async()=>{
  const initial=engine.localReview(owner,round());initial.position=2;
  const completed=round();completed.flow={phase:'result',position:3};completed.session={...completed.session,status:'completed',answered:3};
  completed.cards=completed.cards.map(card=>({...card,answer:engine.gradeReview(card,{spelling:card.expected.expression,pos:'noun'})}));
  const hook=await fixture.mount({adapter,initial,request:async()=>completed});
  try{
    const key=engine.localReviewKey(owner,session,hook.namespace);hook.storage.removeItem(key);
    await hook.act(async()=>hook.window.dispatchEvent(Object.assign(new Event('storage'),{key})));
    assert.equal(hook.value.local.phase,'result');assert.equal(hook.value.local.position,3);
    assert.equal(hook.storage.getItem(key),null);
  }finally{await hook.close();}
 });
}

test('real hook test-only timer still waits 1000ms for complete correctness; wrong and incomplete CTW forms never auto-advance',
 {skip:!hasRenderer},async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
  const state=engine.localReview(owner,round());
  state.round.cards[1]={...state.round.cards[1],kind:'spelling',spellingGroups:[
    {id:'base',accepted:['get'],shape:'___'},
    {id:'past_participle',accepted:['got','gotten'],requiredAll:true,shapes:['___','______'],shape:'___'}]};
  const hook=await fixture.mount({initial:state,request:async(_url,body)=>body?fixture.deferred().promise:round()});
  try{
    await hook.action('start_test');await hook.action('answer',{spelling:'one',pos:'noun'});
    await hook.act(async()=>t.mock.timers.tick(999));assert.equal(hook.value.local.position,1);
    await hook.act(async()=>t.mock.timers.tick(1));assert.equal(hook.value.local.position,2);
    await hook.action('answer',{spellings:{base:'get',past_participle:'got / '}});
    await hook.act(async()=>t.mock.timers.tick(86400000));assert.equal(hook.value.local.position,2);
    await hook.action('advance');assert.equal(hook.value.local.position,3);
    await hook.action('answer',{spelling:'wrong',pos:'noun'});
    await hook.act(async()=>t.mock.timers.tick(86400000));assert.equal(hook.value.local.phase,'test');
  }finally{await hook.close();}
});

test('real hook automatically advances only after every required CTW spelling is correct and the original second elapses',
 {skip:!hasRenderer},async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
  const state=engine.localReview(owner,round());state.round.cards[0]={...state.round.cards[0],kind:'spelling',spellingGroups:[
    {id:'base',accepted:['get'],shape:'___'},
    {id:'past_participle',accepted:['got','gotten'],requiredAll:true,shapes:['___','______'],shape:'___'}]};
  const hook=await fixture.mount({initial:state,request:async(_url,body)=>body?fixture.deferred().promise:round()});
  try{
    await hook.action('start_test');await hook.action('answer',{spellings:{base:'get',past_participle:'got / gotten'}});
    assert.equal(hook.value.state.item.answer.correct,true);
    await hook.act(async()=>t.mock.timers.tick(999));assert.equal(hook.value.local.position,1);
    await hook.act(async()=>t.mock.timers.tick(1));assert.equal(hook.value.local.position,2);
  }finally{await hook.close();}
});

test('wordbook incremental SQL adds backward navigation only, is repeat-safe, rejects drift and preserves saved records/ACL',
 {skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},async()=>{
  const h=require('./helpers/wordbookFixedPoolFixture.cjs'),db=await h.fixture();
  const patch='supabase/student_wordbook_review_v1_study_navigation.sql',verify='supabase/student_wordbook_review_v1_study_navigation_verify.sql';
  const flow=async(id,action='read',item=null,user=h.U)=>(await db.query('select wordbook_review_flow_state($1,$2,$3,$4,null) result',[user,id,action,item])).rows[0].result;
  try{
    await db.exec(h.read('supabase/student_wordbook_review_v1_immersive_migration.sql'));
    for(const word of ['yield','keep','move'])await h.save(db,{expression:word,pos:'verb',meaning:'固定测试义项'});
    const s=await h.create(db,h.settings(['ctw'],'reading',3)),id=s.session.session_id;
    const old=await h.create(db,h.settings(['ctw'],'reading',1));await h.submit(db,old.session.session_id,old.item.itemId,{spelling:'wrong',pos:'verb'});
    await flow(id);
    const tables=['student_wordbook_review_sessions','student_wordbook_review_items','student_wordbook_review_answers','student_wordbook_review_flow','student_wordbook_entries'];
    const capture=async()=>{const data={};for(const table of tables)data[table]=(await db.query(`select to_jsonb(t) v from ${table} t order by to_jsonb(t)::text`)).rows;return data;};
    const before=await capture();
    const protectedFunctions=async()=>(await db.query("select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname<>'wordbook_review_flow_state' order by oid")).rows;
    const protectedBefore=await protectedFunctions();
    const definition=(await db.query("select pg_get_functiondef('wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)'::regprocedure) v")).rows[0].v;
    await db.exec(definition.replace('begin\n','begin\n-- test drift\n'));
    await assert.rejects(db.exec(h.read(patch)),/REVIEW_STUDY_NAV_BASELINE_DRIFT/);await db.exec('rollback');await db.exec(definition);
    await assert.rejects(db.exec(h.read(patch).replace("notify pgrst,'reload schema';",'select 1/0;')),/division by zero/);await db.exec('rollback');
    assert.equal((await db.query("select pg_get_functiondef('wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)'::regprocedure) v")).rows[0].v,definition);
    await db.exec(h.read(patch));await db.exec(h.read(verify));await db.exec(h.read(patch));await db.exec(h.read('supabase/student_wordbook_review_v1_immersive_verify.sql'));
    assert.deepEqual(await capture(),before);assert.deepEqual(await protectedFunctions(),protectedBefore);
    let r=await flow(id);r=await flow(id,'study_previous',r.item.itemId);assert.equal(r.flow.position,1);
    r=await flow(id,'study_next',r.item.itemId);r=await flow(id,'study_next',r.item.itemId);assert.equal(r.flow.position,3);
    const third=r.item.itemId;
    const exports={},client=require('./helpers/wordbookReviewApiFixture.cjs').client(db);
    const mocks={
      '@/lib/reading/attemptServer':{requireReadingAttemptStudent:async()=>({userId:h.U}),readingAttemptJson:(body,init)=>({body,status:init?.status??200})},
      '@/lib/supabase/server':{createServiceSupabase:()=>client},
      '@/lib/lexical/wordbookReview':fixture.model,
      '@/lib/lexical/wordbookReview.server':require('../lib/lexical/wordbookReview.server.ts'),
      '@/lib/lexical/wordbookReviewPresentation':require('../lib/lexical/wordbookReviewPresentation.ts'),
      '@/lib/lexical/wordbookReviewRound.server':require('../lib/lexical/wordbookReviewRound.server.ts')};
    vm.runInNewContext(ts.transpileModule(read('app/api/student/wordbook/review/[sessionId]/route.ts'),
      {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL,require:name=>mocks[name]});
    const previous={id:randomUUID(),action:'study_previous',itemId:third};
    const send=()=>exports.POST(new Request('https://offline.invalid/review',{method:'POST',body:JSON.stringify({action:'sync',command:previous})}),{params:{sessionId:id}});
    for(let retry=0;retry<2;retry++){const ack=await send();assert.equal(ack.status,200);assert.equal(ack.body.acknowledged,previous.id);}
    r=await flow(id);assert.equal(r.flow.position,2);
    assert.deepEqual(await flow(id,'study_previous',third),r);
    assert.equal((await flow(id)).flow.position,2);r=await flow(id,'study_next',r.item.itemId);assert.equal(r.flow.position,3);
    await assert.rejects(flow(id,'read',null,h.V),/NOT_FOUND/);
    r=await flow(id,'start_test',r.item.itemId);assert.equal(r.flow.phase,'test');assert.equal(r.flow.position,1);
    await assert.rejects(flow(id,'study_previous',r.item.itemId),/INVALID_ACTION/);
    for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(flow(id),/permission denied/);await db.exec('reset role');}
    assert.equal((await db.query('select count(*)::int n from student_wordbook_review_sessions')).rows[0].n,2);
    assert.equal((await db.query('select count(*)::int n from student_wordbook_review_answers')).rows[0].n,1);
  }finally{await db.close();}
});
