const test = require('node:test');
const assert = require('node:assert/strict');
const { readingSessionActivity, acquireReadingSessionWrite, readReadingSessionPractice } = require('../lib/reading/sessionExperience.ts');
const { loadCategoryCompletedReview, loadWrongbookCompletedReview, resolveSessionReviewBundle,
  restoreSessionReviewMaterials, sessionReviewBundleCacheKey, sessionReviewPracticeCacheKey } = require('../lib/reading/sessionReviewBundle.ts');

const auth = { studentId: 'synthetic-student', accessToken: 'offline' };
function memoryCache() {
  const entries = new Map();
  return { entries, getEntry: key => entries.get(key), setData(key, data) { entries.set(key, { status: 'success', data }); },
    async load(key, loader) {
      const old = entries.get(key);
      if (old?.status === 'success') return old.data;
      if (old?.status === 'loading') return old.promise;
      const promise = loader(auth); entries.set(key, { status: 'loading', promise });
      try { const data = await promise; entries.set(key, { status: 'success', data }); return data; }
      catch (error) { entries.set(key, { status: 'error' }); throw error; }
    } };
}
function fixture(kind, mode = 'history') {
  const practices = ['A','B','C'].map((id, index) => ({ item: { itemId: id, module: 'rap', title: id, questionCount: index === 0 ? 2 : 1, scoringPointCount: index === 0 ? 2 : 1 },
    material: null, passage: { title: id, paragraphs: [{ text: `Passage ${id}`, sentences: [] }] },
    questions: Array.from({length: index === 0 ? 2 : 1}, (_, q) => ({ questionId: `${id}-${q}`, questionOrder: q+1,
      questionType: 'rap_multiple_choice', stem: `${id} stem ${q}`, options: [{optionId:`${id}-${q}-good`,text:'good'},{optionId:`${id}-${q}-bad`,text:'bad'}] })) }));
  const groups = practices.map(p => ({ logicalItemId:p.item.itemId,title:p.item.title,targets:p.questions.map(q=>({questionId:q.questionId,slotId:null})) }));
  const answers = practices.flatMap(p => p.questions.map(q => ({answerId:`answer-${q.questionId}`,questionId:q.questionId,logicalItemId:p.item.itemId,
    answerKind:'option',studentAnswer:`${q.questionId}-bad`,isCorrect:false,questionTimeSeconds:3})));
  const disclosures = Object.fromEntries(answers.map(a=>[a.answerId,{studentAnswer:'B. bad',correctAnswer:{kind:'text',text:'A. good'},
    reviewState:{kind:'choice',studentAnswerId:a.studentAnswer,correctAnswerId:`${a.questionId}-good`}}]));
  const session = {sessionId:'s',questionCategory:'推断题',taskType:'rap',mode,amount:5,groups,status:'completed',elapsedSeconds:20,
    createdAt:'2026-10-07T00:00:00Z',completedAt:'2026-10-07T00:01:00Z',draft:{},progress:Object.fromEntries(groups.map(g=>[g.logicalItemId,{attemptId:`attempt-${g.logicalItemId}`,elapsedSeconds:5}]))};
  const requests = [];
  const fetcher = async url => {
    requests.push(url);let body;
    if (url.startsWith('/api/reading/practice/')) body={practice:practices.find(p=>p.item.itemId===url.split('/').pop())};
    else if(url.startsWith('/api/reading/question-category/')) body={session,answers,disclosures};
    else if(url.startsWith('/api/wrong-questions/sessions/')) body={session};
    else if(url.endsWith('/result?review=1')) {
      const group=groups.find(g=>url.includes(`attempt-${g.logicalItemId}/`));
      const rows=answers.filter(a=>a.logicalItemId===group.logicalItemId).map(a=>({attempt_answer_id:a.answerId,question_id:a.questionId,slot_id:null,
        student_answer:a.studentAnswer,is_correct:a.isCorrect,answer_kind:a.answerKind,question_time_seconds:a.questionTimeSeconds}));
      body={attempt:{attemptId:`attempt-${group.logicalItemId}`,elapsedSeconds:5,totalPoints:rows.length,correctPoints:0},
        answers:rows.map(r=>({answerId:r.attempt_answer_id,isAnswered:true,isCorrect:false,questionTimeSeconds:3})),
        review:{correctionRows:rows,preservedRows:[],contextAnswers:[],disclosures}};
    } else throw Error('Unexpected request '+url);
    return {ok:true,json:async()=>body};
  };
  const load = (cache) => kind==='category' ? loadCategoryCompletedReview('s',cache,auth) : loadWrongbookCompletedReview('s',cache,auth);
  return { practices, groups, answers, disclosures, session, requests, fetcher, load };
}
async function withFixture(kind, fn) {
  const f=fixture(kind),old=global.fetch;global.fetch=f.fetcher;
  try { await fn(f); } finally {global.fetch=old;}
}

