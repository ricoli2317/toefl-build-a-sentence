const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture,client,read,currentSource:source,U,V,X}=require('./helpers/ctwVocabularyFixture.cjs');
const local=require('../lib/lexical/wordbookReviewLocal.ts');
const review=require('../lib/ctw-vocabulary/review.ts');
const server=require('../lib/ctw-vocabulary/review.server.ts');
const store=require('../lib/ctw-vocabulary/store.server.ts');
const input=require('../lib/ctw-vocabulary/input.ts');
const presentation=require('../lib/lexical/wordbookReviewPresentation.ts');
const TARGET={kind:'cefr_list',group:'B1',listNumber:4};
async function setup({lifeFix=true}={}){const db=await fixture();try{
  await db.exec(read('outputs/ctw-vocabulary-phase3/ctw-vocabulary-phase3-install.sql'));
  await db.exec(read('supabase/ctw_vocabulary_phase3_start_owner_fix.sql'));
  await db.exec(read('supabase/ctw_vocabulary_american_spelling.sql'));
  await db.exec(read('supabase/ctw_vocabulary_american_spelling_verify.sql'));
  if(lifeFix){await db.exec(read('supabase/ctw_vocabulary_life_regular_form_fix.sql'));
    await db.exec(read('supabase/ctw_vocabulary_life_regular_form_verify.sql'));}
  await db.exec(read('supabase/ctw_vocabulary_review_sync.sql'));
  await db.exec(read('supabase/ctw_vocabulary_review_sync_verify.sql'));return db;
}catch(e){await db.close();throw e;}}
async function create(db,source=TARGET,owner=U,id=randomUUID(),parent){
  return server.createCtwReview(client(db,'authenticated',owner),client(db,'service_role',owner),owner,
    server.parseCtwReviewStart({requestId:id,source,...(parent?{parent}:{})}));
}
function answer(card,wrong=false){return{spellings:Object.fromEntries(card.spellingGroups.map(g=>[g.id,wrong&&g.id==='base'?'wrong':g.requiredAll?g.accepted.join(' / '):g.accepted.at(-1)]))};}
async function complete(db,round,wrongFirst=false,owner=U){
  let state=local.localReview(owner,round),time=10000;const commands=[];
  async function act(action,student){const command={id:randomUUID(),action,itemId:state.round.cards[state.position-1].itemId,...(student?{answer:student}:{})};
    const next=local.applyReviewAction(state,command,time);assert.notEqual(next,state);state=next;
    assert.deepEqual(await server.syncCtwReview(client(db,'service_role',owner),owner,round.session.session_id,command),{acknowledged:command.id});
    state=local.acknowledgeReview(state,command);commands.push(command);return command;}
  await act('start_test');
  for(let i=0;i<round.cards.length;i++){await act('answer',answer(round.cards[i],wrongFirst&&i===0));time+=1000;await act('advance');}
  return{state,commands};
}
test('all 1032 reviewed words produce safe test prompts before rendering, while full study senses remain exact',()=>{
  let changed=0;
  for(const [index,row]of source().rows.entries()){
    const entry={...row,entry_id:randomUUID(),list_number:1,list_position:1,source_sha256:'a'.repeat(64)};
    const card=review.ctwReviewCard(entry,index),forms=review.vocabularyPromptForms(entry);
    for(const sense of row.senses){const safe=presentation.protectedReviewPrompt(sense.meaning_zh,row.word,forms);
      assert.ok(safe.trim(),row.word);assert.ok(!presentation.reviewExample(safe,row.word,true,forms).some(p=>p.target),row.word);
      if(safe!==sense.meaning_zh)changed++;
    }
    assert.deepEqual(card.studySenses.map(s=>s.meaning),row.senses.map(s=>s.meaning_zh));
    assert.deepEqual(card.studySenses.map(s=>s.example),row.senses.map(s=>s.example_en));
  }
  assert.ok(changed>0);console.log('Protected leaking senses across the entire library:',changed);
  assert.equal(presentation.protectedReviewPrompt('获得；提取（常用于 derive from）','derive',['derived','deriving']),'获得；提取');
  assert.equal(presentation.protectedReviewPrompt('获得（derived from）；DNA','derive',['derived']),'获得；DNA');
  assert.equal(presentation.protectedReviewPrompt('收到（GOTTEN）；DNA','get',['got','gotten']),'收到；DNA');
  assert.equal(presentation.protectedReviewPrompt('影响（influence）；DNA','in',[]),'影响（influence）；DNA');
  assert.equal(presentation.protectedReviewPrompt('钟（body clock：生物钟）；DNA','clock',[]),'钟（生物钟）；DNA');
  assert.equal(presentation.protectedReviewPrompt('提取（常用于 derive from；不涉及 DNA）','derive',[]),'提取（不涉及 DNA）');
  for(const[word,pos,form]of[['derive','verb','deriving'],['die','verb','dying'],['carry','verb','carried'],['happy','adjective','happiest'],['large','adjective','larger'],['big','adjective','biggest'],['library','noun','libraries']]){
    const forms=review.vocabularyPromptForms({word,senses:[{pos}],irregular_forms:[]});assert.ok(forms.includes(form),form);
    assert.equal(presentation.protectedReviewPrompt(`中文（常用于 ${form.toUpperCase()}）`,word,forms),'中文');
  }
});
test('spelling-only cards use the actual Wordbook state machine, per-input grading, persisted deadline, stale/double action guards and retry policy',()=>{
  const row=source().rows.find(r=>r.word==='get');const round=review.createCtwReviewRound(randomUUID(),{kind:'list',listNumber:1},[{...row,entry_id:randomUUID(),list_number:1,list_position:1,source_sha256:'a'.repeat(64)}]);
  let state=local.localReview(U,round);const command=(action,student)=>({id:randomUUID(),action,itemId:round.cards[0].itemId,...(student?{answer:student}:{})});
  state=local.applyReviewAction(state,command('start_test'),0);const raw=answer(round.cards[0]);
  state=local.applyReviewAction(state,command('answer',raw),500);
  assert.equal(state.answers[round.cards[0].itemId].correct,true);assert.equal(state.deadlines[round.cards[0].itemId],1500);
  assert.equal(local.applyReviewAction(state,command('advance'),1499),state);
  assert.equal(local.applyReviewAction(state,command('answer',raw),1500),state);
  state=local.applyReviewAction(state,command('advance'),1500);assert.equal(state.phase,'result');
  const wrong={...raw,spellings:{...raw.spellings,past:'incorrect'}};
  assert.equal(local.gradeReview(round.cards[0],wrong).correct,false);
  assert.equal(local.gradeReview(round.cards[0],wrong).assessments.base,true);
  const memory=new Map(),storage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
  local.saveLocalReview(storage,state,review.CTW_REVIEW_NAMESPACE);
  assert.deepEqual(local.readLocalReview(storage,U,round.session.session_id,review.CTW_REVIEW_NAMESPACE),state);
  assert.equal(local.readLocalReview(storage,V,round.session.session_id,review.CTW_REVIEW_NAMESPACE),null);
  assert.equal(local.readLocalReview(storage,U,round.session.session_id),null);
  for(let i=0;i<3;i++){state=local.recordReviewSyncFailure(state,'retry',true);assert.equal(local.visibleReviewSyncError(state),'');}
  state=local.recordReviewSyncFailure(state,'retry',true);assert.equal(local.visibleReviewSyncError(state),'retry');
});
test('session creation is idempotent, uses fixed real List words and immediately marks only its edition in progress',async()=>{
  const db=await setup();try{
    const id=randomUUID(),round=await create(db,TARGET,U,id);assert.equal(round.cards.length,3);
    assert.deepEqual(await create(db,TARGET,U,id),round);
    const c=client(db,'authenticated',U),cefr=(await store.readVocabularyLists(c,'cefr')).lists;
    assert.equal(cefr.find(l=>l.group==='B1'&&l.listNumber===4).status,'in_progress');
    assert.ok((await store.readVocabularyLists(c,'mixed')).lists.every(l=>l.status==='not_started'));
    const history=await server.readCtwReviewHistory(c,1);assert.equal(history.total,1);assert.equal(history.items[0].status,'active');assert.equal(history.items[0].answered,0);
    assert.equal(review.ctwRangeLabel(history.items[0]),'B1 · List 04');
    await assert.rejects(create(db,{kind:'list',listNumber:21},U,id),/CONFLICT/);
  }finally{await db.close();}
});
test('one answer is saved before round completion; ACK loss retry is exact and keeps receipt IDs independent of JSON key order',async()=>{
  const db=await setup();try{
    const round=await create(db);let state=local.localReview(U,round);
    const start={id:randomUUID(),itemId:round.cards[0].itemId,action:'start_test'};
    await server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,start);
    const command={id:randomUUID(),action:'answer',itemId:round.cards[0].itemId,answer:answer(round.cards[0])};
    const result=await server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,command);
    assert.deepEqual(await server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,JSON.parse(JSON.stringify(command))),result);
    const loaded=await server.readCtwReview(client(db,'authenticated',U),U,round.session.session_id);
    assert.equal(loaded.session.answered,1);assert.equal(loaded.cards[0].answer.correct,true);
    assert.equal((await server.readCtwReviewHistory(client(db,'authenticated',U),1)).items[0].answered,1);
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,0);
    await assert.rejects(server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,{...command,answer:{spellings:{base:'changed'}}}),/CONFLICT/);
  }finally{await db.close();}
});
test('full completion atomically saves independent existing CTW attempt/progress; lower later scores preserve the List best',async()=>{
  const db=await setup();try{
    const round=await create(db),{commands}=await complete(db,round);
    const result=await store.readVocabularyResult(client(db,'authenticated',U),U,round.session.session_id);assert.equal(result.correct_count,3);
    const c=client(db,'authenticated',U),card=()=>store.readVocabularyLists(c,'cefr').then(r=>r.lists.find(l=>l.group==='B1'&&l.listNumber===4));
    assert.equal((await card()).status,'completed');assert.equal((await card()).bestAccuracy,100);
    await server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,commands.at(-1));
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,1);
    await complete(db,await create(db),true);assert.equal((await card()).bestAccuracy,100);
    assert.ok((await store.readVocabularyLists(c,'mixed')).lists.every(l=>l.bestAccuracy===null));
    const history=await server.readCtwReviewHistory(c,1);assert.equal(history.total,2);assert.ok(history.items.every(s=>s.status==='completed'));
  }finally{await db.close();}
});
test('wrong-word retry uses only the parent errors, new session ID, study phase and independent result without rewriting the original',async()=>{
  const db=await setup();try{
    const parent=await create(db);await complete(db,parent,true);
    const c=client(db,'authenticated',U),original=await store.readVocabularyResult(c,U,parent.session.session_id);
    const retry=await create(db,TARGET,U,randomUUID(),parent.session.session_id);
    assert.equal(retry.cards.length,1);assert.equal(retry.cards[0].itemId,parent.cards[0].itemId);assert.equal(retry.flow.phase,'study');
    await complete(db,retry);assert.deepEqual(await store.readVocabularyResult(c,U,parent.session.session_id),original);
    assert.equal((await store.readVocabularyResult(c,U,retry.session.session_id)).correct_count,1);
    const card=(await store.readVocabularyLists(c,'cefr')).lists.find(l=>l.group==='B1'&&l.listNumber===4);
    assert.equal(card.status,'in_progress');assert.ok(card.bestAccuracy<100,'A partial retry must not claim 100% for the full List');
    await assert.rejects(create(db,TARGET,V,randomUUID(),parent.session.session_id),/NOT_FOUND/);
  }finally{await db.close();}
});
test('late final attempt failure rolls back session receipt and final result together; same queued final command is retryable',async()=>{
  const db=await setup();try{
    const round=await create(db);let state=local.localReview(U,round),clock=0;
    const act=async(action,student)=>{const c={id:randomUUID(),action,itemId:state.round.cards[state.position-1].itemId,...(student?{answer:student}:{})};
      state=local.applyReviewAction(state,c,clock);await server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,c);return c;};
    await act('start_test');
    for(let i=0;i<3;i++){await act('answer',answer(round.cards[i]));clock+=1000;if(i<2)await act('advance');}
    await db.exec(`create function public.block_ctw_attempt() returns trigger language plpgsql as $$begin raise exception 'offline late failure'; end$$;
      create trigger block_ctw_attempt before insert on student_ctw_vocabulary_attempts for each row execute function block_ctw_attempt();`);
    const last={id:randomUUID(),action:'advance',itemId:round.cards.at(-1).itemId};
    await assert.rejects(server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,last),/DATABASE/);
    assert.equal((await server.readCtwReview(client(db,'authenticated',U),U,round.session.session_id)).session.status,'active');
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,0);
    await db.exec('drop trigger block_ctw_attempt on student_ctw_vocabulary_attempts');
    await server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,last);
    assert.equal((await store.readVocabularyResult(client(db,'authenticated',U),U,round.session.session_id)).correct_count,3);
  }finally{await db.close();}
});
test('legacy result/history snapshots survive upgrade without edits and remain eligible for wrong-word retry',async()=>{
  const db=await setup();try{
    const e=(await db.query("select * from ctw_vocabulary_entries where list_number=21 order by list_position limit 1")).rows[0],id=randomUUID();
    const original=await store.saveVocabularyAttempt(client(db,'service_role'),U,{attemptId:id,mode:'base_form',source:{kind:'list',listNumber:21},
      answers:[{entryId:e.entry_id,spelling:'wrong',irregularSpellings:e.irregular_forms.map(f=>({formType:f.form_type,spelling:f.answers[0]}))}]});
    const c=client(db,'authenticated',U),round=await server.readCtwReview(c,U,id);
    assert.equal(round.session.status,'completed');assert.equal(round.summary.incorrect,1);
    assert.equal((await server.readCtwReviewHistory(c,1)).total,1);
    const retry=await create(db,{kind:'list',listNumber:21},U,randomUUID(),id);assert.equal(retry.cards.length,1);
    await complete(db,retry);assert.deepEqual(await store.readVocabularyResult(c,U,id),original);
  }finally{await db.close();}
});
test('strict input, server state guards, self-only RLS and service-only sync prevent owner/score injection and cross-account replay',async()=>{
  for(const raw of [{requestId:randomUUID(),source:TARGET,student_id:V},{requestId:randomUUID(),source:TARGET,correct:3}])assert.throws(()=>server.parseCtwReviewStart(raw));
  for(const answer of [{spellings:{base:'ok'},correct:true},{spelling:'ok'},{spellings:{base:1}}])assert.throws(()=>server.parseCtwReviewCommand({id:randomUUID(),itemId:randomUUID(),action:'answer',answer}));
  const db=await setup();try{
    const round=await create(db);await assert.rejects(server.readCtwReview(client(db,'authenticated',V),V,round.session.session_id),/NOT_FOUND/);
    assert.equal((await server.readCtwReviewHistory(client(db,'authenticated',V),1)).total,0);
    await assert.rejects(create(db,TARGET,X));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[U]);await db.exec('set role authenticated');
    for(const sql of ["update student_ctw_vocabulary_review_sessions set answered=3",'delete from student_ctw_vocabulary_review_sessions',
      `select public.sync_ctw_vocabulary_review_v1('${U}','${round.session.session_id}',0,'{}','{}',null)`])await assert.rejects(db.exec(sql),/permission denied/);
    await db.exec('reset role');
    const stale={id:randomUUID(),action:'advance',itemId:round.cards[0].itemId};
    await assert.rejects(server.syncCtwReview(client(db,'service_role'),U,round.session.session_id,stale),/CONFLICT/);
  }finally{await db.close();}
});
test('actual new Next handlers authenticate before validation/service access, reject injected grades/owners, and bind writes to trusted identity',async()=>{
  const vm=require('node:vm'),ts=require('typescript');let allowed=false,services=0;const calls=[];
  const dependencies={
    'http.server':{vocabularyRoute:async(req,fn)=>{
      if(!allowed)return{status:401};
      try{return{status:200,data:await fn({jwtScoped:true},U)};}
      catch(e){return{status:e instanceof input.VocabularyInputError||e instanceof SyntaxError?400:500};}
    }},
    'input':input,
    'supabase/server':{createServiceSupabase:()=>{services++;return{service:true};}},
    'review.server':{...server,...Object.fromEntries(['createCtwReview','readCtwReviewHistory','readCtwReview','syncCtwReview'].map(name=>[name,async(...args)=>{calls.push({name,args});return{};}]))}
  };
  function handler(file){const exports={};vm.runInNewContext(ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,
    {exports,URL,Request,Error,JSON,require:name=>{const value=dependencies[Object.keys(dependencies).find(k=>name.endsWith(k))];if(!value)throw Error(name);return value;}});return exports;}
  const root=handler('app/api/student/ctw-vocabulary/review/route.ts'),session=handler('app/api/student/ctw-vocabulary/review/[sessionId]/route.ts');
  const id=randomUUID(),params={params:{sessionId:id}},get=search=>new Request('https://offline.invalid/api'+(search||''));
  const post=body=>new Request('https://offline.invalid/api',{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)});
  for(const h of [root,session]){assert.equal((await h.GET(get(),params)).status,401);assert.equal((await h.POST(post('bad json'),params)).status,401);}
  assert.equal(services,0);assert.equal(calls.length,0);allowed=true;
  for(const q of ['?student_id='+V,'?page=0','?page=1&page=2','?page=-1','?page=1000000'])assert.equal((await root.GET(get(q))).status,400);
  for(const q of ['?round=1&student_id='+V,'?round=1&round=1','?round=0'])assert.equal((await session.GET(get(q),params)).status,400);
  for(const body of ['bad json',{requestId:id,source:TARGET,student_id:V},{requestId:id,source:TARGET,correct:3}])assert.equal((await root.POST(post(body))).status,400);
  for(const command of [{id:randomUUID(),itemId:randomUUID(),action:'answer',answer:{spellings:{base:'ok'},correct:true}},
    {id:randomUUID(),itemId:randomUUID(),action:'advance',owner:V},
    {id:randomUUID(),itemId:randomUUID(),action:'unknown'}])assert.equal((await session.POST(post({action:'sync',command}),params)).status,400);
  assert.equal(services,0);assert.equal(calls.length,0);
  assert.equal((await root.POST(post({requestId:id,source:TARGET}))).status,200);assert.equal(calls.at(-1).args[2],U);
  const command={id:randomUUID(),itemId:randomUUID(),action:'answer',answer:{spellings:{base:'ok'}}};
  assert.equal((await session.POST(post({action:'sync',command}),params)).status,200);assert.equal(calls.at(-1).args[1],U);
  assert.equal(calls.at(-1).args[2],id);assert.deepEqual(calls.at(-1).args[3],command);
  assert.equal((await root.GET(get('?page=2'))).status,200);assert.equal(calls.at(-1).args[1],2);
  assert.equal((await session.GET(get('?round=1'),params)).status,200);assert.equal(calls.at(-1).args[1],U);
  assert.equal(services,2);
});
test('all 1032 words / 89 stored groups / 86 displayed rows use the same study, test, local and saved-result answers',()=>{
  let groups=0;
  for(const row of source().rows){
    const entry={...row,entry_id:randomUUID(),list_number:1,list_position:1,source_sha256:'a'.repeat(64)},card=review.ctwReviewCard(entry,0);
    const verify=student=>{
      const localAnswer=local.gradeReview(card,student),round=review.createCtwReviewRound(randomUUID(),{kind:'list',listNumber:1},[entry]),state=local.localReview(U,round);
      state.answers[entry.entry_id]=localAnswer;const graded=review.ctwSavedAnswers(state)[0];
      assert.equal(localAnswer.correct,graded.correct,row.word);assert.equal(localAnswer.assessments.base,graded.baseCorrect);
      for(const form of graded.irregularResults){assert.equal(localAnswer.assessments[form.formType],form.correct,row.word+':'+form.formType);
        assert.deepEqual(form.acceptedAnswers,card.spellingGroups.find(g=>g.id===form.formType).accepted);}
    };
    verify(answer(card));verify(answer(card,true));
    for(const group of card.spellingGroups.filter(g=>g.id!=='base')){groups++;
      const student=answer(card);student.spellings[group.id]=group.accepted.map(s=>s.toUpperCase()).join(' / ');verify(student);
      const wrong=answer(card);wrong.spellings[group.id]='';verify(wrong);}
  }
  assert.equal(groups,86);assert.equal(source().rows.reduce((n,row)=>n+row.irregular_forms.length,0),89);
});
test('history pages are bounded summaries with deterministic ordering; duplicate install aborts without altering completed data',async()=>{
  const db=await setup();try{
    for(let n=0;n<11;n++)await create(db);
    const c=client(db,'authenticated',U),first=await server.readCtwReviewHistory(c,1),second=await server.readCtwReviewHistory(c,2);
    assert.equal(first.total,11);assert.equal(first.items.length,10);assert.equal(second.items.length,1);
    assert.equal(new Set([...first.items,...second.items].map(s=>s.session_id)).size,11);
    for(const item of first.items){assert.equal(Object.hasOwn(item,'state'),false);assert.equal(Object.hasOwn(item,'cards'),false);assert.equal(Object.hasOwn(item,'answers'),false);}
    await assert.rejects(db.exec(read('supabase/ctw_vocabulary_review_sync.sql')),/already exists/);await db.exec('rollback');
    assert.deepEqual(await server.readCtwReviewHistory(c,1),first);
    await db.exec(read('supabase/ctw_vocabulary_review_sync_verify.sql'));
  }finally{await db.close();}
});
test('reviewed tense rows require ALL variants; only same-length slots may permute, and duplicates/blanks/partial alternatives fail',()=>{
  const card=word=>review.ctwReviewCard({...source().rows.find(e=>e.word===word),entry_id:randomUUID(),list_number:1,list_position:1,source_sha256:'a'.repeat(64)},0);
  const be=card('be'),groups=be.spellingGroups.slice(1);
  assert.deepEqual(groups.map(g=>[g.label,g.accepted]),[['现在时',['am','is','are']],['过去时',['was','were']],['过去分词',['been']]]);
  assert.deepEqual(groups.map(g=>g.shapes.length),[3,2,1]);
  const student=answer(be);student.spellings[groups[0].id]='IS / AM / are';assert.equal(local.gradeReview(be,student).correct,true);
  student.spellings[groups[0].id]='am / am / are';assert.equal(local.gradeReview(be,student).correct,false);
  student.spellings[groups[0].id]='are / am / is';assert.equal(local.gradeReview(be,student).correct,false,'Different-length slots cannot reorder');
  const get=card('get');assert.deepEqual(get.spellingGroups.find(g=>g.id==='past_participle').accepted,['got','gotten']);
  const partial=answer(get);partial.spellings.past_participle='got';assert.equal(local.gradeReview(get,partial).correct,false);
  partial.spellings.past_participle='got / gotten';assert.equal(local.gradeReview(get,partial).correct,true);
  const far=card('far'),f=answer(far);f.spellings.comparative='further / farther';f.spellings.superlative='furthest / farthest';assert.equal(local.gradeReview(far,f).correct,true);
  for(const word of ['burn','learn']){const c=card(word);assert.equal(c.spellingGroups.length,3);assert.equal(c.spellingGroups[1].shapes.length,2);assert.equal(c.spellingGroups[2].shapes.length,2);
    assert.equal(local.gradeReview(c,answer(c)).correct,true);const partial=answer(c);partial.spellings.past=c.spellingGroups[1].accepted[0];assert.equal(local.gradeReview(c,partial).correct,false);}
  assert.deepEqual(card('craftsperson').spellingGroups[1].accepted,['craftspeople']);assert.deepEqual(card('millennium').spellingGroups[1].accepted,['millennia']);
  assert.equal(card('leaf').spellingGroups.length,1);
  assert.equal(card('life').spellingGroups.length,1);
  assert.ok(!Object.values(require('../lib/ctw-vocabulary/round.ts').FORM_LABELS).some(label=>/式|第一人称|第二人称|情态动词/.test(label)));
});
test('only the three reviewed vocabulary rows change, with repeat-safe SQL and full historical snapshot/progress/membership preservation',async()=>{
  const {source:originalSource}=require('./helpers/ctwVocabularyFixture.cjs');const db=await fixture();try{
    const beforeLifeReview=require('../lib/ctw-vocabulary/spelling-review.ts').applyVocabularySpellingReview(originalSource().rows,
      require('../data/ctw-vocabulary/irregular-spelling-adjustments.json').changes.filter(change=>change.word!=='life'));
    await db.exec(read('outputs/ctw-vocabulary-phase3/ctw-vocabulary-phase3-install.sql'));
    const e=(await db.query("select * from ctw_vocabulary_entries where word='get'")).rows[0],id=randomUUID();
    const original=await store.saveVocabularyAttempt(client(db,'service_role'),U,{attemptId:id,mode:'base_form',source:{kind:'list',listNumber:1},
      answers:[{entryId:e.entry_id,spelling:'get',irregularSpellings:[{formType:'past',spelling:'got'},{formType:'past_participle',spelling:'gotten'}]}]});
    const previous=(await db.query('select * from ctw_vocabulary_entries order by word')).rows;
    const memberships=(await db.query('select * from ctw_vocabulary_cefr_memberships order by entry_id')).rows;
    const progress=(await db.query('select * from student_ctw_vocabulary_list_progress')).rows;
    await db.query("update ctw_vocabulary_entries set irregular_forms=$1::jsonb where word='millennium'",[JSON.stringify([{form_type:'plural',answers:['unexpected']}])]);
    await assert.rejects(db.exec(read('supabase/ctw_vocabulary_american_spelling.sql')),/CTW_SPELLING_REVIEW_DRIFT/);await db.exec('rollback');
    assert.deepEqual((await db.query("select irregular_forms from ctw_vocabulary_entries where word='craftsperson'")).rows[0].irregular_forms,previous.find(e=>e.word==='craftsperson').irregular_forms,'A later drift rolls back the first targeted change');
    await db.query("update ctw_vocabulary_entries set irregular_forms=$1::jsonb where word='millennium'",[JSON.stringify(previous.find(e=>e.word==='millennium').irregular_forms)]);
    await db.exec(read('supabase/ctw_vocabulary_american_spelling.sql'));await db.exec(read('supabase/ctw_vocabulary_american_spelling_verify.sql'));
    const after=(await db.query('select * from ctw_vocabulary_entries order by word')).rows;
    const changed=[];for(let i=0;i<previous.length;i++){
      const {irregular_forms:a,...restA}=previous[i],{irregular_forms:b,...restB}=after[i];assert.deepEqual(restA,restB);
      if(JSON.stringify(a)!==JSON.stringify(b))changed.push(after[i].word);
      assert.deepEqual(b,beforeLifeReview.find(e=>e.word===after[i].word).irregular_forms);
    }
    assert.deepEqual(changed,['craftsperson','leaf','millennium']);
    assert.equal(originalSource().rows.filter(row=>row.irregular_forms.length).length,47);assert.equal(beforeLifeReview.filter(row=>row.irregular_forms.length).length,46);
    assert.deepEqual((await db.query('select * from ctw_vocabulary_cefr_memberships order by entry_id')).rows,memberships);
    assert.deepEqual((await db.query('select * from student_ctw_vocabulary_list_progress')).rows,progress);
    assert.deepEqual(await store.readVocabularyResult(client(db,'authenticated',U),U,id),original);
    const historical=review.legacyCtwReviewRound(original);assert.equal(historical.summary.correct,1,'Old gotten-only result keeps its original grade');
    assert.equal(historical.cards[0].answer.student.spellings.past_participle,'gotten');
    await db.exec(read('supabase/ctw_vocabulary_american_spelling.sql'));assert.deepEqual((await db.query('select * from ctw_vocabulary_entries order by word')).rows,after);
  }finally{await db.close();}
});
test('all-required form rows sync server-side, survive result reads, and wrong-only retry uses today\'s standard without regrading old scores',async()=>{
  const db=await setup();try{
    const row=(await db.query("select * from ctw_vocabulary_entries where word='get'")).rows[0],id=randomUUID();
    await store.saveVocabularyAttempt(client(db,'service_role'),U,{attemptId:id,mode:'base_form',source:{kind:'list',listNumber:1},
      answers:[{entryId:row.entry_id,spelling:'wrong',irregularSpellings:[{formType:'past',spelling:'got'},{formType:'past_participle',spelling:'gotten'}]}]});
    const retry=await create(db,{kind:'list',listNumber:1},U,randomUUID(),id);
    assert.deepEqual(retry.cards[0].spellingGroups.find(g=>g.id==='past_participle').accepted,['got','gotten']);
    let state=local.localReview(U,retry),clock=0;
    const act=async(action,student)=>{const command={id:randomUUID(),itemId:state.round.cards[0].itemId,action,...(student?{answer:student}:{})};
      state=local.applyReviewAction(state,command,clock);await server.syncCtwReview(client(db,'service_role'),U,retry.session.session_id,command);};
    await act('start_test');const partial=answer(retry.cards[0]);partial.spellings.past_participle='got / ';
    await act('answer',partial);assert.equal(state.answers[row.entry_id].correct,false);clock=1000;await act('advance');
    const result=await store.readVocabularyResult(client(db,'authenticated',U),U,retry.session.session_id);
    assert.equal(result.correct_count,0);assert.equal(result.answers[0].irregularResults.find(g=>g.formType==='past_participle').correct,false);
    assert.deepEqual(result.answers[0].irregularResults.find(g=>g.formType==='past_participle').acceptedAnswers,['got','gotten']);
    const next=await create(db,{kind:'list',listNumber:1},U,randomUUID(),retry.session.session_id);await complete(db,next);
    assert.equal((await store.readVocabularyResult(client(db,'authenticated',U),U,next.session.session_id)).correct_count,1);
    assert.equal((await store.readVocabularyResult(client(db,'authenticated',U),U,retry.session.session_id)).correct_count,0);
  }finally{await db.close();}
});
test('v1 migration projects existing separate be inputs and partial variant answers into grouped rows without losing typed text',()=>{
  const entry=word=>({...source().rows.find(e=>e.word===word),entry_id:randomUUID(),list_number:1,list_position:1,source_sha256:'a'.repeat(64)});
  const be=entry('be'),card=review.ctwReviewCard(be,0),raw=be.irregular_forms.map(form=>({formType:form.form_type,spelling:form.answers[0]}));
  const projected=review.ctwLegacyRowValues(card,be,raw);assert.equal(projected.present_first_person_singular,'am / is / are');assert.equal(projected.past_first_or_third_person_singular,'was / were');
  const get=entry('get'),partial=review.ctwLegacyRowValues(review.ctwReviewCard(get,0),get,[{formType:'past',spelling:'got'},{formType:'past_participle',spelling:'gotten'}]);
  assert.equal(partial.past_participle,' / gotten');
});
test('actual shared workspace renders every tested form in study, hides spellings in test, and gives be exactly three tense rows',()=>{
  const ts=require('typescript'),vm=require('node:vm'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const exported={};vm.runInNewContext(ts.transpileModule(read('components/student/WordbookReviewWorkspace.tsx'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,{exports:exported,require:name=>{
      if(name==='react')return{...React,useEffect:()=>{},useLayoutEffect:()=>{}};
      if(name==='react/jsx-runtime')return require(name);
      if(name==='next/link')return props=>React.createElement('a',{href:props.href},props.children);
      if(name.endsWith('.css'))return{};
      if(name.endsWith('wordbookReview'))return require('../lib/lexical/wordbookReview.ts');
      if(name.endsWith('wordbookReviewInput'))return require('../lib/lexical/wordbookReviewInput.ts');
      throw Error('Unexpected dependency '+name);
    }});
  const render=state=>renderToStaticMarkup(React.createElement(exported.WordbookReviewWorkspace,{state,busy:false,onAction:async()=>{},onRetry:()=>{},onReload:()=>{},spellingOnly:true}));
  let reviewed=0;
  for(const row of source().rows){
    const entry={...row,entry_id:randomUUID(),list_number:1,list_position:1,source_sha256:'a'.repeat(64)},round=review.createCtwReviewRound(randomUUID(),{kind:'list',listNumber:1},[entry]);
    let state=local.localReview(U,round);const study=render(local.reviewLocalState(state));
    assert.equal(study.includes('aria-label="不规则变化"'),row.irregular_forms.length>0,row.word);
    for(const group of round.cards[0].spellingGroups.slice(1)){assert.ok(study.includes(group.accepted.join(' / ')),row.word);assert.ok(study.includes(group.label));}
    if(!row.irregular_forms.length)continue;reviewed++;
    state=local.applyReviewAction(state,{id:randomUUID(),itemId:entry.entry_id,action:'start_test'},0);
    const testing=render(local.reviewLocalState(state));
    assert.equal((testing.match(/<input /g)||[]).length,round.cards[0].spellingGroups.reduce((n,g)=>n+(g.requiredAll?g.shapes.length:1),0),row.word);
    for(const group of round.cards[0].spellingGroups.slice(1))for(const answer of group.accepted)assert.ok(!testing.includes('value="'+answer+'"'),row.word);
    if(row.word==='be'){assert.equal((study.match(/<tbody>.*?<\/tbody>/g)||[]).length,1);assert.equal((testing.match(/role="group"/g)||[]).length,4);
      assert.equal((testing.match(/<input /g)||[]).length,7);assert.ok(!/第一人称|第二人称|过去式/.test(study+testing));}
  }
  assert.equal(reviewed,45);
  // take is intentionally NOT added to the real vocabulary. Synthetic UI QA.
  const take={...source().rows.find(e=>e.word==='get'),word:'take',entry_id:randomUUID(),list_number:1,list_position:1,source_sha256:'a'.repeat(64),
    irregular_forms:[{form_type:'past',answers:['took']},{form_type:'past_participle',answers:['taken']}]};
  const round=review.createCtwReviewRound(randomUUID(),{kind:'list',listNumber:1},[take]),html=render(local.reviewLocalState(local.localReview(U,round)));
  assert.ok(html.includes('took'));assert.ok(html.includes('taken'));assert.equal(local.gradeReview(round.cards[0],answer(round.cards[0])).correct,true);
});
test('wrong-word detail uses stronger type and orange student spellings without coloring labels or changing saved answers',()=>{
  const ts=require('typescript'),vm=require('node:vm'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const exported={},mocks={
    'react/jsx-runtime':require('react/jsx-runtime'),
    './WordbookReviewWorkspace':{WordbookReviewResult:({children})=>React.createElement('div',null,children)},
    '@/lib/ctw-vocabulary/review':review,
    '@/lib/ctw-vocabulary/round':require('../lib/ctw-vocabulary/round.ts')
  };
  vm.runInNewContext(ts.transpileModule(read('components/student/CtwVocabularyReviewResult.tsx'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,
    {exports:exported,require:name=>{assert.ok(Object.hasOwn(mocks,name),name);return mocks[name];}});
  const entries=['debate','shape'].map(word=>({...source().rows.find(e=>e.word===word),entry_id:randomUUID(),list_number:1,list_position:1,source_sha256:'a'.repeat(64)}));
  const round=review.createCtwReviewRound(randomUUID(),{kind:'list',listNumber:1},entries);
  round.cards[0].answer=local.gradeReview(round.cards[0],{spellings:{base:'argue'}});
  round.cards[1].answer=local.gradeReview(round.cards[1],{spellings:{base:'shape'}});
  const before=JSON.stringify(round);
  const html=renderToStaticMarkup(React.createElement(exported.CtwVocabularyReviewResult,{round,state:{},onRetry:()=>{}}));
  assert.match(html,/text-sm font-medium leading-relaxed text-student-muted/);
  assert.match(html,/<span class="font-semibold">你的拼写：<\/span><span class="font-semibold text-student-error" data-student-spelling="true">argue<\/span>/);
  assert.match(html,/<span class="font-semibold">正确拼写：<\/span><strong>debate<\/strong>/);
  assert.equal((html.match(/<article /g)||[]).length,1);
  assert.equal(JSON.stringify(round),before);
});
test('regular-form QA scans the entire library, flags life only as a single regular form, and retains approved burn/learn variants',()=>{
  const {source:originalSource}=require('./helpers/ctwVocabularyFixture.cjs'),qa=require('../lib/ctw-vocabulary/spelling-review.ts');
  const changes=require('../data/ctw-vocabulary/irregular-spelling-adjustments.json').changes;
  const before=qa.auditRegularVocabularyForms(qa.applyVocabularySpellingReview(originalSource().rows,changes.filter(change=>change.word!=='life')));
  assert.deepEqual([before.words,before.wordsWithForms,before.formGroups,before.spellings],[1032,46,90,97]);
  assert.deepEqual(before.singleRegularForms.map(f=>[f.word,f.formType,f.answer]),[['life','plural','lives']]);
  const after=qa.auditRegularVocabularyForms(source().rows);
  assert.deepEqual([after.words,after.wordsWithForms,after.formGroups,after.spellings],[1032,45,89,96]);
  assert.deepEqual(after.singleRegularForms,[]);
  assert.deepEqual(after.findings.map(f=>[f.word,f.formType,f.answer,f.decision]),[
    ['burn','past','burned','keep-multiple-variants'],['burn','past_participle','burned','keep-multiple-variants'],
    ['learn','past','learned','keep-multiple-variants'],['learn','past_participle','learned','keep-multiple-variants']]);
});
test('regular-form QA recognizes s/es/d/ed, y-to-i and TPS f/fe rules without stripping genuine irregular forms',()=>{
  const {regularVocabularyInflection:rule}=require('../lib/ctw-vocabulary/spelling-review.ts');
  for(const[word,type,value]of[['cat','plural','cats'],['box','plural','boxes'],['watch','present_third_person_singular','watches'],
    ['library','plural','libraries'],['study','past','studied'],['carry','past_participle','carried'],['live','past','lived'],['walk','past','walked'],
    ['leaf','plural','leaves'],['life','plural','lives'],['stop','past','stopped']])assert.ok(rule(word,type,value),word+':'+value);
  for(const[word,type,value]of[['have','present_third_person_singular','has'],['have','past','had'],['say','past','said'],['lay','past','laid'],
    ['feed','past','fed'],['lead','past','led'],['show','past_participle','shown'],['be','past_participle','been'],['cut','past','cut'],
    ['craftsperson','plural','craftspeople'],['millennium','plural','millennia'],['get','past_participle','gotten'],['good','comparative','better']])assert.equal(rule(word,type,value),null,word+':'+value);
});
test('life-only SQL is guarded and repeat-safe, keeps all other content/history/active snapshots, and new rounds and retry have no plural test',async()=>{
  const db=await setup({lifeFix:false});try{
    const c=client(db,'authenticated',U),e=(await db.query("select * from ctw_vocabulary_entries where word='life'")).rows[0];
    const oldRound=await create(db,{kind:'list',listNumber:1});assert.equal(oldRound.cards.find(c=>c.expected.expression==='life').spellingGroups.length,2);
    const id=randomUUID(),oldResult=await store.saveVocabularyAttempt(client(db,'service_role'),U,{attemptId:id,mode:'base_form',source:{kind:'list',listNumber:1},
      answers:[{entryId:e.entry_id,spelling:'life',irregularSpellings:[{formType:'plural',spelling:'lifes'}]}]});
    const before=(await db.query('select * from ctw_vocabulary_entries order by word')).rows;
    const progress=(await db.query('select * from student_ctw_vocabulary_list_progress order by student_id,edition,cefr_group,list_number')).rows;
    const members=(await db.query('select * from ctw_vocabulary_cefr_memberships order by entry_id')).rows;
    const sessions=(await db.query('select * from student_ctw_vocabulary_review_sessions order by session_id')).rows;
    await db.query("update ctw_vocabulary_entries set irregular_forms=$1::jsonb where word='life'",[JSON.stringify([{form_type:'plural',answers:['unexpected']}])]);
    await assert.rejects(db.exec(read('supabase/ctw_vocabulary_life_regular_form_fix.sql')),/CTW_LIFE_FORM_DRIFT/);await db.exec('rollback');
    await db.query("update ctw_vocabulary_entries set irregular_forms=$1::jsonb where word='life'",[JSON.stringify(e.irregular_forms)]);
    await db.exec(read('supabase/ctw_vocabulary_life_regular_form_fix.sql'));await db.exec(read('supabase/ctw_vocabulary_life_regular_form_verify.sql'));
    const after=(await db.query('select * from ctw_vocabulary_entries order by word')).rows;
    assert.deepEqual(after,before.map(row=>row.word==='life'?{...row,irregular_forms:[]}:row));
    await db.exec(read('supabase/ctw_vocabulary_life_regular_form_fix.sql'));assert.deepEqual((await db.query('select * from ctw_vocabulary_entries order by word')).rows,after);
    assert.deepEqual((await db.query('select * from student_ctw_vocabulary_list_progress order by student_id,edition,cefr_group,list_number')).rows,progress);
    assert.deepEqual((await db.query('select * from ctw_vocabulary_cefr_memberships order by entry_id')).rows,members);
    assert.deepEqual((await db.query('select * from student_ctw_vocabulary_review_sessions order by session_id')).rows,sessions);
    assert.deepEqual(await store.readVocabularyResult(c,U,id),oldResult);
    const historical=await server.readCtwReview(c,U,id);assert.equal(historical.summary.incorrect,1);assert.deepEqual(historical.cards[0].spellingGroups[1].accepted,['lives']);
    const next=await create(db,{kind:'list',listNumber:1});const life=next.cards.find(card=>card.expected.expression==='life');
    assert.equal(life.spellingGroups.length,1);assert.deepEqual(life.studySenses.map(s=>s.meaning),e.senses.map(s=>s.meaning_zh));
    assert.deepEqual(life.studySenses.map(s=>s.example),e.senses.map(s=>s.example_en));assert.equal(local.gradeReview(life,{spellings:{base:'life'}}).correct,true);
    const retry=await create(db,{kind:'list',listNumber:1},U,randomUUID(),id);assert.equal(retry.cards.length,1);assert.equal(retry.cards[0].spellingGroups.length,1);
    await complete(db,retry);assert.equal((await store.readVocabularyResult(c,U,retry.session.session_id)).correct_count,1);
    assert.deepEqual(await store.readVocabularyResult(c,U,id),oldResult);
  }finally{await db.close();}
});
