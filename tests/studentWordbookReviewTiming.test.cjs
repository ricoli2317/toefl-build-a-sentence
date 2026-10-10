const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {gradeReview,normalizeReviewSpelling,localReview,reviewLocalState,applyReviewAction,readLocalReview,saveLocalReview,acknowledgeReview}=require('../lib/lexical/wordbookReviewLocal.ts');
const {reviewExample}=require('../lib/lexical/wordbookReviewPresentation.ts');
const {fetchReview,ReviewRequestError}=require('../lib/lexical/wordbookReviewRequest.ts');
const h=require('./helpers/wordbookFixedPoolFixture.cjs');
const {readReviewRound}=require('../lib/lexical/wordbookReviewRound.server.ts');
const fixtureRound=()=>({session:{session_id:'round',domain:'reading',total:2,answered:0,status:'active'},summary:{},composition:{spellingPos:1,meaningChoice:1},flow:{phase:'study',position:1},cards:[
  {itemId:'one',position:1,kind:'spelling_pos',sourceTypes:['ctw'],prompt:'产量',options:[{id:'noun',label:'n.'},{id:'verb',label:'v.'}],targetForms:['yield','yields'],expected:{expression:'yield',pos:'noun',standardPos:'noun',meaning:'产量',definitionEn:null,correctOptionId:null,examples:[{text:'Crop yields improve.',kind:'sentence'}]}},
  {itemId:'two',position:2,kind:'meaning_choice',sourceTypes:['rap'],prompt:'harvest',options:[{id:'correct',text:'收获'},{id:'wrong',text:'变化'}],targetForms:['harvest'],expected:{expression:'harvest',pos:'noun',standardPos:'noun',meaning:'收获',definitionEn:null,correctOptionId:'correct',examples:[]}}
]});
const cmd=(action,itemId='one',answer)=>({id:h.uuid(),action,itemId,...(answer?{answer}:{})});
test('local correctness is immediate, independent for spelling/POS; blanks and choice follow existing rules',()=>{
  const [spelling,choice]=fixtureRound().cards;
  for(const [answer,sc,pc] of [[{spelling:' YIELD\n',pos:'noun'},true,true],[{spelling:'yield',pos:'verb'},true,false],[{spelling:'yields',pos:'noun'},false,true],[{spelling:'',pos:''},false,false]]){
    const a=gradeReview(spelling,answer);assert.deepEqual(a.assessments,{spelling:sc,pos:pc});assert.equal(a.correct,sc&&pc);assert.deepEqual(a.student,answer);
  }
  assert.equal(gradeReview(choice,{optionId:'correct'}).correct,true);assert.equal(gradeReview(choice,{optionId:'wrong'}).correct,false);assert.equal(gradeReview(choice,{optionId:''}).correct,false);
  assert.equal(normalizeReviewSpelling('  TAKE\t\nCARE '),'take care');assert.notEqual(normalizeReviewSpelling('take-care'),'take care');
});
test('local next/result are gated only by click+1000ms, not by pending HTTP acknowledgements',()=>{
  let local=localReview('alice',fixtureRound());local=applyReviewAction(local,cmd('start_test'));
  local=applyReviewAction(local,cmd('answer','one',{spelling:'yield',pos:'noun'}),10000);
  assert.equal(reviewLocalState(local).item.answer.correct,true);assert.equal(local.confirmed,0);
  const next=cmd('advance');assert.equal(applyReviewAction(local,next,10999),local);
  local=applyReviewAction(local,next,11000);assert.equal(local.position,2);assert.equal(local.queue.length,3);assert.equal(local.confirmed,0);
  local=applyReviewAction(local,cmd('answer','two',{optionId:'correct'}),12000);
  local=applyReviewAction(local,cmd('advance','two'),13000);assert.equal(local.phase,'result');assert.equal(reviewLocalState(local).summary.correct,2);assert.equal(local.confirmed,0);
});
test('wrong feedback survives reload and never automatically advances; stale/double actions cannot skip or regrade',()=>{
  let local=applyReviewAction(localReview('alice',fixtureRound()),cmd('start_test'));
  const answer=cmd('answer','one',{spelling:'',pos:''});local=applyReviewAction(local,answer,1000);
  assert.equal(applyReviewAction(local,answer,10000),local);assert.equal(local.position,1);assert.equal(local.deadlines.one,undefined);
  const storage=new Map(),adapter={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  saveLocalReview(adapter,local);local=readLocalReview(adapter,'alice','round');assert.equal(reviewLocalState(local).item.answer.correct,false);
  local=applyReviewAction(local,cmd('advance'),10000);assert.equal(local.position,2);assert.equal(applyReviewAction(local,cmd('advance'),10001),local);
  assert.equal(readLocalReview(adapter,'bob','round'),null);assert.equal(readLocalReview(adapter,'alice','different-round'),null);
});
test('acks merge with newer pending actions, are idempotent, preserve order and never mark unacknowledged work saved',()=>{
  let local=localReview('alice',fixtureRound()),start=cmd('start_test');local=applyReviewAction(local,start);
  const answer=cmd('answer','one',{spelling:'yield',pos:'noun'});local=applyReviewAction(local,answer,1000);const advance=cmd('advance');local=applyReviewAction(local,advance,2000);
  local=acknowledgeReview(local,start);assert.deepEqual(local.queue.map(c=>c.id),[answer.id,advance.id]);assert.equal(local.confirmed,0);
  local=acknowledgeReview(local,answer);assert.equal(local.confirmed,1);assert.deepEqual(local.queue,[advance]);assert.equal(acknowledgeReview(local,answer),local);
});
test('refresh during correct feedback keeps the original click deadline and never resubmits/restarts a second timer',()=>{
  let local=applyReviewAction(localReview('alice',fixtureRound()),cmd('start_test'));
  local=applyReviewAction(local,cmd('answer','one',{spelling:'yield',pos:'noun'}),10000);
  const storage=new Map(),adapter={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
  saveLocalReview(adapter,local);const restored=readLocalReview(adapter,'alice','round');
  assert.equal(restored.deadlines.one,11000);assert.equal(restored.queue.filter(c=>c.action==='answer').length,1);
  assert.equal(applyReviewAction(restored,cmd('advance'),10999),restored);
  assert.equal(applyReviewAction(restored,cmd('advance'),11000).position,2);
  assert.equal(applyReviewAction(restored,cmd('advance'),20000).position,2);
});
test('storage/quota/corrupt records fail visibly rather than publishing an unrecoverable answer',()=>{
  assert.throws(()=>saveLocalReview({setItem(){throw Error('quota');}},localReview('alice',fixtureRound())),/未确认/);
  assert.throws(()=>readLocalReview({getItem:()=>'{bad'},'alice','round'));
  assert.throws(()=>readLocalReview({getItem:()=>JSON.stringify({version:1,owner:'bob'})},'alice','round'),/无法读取/);
});
test('yield / yields uses the actual saved source surface and intact example, never changes grading to accept yields',()=>{
  const local=localReview('alice',fixtureRound()),example=reviewLocalState(local).item.example;
  assert.equal(example.map(p=>p.text).join(''),'Crop yields improve.');assert.equal(example.find(p=>p.target).text,'yields');
  local.phase='test';const masked=reviewLocalState(local).item.example;assert.equal(masked.filter(p=>p.target).length,1);assert.equal(masked.find(p=>p.target).text,'');
  assert.deepEqual(reviewExample('An intact saved fragment.','missing',false),[{text:'An intact saved fragment.'}]);
});
test('Safari Load failed is preserved as transport cause, timeout/upstream retryable; business/auth errors are not hidden',async t=>{
  const error=new TypeError('Load failed');t.mock.method(globalThis,'fetch',async()=>{throw error;});
  await assert.rejects(fetchReview('/review','fixture-token',{action:'sync'}),e=>e instanceof ReviewRequestError&&e.code==='REVIEW_NETWORK'&&e.cause===error&&e.retryable&&/自动重试/.test(e.message));
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'请重新登录',code:'AUTH'}),{status:401});
  await assert.rejects(fetchReview('/review','fixture-token'),e=>e.status===401&&!e.retryable&&e.message==='请重新登录');
});
test('local UI feedback/colors/caret/keyboard and settings are scoped, no verdict icons or focused rectangle',()=>{
  const ui=fs.readFileSync('components/student/WordbookReviewWorkspace.tsx','utf8'),css=fs.readFileSync('components/student/WordbookReviewWorkspace.module.css','utf8'),hook=fs.readFileSync('components/student/useWordbookLocalReview.ts','utf8');
  assert.doesNotMatch(ui,/lucide-react|text-green-600|text-red-600|focus-within:ring/);assert.match(ui,/data-caret/);assert.match(css,/outline: 0/);assert.match(ui,/items-center justify-center/);
  assert.match(ui,/overflow-x-hidden/);assert.match(ui,/focusin/);assert.match(ui,/FitContent keyboard/);assert.match(hook,/localStorage/);assert.match(hook,/"online"/);
  assert.doesNotMatch(fs.readFileSync('app/student/wordbook/review/page.tsx','utf8'),/StudentPage/);
  assert.match(fs.readFileSync('components/student/StudentWordbook.module.css','utf8'),/\.table td \{[^}]*vertical-align: middle/);
});
test('transient GET transport failures retry once; pending writes are not blindly replayed by fetch',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{if(++calls===1)throw new TypeError('Load failed');return new Response(JSON.stringify({ok:true}));});
  assert.deepEqual(await fetchReview('/review','fixture-token'),{ok:true});assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('Load failed');};
  await assert.rejects(fetchReview('/review','fixture-token',{action:'sync'}),e=>e.code==='REVIEW_NETWORK');assert.equal(calls,1);
});
test('POS7 local independent grading covers every fixed option; saved completed legacy study cursors show results',()=>{
  const round=fixtureRound();for(const pos of ['noun','verb','adjective','adverb','preposition','conjunction','pronoun']){
    const card={...round.cards[0],expected:{...round.cards[0].expected,pos}};
    assert.equal(gradeReview(card,{spelling:'yield',pos}).correct,true);
    assert.equal(gradeReview(card,{spelling:'yield',pos:''}).assessments.pos,false);
  }
  round.session.status='completed';assert.equal(localReview('alice',round).phase,'result');
});
test('new authorized full-round projection and sync replay use real isolated SQL, preserve fixed snapshots/score/ownership',
 {skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},async()=>{
 const db=await h.fixture();try{
  await db.exec(h.read('supabase/student_wordbook_review_v1_immersive_migration.sql'));await h.pool(db);
  await h.save(db,{expression:'yield',pos:'noun',meaning:'产量',example:false});
  const occurrence=h.uuid();
  await db.query("update lexical_occurrences set occurrence_id=$2,surface_text='yields',context_text='Crop yields improve.',start_offset=5,end_offset=11 where occurrence_id=$1",[h.O,occurrence]);
  const payload=await h.payload(db,occurrence);await db.query('select operate_student_wordbook_v1($1,$2,$3,$4::jsonb)',[h.U,occurrence,'save',JSON.stringify(payload)]);
  const created=await h.create(db),client=require('./helpers/wordbookReviewApiFixture.cjs').client(db);
  const round=await readReviewRound(client,h.U,created.session.session_id);assert.equal(round.cards.length,1);assert.equal(round.cards[0].expected.meaning,'产量');assert.ok(round.cards[0].targetForms.includes('yields'));
  const local=localReview(h.U,round);assert.ok(reviewLocalState(local).item.example);await assert.rejects(readReviewRound(client,h.V,created.session.session_id),e=>e.status===404);
  // SQL normalization exact comparison, including POSIX Unicode whitespace,
  // punctuation and ASCII/NFKC edge cases; original SQL is NOT modified.
  for(const spelling of ['yield',' YIELD\n','yields','yield.','ＹＩＥＬＤ','\u00a0yield','\u0085yield\u0085','\u2007yield','\u2000yield\u2000','İ','ΟΣ','ẞ','K','𐐀','']){
    const normalized=(await db.query('select wordbook_review_spelling($1) v',[spelling])).rows[0].v;assert.equal(normalizeReviewSpelling(spelling),normalized,JSON.stringify(spelling));
    const expected=gradeReview(round.cards[0],{spelling,pos:'noun'});
    const assessment=(await db.query('select wordbook_review_spelling($1)=wordbook_review_spelling($2) sc',[spelling,'yield'])).rows[0].sc;assert.equal(expected.assessments.spelling,assessment);
  }
  const ts=require('typescript'),vm=require('node:vm');let user=h.U;const exports={};
  vm.runInNewContext(ts.transpileModule(h.read('app/api/student/wordbook/review/[sessionId]/route.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL,Array,require(name){
   if(name.includes('attemptServer'))return {requireReadingAttemptStudent:async()=>({userId:user}),readingAttemptJson:(body,init)=>({body,status:init?.status??200})};
   if(name.includes('supabase/server'))return {createServiceSupabase:()=>client};
   if(name.endsWith('wordbookReviewRound.server'))return require('../lib/lexical/wordbookReviewRound.server.ts');
   if(name.endsWith('wordbookReview.server'))return require('../lib/lexical/wordbookReview.server.ts');
   if(name.endsWith('wordbookReviewPresentation'))return require('../lib/lexical/wordbookReviewPresentation.ts');
   if(name.endsWith('wordbookReview'))return require('../lib/lexical/wordbookReview.ts');throw Error(name);
  }});
  const context={params:{sessionId:round.session.session_id}},send=async command=>exports.POST(new Request('https://offline.invalid',{method:'POST',body:JSON.stringify({action:'sync',command})}),context);
  for(const command of [cmd('start_test',round.cards[0].itemId),cmd('answer',round.cards[0].itemId,{spelling:'yield',pos:'noun'}),cmd('advance',round.cards[0].itemId)]){
   assert.equal((await send(command)).status,200);assert.equal((await send(command)).status,200); // response loss / replay
  }
  assert.equal((await db.query('select count(*)::int n from student_wordbook_review_answers')).rows[0].n,1);
  assert.equal((await readReviewRound(client,h.U,round.session.session_id)).flow.phase,'result');
  assert.equal((await send(cmd('answer',round.cards[0].itemId,{spelling:'wrong',pos:'noun'}))).status,409);
  user=h.V;assert.equal((await send(cmd('answer',round.cards[0].itemId,{spelling:'yield',pos:'noun'}))).status,404);
 }finally{await db.close();}
});