test('normal source save / Previous flush locks navigation but never hides material', () => {
  assert.deepEqual(readingSessionActivity(false,true,false),{pending:false,navigationDisabled:true});
  assert.deepEqual(readingSessionActivity(false,false,false),{pending:false,navigationDisabled:false});
});
test('genuine material miss and finalization keep pending and disabled navigation', () => {
  assert.deepEqual(readingSessionActivity(true,false,false),{pending:true,navigationDisabled:true});
  assert.deepEqual(readingSessionActivity(false,true,true),{pending:true,navigationDisabled:true});
});
test('same-turn duplicate source/final writes are blocked, failed write can retry, completed stays frozen', () => {
  const lock={current:false};assert.equal(acquireReadingSessionWrite(lock,false),true);
  assert.equal(acquireReadingSessionWrite(lock,false),false);lock.current=false;
  assert.equal(acquireReadingSessionWrite(lock,false),true);lock.current=false;
  assert.equal(acquireReadingSessionWrite(lock,true),false);
});
for (const kind of ['category','wrongbook']) {
  test(`${kind}: result builds complete metadata from existing material; any review navigation is zero-fetch`, async () => withFixture(kind,async f=>{
    const cache=memoryCache();for(const practice of f.practices)cache.setData(sessionReviewPracticeCacheKey(kind,practice.item.itemId),{practice});
    const complete=await cache.load(sessionReviewBundleCacheKey(kind,'s'),()=>f.load(cache));
    assert.equal(f.requests.filter(url=>url.startsWith('/api/reading/practice')).length,0);
    assert.equal(f.requests.some(url=>url.includes('/review')||url.includes('/groups/')),false);
    assert.equal(f.requests.filter(url=>url.includes('?review=1')).length,kind==='category'?1:3);
    const before=f.requests.length;
    for(const index of [0,1,2,3,0]) {
      const reused=await cache.load(sessionReviewBundleCacheKey(kind,'s'),()=>f.load(cache));assert.equal(reused,complete);
      const rendered=resolveSessionReviewBundle(reused.bundle,cache,index=>`/questions/${index}`);
      const item=rendered.reviewItems[index];assert.equal(item.placeholder,undefined);
      assert.equal(item.isCorrect,false);assert.equal(rendered.disclosures[item.answerId].reviewState.kind,'choice');
      const source=rendered.occurrences.find(o=>o.occurrenceId===item.occurrenceId);
      assert.equal(source.answers[item.questionId].optionId,`${item.questionId}-bad`);
      assert.equal(source.practice.passage,f.practices.find(p=>p.item.itemId===source.occurrenceId).passage);
    }
    assert.equal(f.requests.length,before);
    assert.equal(complete.bundle.sources.some(source=>'practice' in source),false,'bundle stores practice keys, not duplicate materials');
  }));
  test(`${kind}: hard refresh recovers the WHOLE session once; A/B/C/A makes no requests`,async()=>withFixture(kind,async f=>{
    const cache=memoryCache(),key=sessionReviewBundleCacheKey(kind,'s');
    const [first,second]=await Promise.all([cache.load(key,()=>f.load(cache)),cache.load(key,()=>f.load(cache))]);
    assert.equal(first,second);assert.equal(first.bundle.sources.length,3);
    assert.equal(f.requests.filter(url=>url.startsWith('/api/reading/practice/')).length,3);
    const before=f.requests.length;
    for(const index of [3,0,1,2,3,0])assert.ok(resolveSessionReviewBundle(first.bundle,cache,i=>`/${i}`).reviewItems[index]);
    assert.equal(f.requests.length,before);
  }));
  test(`${kind}: missing one material downloads only that source at result, preserving shared cache identity`,async()=>withFixture(kind,async f=>{
    const cache=memoryCache();for(const practice of f.practices.slice(0,2))cache.setData(sessionReviewPracticeCacheKey(kind,practice.item.itemId),{practice});
    await f.load(cache);assert.deepEqual(f.requests.filter(url=>url.startsWith('/api/reading/practice/')),['/api/reading/practice/C']);
    assert.equal(readReadingSessionPractice(cache,sessionReviewPracticeCacheKey(kind,'A')),f.practices[0]);
  }));
  test(`${kind}: incomplete final metadata rejects; a result must never expose question links prematurely`,async()=>withFixture(kind,async f=>{
    delete f.disclosures['answer-A-0'];const cache=memoryCache();
    await assert.rejects(f.load(cache),/详情不完整/);
  }));
}
test('wrongbook CTW preserved/context rows fill only neutral slots; targets and numbering stay exact',async()=>{
  const old=global.fetch,cache=memoryCache();
  const practice={item:{itemId:'CTW',module:'ctw',questionCount:1,scoringPointCount:3},questions:[{questionId:'q',questionType:'ctw',slots:[1,2,3].map(i=>({slotId:`s${i}`,slotOrder:i,missingLength:3}))}]};
  cache.setData(sessionReviewPracticeCacheKey('wrongbook','CTW'),{practice});
  const session={sessionId:'s',status:'completed',taskType:'ctw',mode:'history',elapsedSeconds:7,groups:[{logicalItemId:'CTW',targets:[{questionId:'q',slotId:'s2'}]}],progress:{CTW:{attemptId:'a'}}};
  const row=(id,slot,text)=>({attempt_answer_id:id,question_id:'q',slot_id:slot,student_answer:text,answer_kind:'ctw_slot',is_correct:false});
  global.fetch=async url=>({ok:true,json:async()=>url.includes('/sessions/')?{session}:{attempt:{attemptId:'a',elapsedSeconds:7},answers:[],review:{
    correctionRows:[row('target','s2',null)],preservedRows:[row('preserved','s1','one')],contextAnswers:[{questionId:'q',slotId:'s1',text:'bad'},{questionId:'q',slotId:'s3',text:'ctx'}],
    disclosures:{target:{correctAnswer:{kind:'ctw_word',parts:[]},studentAnswer:'未作答'}}}}});
  try {const complete=await loadWrongbookCompletedReview('s',cache,auth),rendered=resolveSessionReviewBundle(complete.bundle,cache,i=>`/${i}`);
    assert.equal(rendered.reviewItems.length,1);assert.equal(rendered.reviewItems[0].slotId,'s2');
    assert.deepEqual(rendered.occurrences[0].answers.q.slots,{s1:['o','n','e'],s2:['','',''],s3:['c','t','x']});
  } finally {global.fetch=old;}
});
test('stale shared material is usable synchronously; loading/error is a genuine miss',()=>{
  const cache=memoryCache(),practice={item:{itemId:'A'}};
  for(const status of ['success','stale','refreshing']){cache.entries.set('A',{status,data:{practice}});assert.equal(readReadingSessionPractice(cache,'A'),practice);}
  for(const status of ['loading','error']){cache.entries.set('A',{status,data:{practice}});assert.equal(readReadingSessionPractice(cache,'A'),null);}
});

