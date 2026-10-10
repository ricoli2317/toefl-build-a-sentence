const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {prepareReviewAdvance,waitForReviewSwitch,REVIEW_SWITCH_DELAY,readReviewSwitch,saveReviewSwitch,clearReviewSwitch}=require('../lib/lexical/wordbookReviewTiming.ts');
const flush=async()=>{for(let n=0;n<6;n++)await Promise.resolve();};
const browserStorage=(t,sessionStorage)=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{sessionStorage}});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;});
};

test('prepare starts at server confirmation, fast data stays buffered until 1000ms from CLICK (not confirmation)',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:10000});
  const published=[],prepared=[],abort=new AbortController(),state={item:{itemId:'next'}};
  const clickedAt=Date.now(),deadline=clickedAt+REVIEW_SWITCH_DELAY;
  t.mock.timers.tick(300); // answer request took 300ms
  const result=prepareReviewAdvance(()=>{prepared.push(Date.now());return new Promise(resolve=>setTimeout(()=>resolve(state),250));},deadline,abort.signal,s=>published.push({state:s,at:Date.now()}));
  assert.deepEqual(prepared,[10300]); // starts immediately, NOT at 11000 or 11300
  t.mock.timers.tick(250);await flush();assert.equal(published.length,0);
  t.mock.timers.tick(449);await flush();assert.equal(published.length,0);
  t.mock.timers.tick(1);await result;assert.deepEqual(published,[{state,at:11000}]);
});

test('slow data publishes once ready with NO extra delay, including last-item result data',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:20000});
  const abort=new AbortController(),published=[],state={flow:{phase:'result'}};
  t.mock.timers.tick(450);
  const result=prepareReviewAdvance(()=>new Promise(resolve=>setTimeout(()=>resolve(state),950)),21000,abort.signal,s=>published.push({state:s,at:Date.now()}));
  t.mock.timers.tick(550);await flush();assert.equal(published.length,0); // 1s passed, data NOT ready
  t.mock.timers.tick(400);await result;assert.deepEqual(published,[{state,at:21400}]);
});

test('refresh uses the original deadline; a finished deadline never starts another 1s timer',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:30500});
  const abort=new AbortController();let ready=false;
  const restored=waitForReviewSwitch(31000,abort.signal).then(value=>{ready=value;});
  t.mock.timers.tick(499);await flush();assert.equal(ready,false);
  t.mock.timers.tick(1);await restored;assert.equal(ready,true);
  assert.equal(await waitForReviewSwitch(30000,abort.signal),true);
});

test('unmount/owner change cancels a buffered publication and clears its timer',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:40000});
  const abort=new AbortController(),published=[];
  const result=prepareReviewAdvance(async()=>({item:{itemId:'old-owner'}}),41000,abort.signal,s=>published.push(s));
  await flush();abort.abort();await result;t.mock.timers.tick(1000);await flush();assert.deepEqual(published,[]);
});

test('cancel before request completion ignores late data; failed preparation never publishes guessed data',async()=>{
  const abort=new AbortController(),published=[];let resolve;
  const result=prepareReviewAdvance(()=>new Promise(r=>{resolve=r;}),Date.now()+1000,abort.signal,s=>published.push(s));
  abort.abort();resolve({item:{itemId:'late'}});await result;assert.deepEqual(published,[]);
  await assert.rejects(prepareReviewAdvance(async()=>{throw new Error('network failure');},Date.now(),new AbortController().signal,s=>published.push(s)),/network failure/);
  assert.deepEqual(published,[]);
});

test('UI has a same-size disabled correct waiting button; only the controller handles auto-advance',()=>{
  const workspace=fs.readFileSync('components/student/WordbookReviewWorkspace.tsx','utf8'),controller=fs.readFileSync('components/student/WordbookReview.tsx','utf8');
  assert.match(workspace,/disabled=\{busy \|\| Boolean\(item\.answer\?\.correct\)\}/);
  assert.match(workspace,/student-button-primary h-11 w-full/);assert.match(workspace,/即将查看结果/);assert.match(workspace,/即将进入下一题/);
  assert.doesNotMatch(workspace,/setTimeout|actionRef/);
  assert.match(controller,/Date\.now\(\) \+ REVIEW_SWITCH_DELAY/);assert.match(controller,/saveReviewSwitch/);assert.match(controller,/next\.item\.answer\?\.correct/);
});

test('refresh stores only item/deadline, isolates student and round, clears without retaining answers',t=>{
  const storage=new Map();browserStorage(t,{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)});
  const pending={itemId:'answered-item',deadline:12345};saveReviewSwitch('alice','round-a',pending);
  assert.deepEqual(readReviewSwitch('alice','round-a'),pending);assert.equal(readReviewSwitch('bob','round-a'),null);assert.equal(readReviewSwitch('alice','round-b'),null);
  assert.deepEqual(JSON.parse([...storage.values()][0]),pending);clearReviewSwitch('alice','round-a');assert.equal(storage.size,0);
});

test('invalid or disabled browser storage never breaks authoritative server restore',t=>{
  browserStorage(t,{getItem:()=>'{invalid json',setItem:()=>{throw Error('disabled');},removeItem:()=>{throw Error('disabled');}});
  assert.equal(readReviewSwitch('alice','round'),null);assert.doesNotThrow(()=>saveReviewSwitch('alice','round',{itemId:'one',deadline:1}));assert.doesNotThrow(()=>clearReviewSwitch('alice','round'));
  window.sessionStorage.getItem=()=>JSON.stringify({itemId:123,deadline:1000});assert.equal(readReviewSwitch('alice','round'),null);
});

test('already cancelled transition never starts another advance request',async()=>{
  const abort=new AbortController();abort.abort();let calls=0;
  await prepareReviewAdvance(async()=>{calls++;return {};},Date.now(),abort.signal,()=>{throw Error('must not publish');});assert.equal(calls,0);
});