test('evicted material with surviving bundle recovers only the missing practice; metadata remains authoritative',async()=>withFixture('category',async f=>{
  const cache=memoryCache(),complete=await f.load(cache);cache.entries.delete(sessionReviewPracticeCacheKey('category','B'));
  const before=f.requests.length;await restoreSessionReviewMaterials(complete.bundle,cache);
  assert.deepEqual(f.requests.slice(before),['/api/reading/practice/B']);
  assert.equal(resolveSessionReviewBundle(complete.bundle,cache,i=>`/${i}`).reviewItems.length,4);
}));

// Execute the real TSX components with deterministic hook/cache boundaries.
// This tests adapter decisions and first-render props, not source-string spelling.
function component(relativePath, cache, cachedData) {
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
  const root=path.resolve(__dirname,'..'),exports={};
  const code=ts.transpileModule(fs.readFileSync(path.join(root,relativePath),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const refs=[];
  const hooks={createContext:()=>({Provider:'CacheProvider'}),useRef:current=>{const ref={current};refs.push(ref);return ref;},useState:value=>[typeof value==='function'?value():value,()=>{}],useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:()=>{}};
  const mockRequire=name=>{
    if(name==='react')return hooks;
    if(name==='next/navigation')return {useRouter:()=>({push:()=>{},replace:()=>{}})};
    if(name==='@/components/StudentDataCache')return {useStudentDataCache:()=>cache,useStudentCachedData:()=>({data:cachedData,error:'',loading:!cachedData}),studentWrongQuestionsCacheKey:s=>`wrong-questions:${s}`};
    if(name==='./ReadingMultiSourceSessionRunner')return {ReadingMultiSourceSessionRunner:'Runner',ReadingSessionMessage:'Message'};
    if(name==='./ReadingPractice')return {ReadingFullSetReviewShell:'ReviewShell',ReadingPracticeMessage:'Message',ReadingPracticeShell:'PracticeShell'};
    if(name==='@/lib/studentCacheEvents')return {invalidateStudentWrongbook:()=>{}};
    if(name==='@/lib/supabase/client')return {createBrowserSupabase:()=>{throw Error('Auth effects must stay offline in this test');}};
    if(name.startsWith('@/lib/'))return require(path.join(root,name.slice(2)+'.ts'));
    return require(name);
  };
  vm.runInNewContext(code,{exports,require:mockRequire,Date,URLSearchParams,sessionStorage:{getItem:()=>null}});
  exports.hookRefs=refs;
  return exports;
}
test('actual business adapters keep category active editable and wrongbook submitted readonly',()=>{
  const f=fixture('category'),cache=memoryCache(),data={session:{...f.session,status:'active'},answers:[]};
  const {QuestionCategoryPractice}=component('components/reading/QuestionCategoryPractice.tsx',cache,data);
  const category=QuestionCategoryPractice({sessionId:'s'}).props.adapter;
  assert.equal(category.isSourceEditable({attempt:{status:'submitted'}},{status:'active'}),true);
  assert.equal(category.isSourceEditable({attempt:{status:'draft'}},{status:'completed'}),false);
  const {ReadingWrongbookBankPractice}=component('components/reading/ReadingWrongbookBankPractice.tsx',cache,data);
  const parent=ReadingWrongbookBankPractice({mode:'history',sessionId:'s',taskType:'rap'});
  const wrongbook=parent.type(parent.props).props.adapter;
  assert.equal(wrongbook.isSourceEditable({attempt:{status:'submitted'}},{status:'active'}),false);
  assert.equal(wrongbook.isSourceEditable({attempt:{status:'draft'}},{status:'active'}),true);
});
for(const kind of ['category','wrongbook'])test(`${kind}: actual review component first render contains material, student state, and disclosure without loaders`,async()=>withFixture(kind,async f=>{
  const cache=memoryCache(),complete=await f.load(cache),before=f.requests.length;
  const {ReadingSessionBundleReview}=component('components/reading/ReadingSessionBundleReview.tsx',cache,complete);
  const first=ReadingSessionBundleReview({kind,sessionId:'s',initialReviewIndex:2,returnTo:'/student/practice-history'});
  assert.equal(first.type,'ReviewShell');assert.equal(first.props.initialSourceAnswerIndex,2);
  assert.equal(first.props.payload.occurrences.length,3);assert.equal(first.props.payload.reviewItems[2].questionId,'B-0');
  assert.equal(first.props.payload.disclosures['answer-B-0'].reviewState.correctAnswerId,'B-0-good');
  assert.equal(first.props.payload.occurrences[1].answers['B-0'].optionId,'B-0-bad');assert.equal(f.requests.length,before);
  assert.equal(first.props.onRequestItem,undefined);
}));

test('actual StudentDataCache progress invalidation retains material and coalesces whole-bundle recovery',async()=>withFixture('category',async f=>{
  const provider=component('components/StudentDataCache.tsx',null,null);
  const value=provider.StudentDataCacheProvider({children:null}).props.value;
  provider.hookRefs[3].current=auth;
  value.setData('wrong-questions:reading-correction-practice:A',{practice:f.practices[0]});
  value.setData('wrong-questions:reading-bank-result:old',{session:f.session});
  value.markStale('wrong-questions');
  assert.equal(value.getEntry('wrong-questions:reading-correction-practice:A').status,'success');
  assert.equal(value.getEntry('wrong-questions:reading-bank-result:old').status,'stale');
  const key=sessionReviewBundleCacheKey('category','s');
  const [first,second]=await Promise.all([value.load(key,()=>f.load(value)),value.load(key,()=>f.load(value))]);
  assert.equal(first,second);assert.equal(f.requests.filter(url=>url.endsWith('?review=1')).length,1);
  assert.equal(value.getEntry(key).status,'success');
  assert.equal(resolveSessionReviewBundle(first.bundle,value,i=>`/${i}`).reviewItems.length,4);
}));
