const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { parseLookupRequest } = require('../lib/lexical/lookup.ts');
const root = path.join(__dirname,'..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
function compile(relative, mocks) {
  const filename = path.join(root,relative);
  const js = ts.transpileModule(read(relative), { compilerOptions:{ jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true },fileName:filename }).outputText;
  const original = Module._load;
  Module._load = function(request,parent,isMain) { return Object.hasOwn(mocks,request) ? mocks[request] : original.call(this,request,parent,isMain); };
  try {
    const loaded = new Module(filename,module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(root); loaded._compile(js,filename); return loaded.exports;
  } finally { Module._load = original; }
}
const ui = compile('components/lexical/LexicalLookup.tsx', {
  '@/lib/supabase/client': { createBrowserSupabase: () => { throw new Error('render must not query the corpus'); } },
  '@/lib/lexical/selection': require('../lib/lexical/selection.ts'),
  '@/lib/lexical/lookup': require('../lib/lexical/lookup.ts'),
  '@/lib/lexical/position': require('../lib/lexical/position.ts'),
  react: { ...React,useLayoutEffect:React.useEffect }
});
test('shared lookup card renders only canonical expression, context POS, Chinese meaning and English definition', () => {
  const html = renderToStaticMarkup(React.createElement(ui.LexicalLookupCard,{ state:{ selected:'green',result:{ status:'matched',match:'exact_token',
    entry:{ canonical_expression:'green' },occurrence:{ surface_text:'green',context_pos:'adjective',context_meaning_zh:'环保的',context_definition_en:'Good for the environment.' } } } }));
  for (const value of ['green','adjective','环保的','Good for the environment.']) assert.ok(html.includes(value));
  assert.match(html,/aria-label="Lookup query"/); assert.match(html,/Look Up/);
  assert.doesNotMatch(html,/生词本|common_senses|derived_words|useful_patterns/);
});
test('unmatched and unavailable states are simple messages, not fake dictionary or vocabulary successes', () => {
  const unmatched = renderToStaticMarkup(React.createElement(ui.LexicalLookupCard,{ state:{ selected:'gre',result:{ status:'unmatched' } } }));
  assert.match(unmatched,/重新选择完整单词或短语/);
  const unavailable = renderToStaticMarkup(React.createElement(ui.LexicalLookupCard,{ state:{ selected:'old',result:{ status:'unavailable' } } }));
  assert.match(unavailable,/此文本暂不可查词/);
});
test('active Reading provider is disabled and student response/UI chrome have no lexical annotation', () => {
  const html = renderToStaticMarkup(React.createElement(ui.LexicalLookupProvider,{ enabled:false,sourceType:'ctw',access:{ kind:'reading',attemptId:'11111111-1111-4111-8111-111111111111' } },'Active text'));
  assert.match(html,/data-lexical-enabled="false"/); assert.doesNotMatch(html,/lexical-lookup-card/);
  const writing = read('components/writing/WritingQuestionPrompt.tsx');
  for (const id of ['scenario','task-instruction','requirement:','professor-prompt','student-response:1','student-response:2']) assert.ok(writing.includes(id));
  const student = read('components/student/StudentWritingReview.tsx');
  assert.ok(student.indexOf('<LexicalLookupProvider') > student.indexOf('view === "original"'));
  const reading = read('components/reading/ReadingPractice.tsx');
  assert.match(reading,/LexicalLookupProvider[\s\S]*enabled=\{props.lookupEnabled && props.readOnly\}/);
  assert.match(reading,/<ReadingReadonlyReviewShell\s+lexicalAccess=/);
  assert.doesNotMatch(reading,/canonical \?\? slot.prefix|correctSlotText/);
  assert.doesNotMatch(reading,/Dictionary lookup is not configured/);
});
test('selection interaction captures UTF-16 range, restricts regions, cancels stale fetches, closes outside/Escape/cancel', () => {
  const source = read('components/lexical/LexicalLookup.tsx');
  assert.match(source,/domCanonicalLexicalSelection/); assert.match(source,/region.current\?\.contains\(saved.range.startContainer\)/);
  assert.match(source,/onPointerUp/); assert.match(source,/abort.current\?\.abort\(\)/);
  assert.match(source,/pointerdown/); assert.match(source,/Escape/); assert.match(source,/selectionchange/);
  const reading = read('components/reading/ReadingPractice.tsx');
  assert.match(reading,/lexical.lookup\(`material:\$\{material.materialId\}`, rdlLexicalSelection\(selectionMap, range\), \(\) =>/);
  assert.match(reading,/canonicalOffset = ordered.slice\(0, index\).*[\s\S]*s.text.length \+ 1/);
});
test('latest main integrations retain question-chip results, session-scoped review, verified RDL maps and writing recovery/sample views', () => {
  const result = read('components/PracticeResult.tsx');
  assert.match(result, /practice-result-question-chips/);
  assert.match(result, /LexicalLookupProvider key=\{activeAnswer.question_id\}/);
  assert.match(result, /attemptId: attempt.attempt_id, questionId: activeAnswer.question_id/);
  assert.match(result, /<QuestionDisplay\s+lexicalPrompt/);
  assert.match(result, /LexicalText blockId="final-sentence"/);
  assert.match(result, /CorrectionEntryButton/);
  const reading = read('components/reading/ReadingPractice.tsx');
  assert.match(reading, /lexicalAccess=\{lexicalAccess \?\? \(variant === "session"[\s\S]*kind: "reading_wrongbook", attemptId: currentOccurrence!.attemptId/);
  assert.match(read('components/reading/QuestionCategorySessionReview.tsx'), /lexicalAccess=\{\{ kind: "reading_category", attemptId: sessionId \}\}/);
  assert.match(reading, /const parsedMap = material.selectionMap/);
  assert.match(reading, /parsedMap.imageSha256 !== material.imageSha256/);
  assert.match(reading, /focusedCtwSlotId/);
  assert.match(reading, /standalone \? undefined : onBack/);
  assert.match(reading, /flowingAnswerList/);
  const runner = read('components/reading/ReadingFullSetRunner.tsx');
  assert.match(runner, /lookupEnabled=\{readingLookupEnabled\("active"/);
  const writing = read('components/writing/WritingPractice.tsx');
  assert.match(writing, /sendWritingRequestWithSession/);
  assert.match(writing, /const recoveryBanner/);
  assert.match(writing, /syncMirror/);
  const student = read('components/student/StudentWritingReview.tsx');
  assert.ok(student.indexOf('<LexicalLookupProvider') > student.indexOf('view === "sample" ? ('));
  const route = read('app/api/lexical/lookup/route.ts');
  assert.match(route, /basFinalVisible: \(\) => true/);
  assert.doesNotMatch(route, /shouldShowCorrectAnswer/);
});
test('actual API route rejects anonymous/active/wrong-source before lookup and returns only the authorized selection result', async () => {
  let auth = { error:new Response('{"error":"Unauthorized"}',{ status:401 }),client:null,userId:null };
  let authorizeCalls = 0; let lookupCalls = 0; let allowed = true;
  class AccessError extends Error { constructor(status) { super('denied');this.status = status; } }
  const route = compile('app/api/lexical/lookup/route.ts', {
    '@/lib/reading/attemptServer': { requireReadingAttemptStudent:async () => auth,readingAttemptJson:(v,init) => new Response(JSON.stringify(v),{ ...init,headers:{ 'cache-control':'no-store' } }) },
    '@/lib/supabase/server': { createServiceSupabase:() => ({}) },
    '@/lib/lexical/lookup': { parseLookupRequest },
    '@/lib/auth': { bearerToken:() => null,requireTeacherOnly:async () => ({ error:'Forbidden' }) },
    '@/lib/writingReviewWorkspaceServer': { WritingReviewWorkspaceServerError:class extends Error {} },
    '@/lib/lexical/wordbook.server': { addWordbookStatus:async (_db,_user,result) => result },
    '@/lib/lexical/lookup.server': { LexicalAccessError:AccessError,
      authorizeLexicalSource:async () => { authorizeCalls++; if (!allowed) throw new AccessError(409); return { sourceItemId:'item' }; },
      lookupAuthorizedSelection:async () => { lookupCalls++; return { status:'unmatched' }; } },
    '@/lib/reading/fullSetAttemptServer':{}, '@/lib/writingServer':{}, '@/lib/resultDisplayPolicy':{}
  });
  const selection = { access:{ kind:'reading',attemptId:'11111111-1111-4111-8111-111111111111' },sourceType:'rap',sourceItemId:'item',contentBlockId:'question:q:stem',startOffset:0,endOffset:5,selectedText:'green',blockText:'green energy' };
  const request = () => new Request('http://localhost/api/lexical/lookup',{ method:'POST',body:JSON.stringify(selection) });
  assert.equal((await route.POST(request())).status,401); assert.equal(authorizeCalls,0); assert.equal(lookupCalls,0);
  auth = { error:null,client:{},userId:'student' }; allowed = false;
  assert.equal((await route.POST(request())).status,409); assert.equal(lookupCalls,0);
  allowed = true; const result = await route.POST(request());
  assert.deepEqual(await result.json(),{ status:'unmatched' }); assert.equal(result.headers.get('cache-control'),'no-store'); assert.equal(lookupCalls,1);
});
test('provider interaction sends one canonical selection request, aborts stale responses, closes outside and makes no active-practice request', async () => {
  // Narrow hook/event harness; no new browser/test framework or alternate corpus.
  const hooks = []; let cursor = 0; const effects = []; const listeners = new Map(); const pending = [];
  const hookReact = { ...React,
     useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i],v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current:initial }; return hooks[i]; },
    useCallback(callback,deps) { const i = cursor++; const previous = hooks[i];
      if (!previous || deps.some((d,j) => d !== previous.deps[j])) hooks[i] = { deps,callback };
      return hooks[i].callback;
    },
    useEffect(callback,deps) { const i = cursor++; const previous = hooks[i];
      if (!previous || deps.some((d,j) => d !== previous.deps[j])) effects.push(() => { previous?.cleanup?.(); hooks[i] = { deps,cleanup:callback() }; });
    }
  };
  hookReact.useLayoutEffect = hookReact.useEffect;
  let selected = { startOffset:0,endOffset:5,selectedText:'green',blockText:'green energy' };
  const renderer = compile('components/lexical/LexicalLookup.tsx', {
    react:hookReact,
    '@/lib/supabase/client':{ createBrowserSupabase:() => ({ auth:{ getSession:async () => ({ data:{ session:{ access_token:'fixture-token' } } }) } }) },
    '@/lib/lexical/selection':{ domCanonicalLexicalSelection:() => selected ? ({ ...selected,contentBlockId:'question:q:stem' }) : null },
    '@/lib/lexical/lookup':{ parseLookupRequest },
    '@/lib/lexical/position':require('../lib/lexical/position.ts')
  });
  class FakeNode {}
  class FakeElement extends FakeNode {
    constructor() { super(); this.dataset = { lexicalBlock:'question:q:stem',lexicalOffset:'0' };this.textContent = 'green energy'; }
    closest(selector) { return selector === '[data-testid="rdl-selection-surface"]' ? null : this; }
    contains(node) { return node === this; }
  }
  const block = new FakeElement(); const outside = new FakeElement(); const input = new FakeElement(); let collapsed = false;
  let anchorRect = { left:100,top:100,right:150,bottom:120,width:50,height:20 };
  const range = { startContainer:block,endContainer:block,cloneRange:() => range,getBoundingClientRect:() => anchorRect,getClientRects:() => [anchorRect] };
  const previous = Object.fromEntries(['Node','Element','document','window','fetch'].map(k => [k,global[k]]));
  global.Node = FakeNode; global.Element = FakeElement;
  const add = (event,callback) => listeners.set(event,callback);
  const remove = (event,callback) => { if (listeners.get(event) === callback) listeners.delete(event); };
  global.document = { activeElement:null,addEventListener:add,removeEventListener:remove };
  global.window = { innerWidth:800,innerHeight:600,addEventListener:add,removeEventListener:remove,
    getSelection:() => ({ isCollapsed:collapsed,rangeCount:1,getRangeAt:() => range }) };
  global.fetch = async (url,init) => new Promise(resolve => pending.push({ url,init,resolve }));
  const props = { sourceType:'rap',sourceItemId:'item',access:{ kind:'reading',attemptId:'11111111-1111-4111-8111-111111111111' },children:'source' };
  const render = (enabled = true) => {
    cursor = 0;
    const tree = renderer.LexicalLookupProvider({ ...props,enabled });
    const [region,panel] = tree.props.children;
    region.ref.current = { contains:node => node === block };
    if (panel) { panel.ref.current = { contains:node => node === input,offsetWidth:448,offsetHeight:180,clientHeight:178,scrollHeight:178 };panel.props.children[1].props.children.ref.current={scrollHeight:146}; }
    effects.splice(0).forEach(fn => fn());
    return { region,panel,card:panel?.props.children[1].props.children.props.children,lookup:tree.props.value?.lookup };
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    let view = render(); view.region.props.onPointerUp({ target:block }); await settle();
    assert.equal(pending.length,1);
    assert.equal(pending[0].url,'/api/lexical/lookup');
    assert.equal(pending[0].init.headers.Authorization,'Bearer fixture-token');
    assert.equal(JSON.parse(pending[0].init.body).selectedText,'green');
    view = render(); assert.ok(view.panel);
    view = render(); assert.equal(view.panel.props.style.left,100); assert.equal(view.panel.props.style.top,128);
    anchorRect = { ...anchorRect,top:500,bottom:520 };
    listeners.get('scroll')({target:window}); view = render(); assert.equal(view.panel.props['data-placement'],'above'); assert.equal(view.panel.props.style.top,312);
    selected = { ...selected,startOffset:6,endOffset:12,selectedText:'energy' };
    view.region.props.onPointerUp({ target:block }); await settle();
    assert.equal(pending.length,2); assert.equal(pending[0].init.signal.aborted,true);
    pending[0].resolve({ ok:true,json:async () => ({ status:'unmatched' }) }); await settle();
    view = render(); assert.equal(view.card.props.state.selected,'energy');
    pending[1].resolve({ ok:true,json:async () => ({ status:'unmatched' }) }); await settle();
    view = render(); assert.equal(view.card.props.state.result.status,'unmatched');
    // Editing focuses the input and may collapse the browser selection; the saved source Range remains usable.
    document.activeElement = input; collapsed = true; listeners.get('selectionchange')(); assert.ok(render().panel);
    view.card.props.onQueryChange('energy!'); view = render(); assert.equal(view.card.props.query,'energy!');
    assert.equal(view.card.props.state.result,undefined);
    view.card.props.onSearch(); await settle();
    assert.equal(pending.length,3); const edited = JSON.parse(pending[2].init.body);
    assert.equal(edited.query,'energy!'); assert.equal(edited.selectedText,'energy'); assert.equal(edited.startOffset,6);
    listeners.get('pointerdown')({ target:outside }); view = render(); assert.equal(view.panel,null);
    assert.equal(pending[2].init.signal.aborted,true);
    document.activeElement = null; collapsed = false;
    view = render(false); view.region.props.onPointerUp({ target:block }); await settle(); assert.equal(pending.length,3);
    view = render(true); view.region.props.onPointerUp({ target:block }); await settle(); view = render();
    collapsed = true; listeners.get('selectionchange')(); assert.equal(render().panel,null);
    collapsed = false; view = render(); view.region.props.onPointerUp({ target:block }); await settle(); view = render();
    listeners.get('keydown')({ key:'Escape' }); assert.equal(render().panel,null);
    view = render(); view.region.props.onPointerUp({ target:block }); await settle(); view = render();
    anchorRect = { ...anchorRect,top:-200,bottom:-180 }; listeners.get('resize')(); assert.equal(render().panel,null);
    // A verified RDL-style hitbox selection must not depend on the browser's (collapsed) DOM selection.
    anchorRect = { ...anchorRect,top:100,bottom:120 }; collapsed = true; view = render();
    view.lookup('material:m',selected,() => anchorRect); await settle(); view = render();
    listeners.get('selectionchange')(); assert.ok(render().panel);
    const last = pending.at(-1); last.resolve({ ok:false,status:503,json:async () => ({ error:'fixture failure' }) }); await settle();
    assert.equal(render().card.props.state.error,'查词暂时不可用。');
    view = render(); view.panel.props.children[0].props.onClick(); assert.equal(render().panel,null);
    // Real provider mutation handler: duplicate clicks are suppressed, state is
    // changed only after confirmation, and late responses cannot reopen a card.
    collapsed=false;view=render();view.region.props.onPointerUp({ target:block });await settle();
    const matched={ status:'matched',entry:{ entry_id:'entry',canonical_expression:'green' },occurrence:{ occurrence_id:'occ',surface_text:'green' },wordbook:{ available:true,saved:false } };
    pending.at(-1).resolve({ ok:true,json:async()=>matched });await settle();view=render();
    const saving=view.card.props.onWordbookToggle();view.card.props.onWordbookToggle();await settle();
    assert.equal(pending.at(-1).url,'/api/lexical/wordbook');assert.equal(JSON.parse(pending.at(-1).init.body).action,'save');
    assert.equal(render().card.props.state.wordbookBusy,true);
    pending.at(-1).resolve({ ok:true,json:async()=>({ saved:true,available:true,domain:'reading' }) });await saving;
    view=render();assert.equal(view.card.props.state.result.wordbook.saved,true);assert.equal(view.card.props.state.wordbookBusy,false);
    assert.equal(view.card.props.state.wordbookMessage,'已加入生词本。');
    const removing=view.card.props.onWordbookToggle();await settle();assert.equal(JSON.parse(pending.at(-1).init.body).action,'remove');
    pending.at(-1).resolve({ ok:true,json:async()=>({ saved:false,available:true,domain:'reading' }) });await removing;
    view=render();assert.equal(view.card.props.state.result.wordbook.saved,false);
    const failing=view.card.props.onWordbookToggle();await settle();
    pending.at(-1).resolve({ ok:false,json:async()=>({ error:'无法可靠提取原句，本次未收藏。' }) });await settle();
    assert.equal(JSON.parse(pending.at(-1).init.body).action,'status');
    pending.at(-1).resolve({ ok:true,json:async()=>({ saved:false,available:true }) });await failing;
    view=render();assert.match(view.card.props.state.wordbookError,/未收藏/);assert.equal(view.card.props.state.result.wordbook.saved,false);
    const late=view.card.props.onWordbookToggle();await settle();view.panel.props.children[0].props.onClick();
    pending.at(-1).resolve({ ok:true,json:async()=>({ saved:true,available:true }) });await late;assert.equal(render().panel,null);
    // Teaching uses the same selection/card but has no Wordbook handler or request.
    props.teacherReadonly = true;
    props.access = { ...props.access,studentId:'22222222-2222-4222-8222-222222222222' };
    render(); view=render(); view.region.props.onPointerUp({ target:block });await settle();
    const teacherRequest = pending.at(-1);
    assert.equal(teacherRequest.url,'/api/lexical/lookup');
    assert.equal(JSON.parse(teacherRequest.init.body).teacherReadonly,true);
    teacherRequest.resolve({ ok:true,json:async()=>matched });await settle();view=render();
    assert.equal(view.card.props.onWordbookToggle,undefined);
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(ui.LexicalLookupCard,view.card.props)),/加入生词本|取消收藏/);
    const beforeImage=pending.length;block.closest=selector=>selector==='[data-testid="rdl-selection-surface"]'?block:null;
    view.region.props.onPointerUp({ target:block });await settle();assert.equal(pending.length,beforeImage,'RDL handler owns its image span; stale DOM selection must not issue another request');
    delete block.closest;
    view.panel.props.children[0].props.onClick();assert.equal(render().panel,null);
    // An excluded CTW slot (or any invalid canonical selection) must not issue a lookup request.
    const requestsBeforeSlot = pending.length; selected = null; collapsed = false;
    view = render(); view.region.props.onPointerUp({ target:block }); await settle();
    assert.equal(pending.length,requestsBeforeSlot); assert.equal(render().panel,null);
  } finally {
    for (const slot of hooks) slot?.cleanup?.();
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; }
  }
});

test('query keeps the raw selected punctuation, submits via Enter/search, and containing phrases never replace the primary entry', () => {
  let searches = 0; let edited = '';
  const card = ui.LexicalLookupCard({ state:{ selected:'Center!',result:{ status:'matched',match:'exact_token',entry:{ canonical_expression:'Center' },
    occurrence:{ surface_text:'Center',context_pos:'noun',context_meaning_zh:'中心',context_definition_en:'The center.' },
    containingPhrases:[{ entry:{ canonical_expression:'Center stage' },occurrence:{ occurrence_id:'phrase',context_meaning_zh:'舞台中央',context_definition_en:'The middle of the stage.' } }] } },
    onSearch:() => searches++,onQueryChange:value => { edited = value; } });
  const form = card.props.children[0];
  assert.equal(form.props.children[0].props.value,'Center!');
  form.props.children[0].props.onChange({ target:{ value:'Center' } }); assert.equal(edited,'Center');
  let prevented = false; form.props.onSubmit({ preventDefault:() => { prevented = true; } }); assert.equal(prevented,true); assert.equal(searches,1);
  const html = renderToStaticMarkup(card);
  assert.match(html,/value="Center!"/); assert.ok(html.indexOf('>Center</p>') < html.indexOf('所在短语'));
  for (const text of ['Center stage','舞台中央','The middle of the stage.']) assert.ok(html.includes(text));
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ui.LexicalLookupCard,{ state:{ selected:'word',result:{ status:'unmatched' } } })),/所在短语/);
});

test('wordbook primary action sits beside the title, toggles directly, disables pending requests and announces light feedback', () => {
  const result={ status:'matched',entry:{ canonical_expression:'green' },occurrence:{ surface_text:'green',context_meaning_zh:'环保的' },wordbook:{ available:true,saved:false } };
  const render=(extra={})=>renderToStaticMarkup(React.createElement(ui.LexicalLookupCard,{ state:{ selected:'green',result,...extra },onWordbookToggle:()=>{} }));
  const html=render();assert.match(html,/lucide-plus/);assert.match(html,/lucide-plus[^>]*text-student-primary/);assert.match(html,/加入生词本/);assert.match(html,/aria-pressed="false"/);
  assert.ok(html.indexOf('>green</p>')<html.indexOf('加入生词本'));assert.ok(html.indexOf('加入生词本')<html.indexOf('环保的'));
  const saved=render({ result:{ ...result,wordbook:{ available:true,saved:true } } });assert.match(saved,/已加入 · 取消收藏/);assert.match(saved,/aria-pressed="true"/);
  const busy=render({ wordbookBusy:true });assert.match(busy,/disabled=""/);assert.match(busy,/处理中/);
  assert.match(render({ wordbookError:'无法可靠提取原句，本次未收藏。' }),/role="status"/);
  const source=read('components/lexical/LexicalLookup.tsx');assert.match(source,/absolute -right-2 -top-3/);assert.match(source,/h-7 w-7.*rounded-full/);
  assert.match(source,/overflow-visible/);assert.match(source,/focus-visible:ring-2/);assert.doesNotMatch(source,/float-right|pr-6/);
  assert.match(source,/matched \? <div className="flex items-center gap-2"/);assert.doesNotMatch(source,/items-start justify-between gap-3/);
});

test('actual wordbook route authenticates first, validates IDs/proof/action and never forwards client snapshots',async()=>{
  let auth={ error:new Response('{}',{ status:401 }) };let calls=0;let args;
  const { WordbookError }=require('../lib/lexical/wordbookContext.ts');
  const route=compile('app/api/lexical/wordbook/route.ts',{
    '@/lib/reading/attemptServer':{ requireReadingAttemptStudent:async()=>auth,readingAttemptJson:(v,init)=>new Response(JSON.stringify(v),{ ...init,headers:{ 'cache-control':'no-store' } }) },
    '@/lib/supabase/server':{ createServiceSupabase:()=>({}) },'@/lib/lexical/lookup':{ parseLookupRequest },
    '@/lib/lexical/lookup.server':{ LexicalAccessError:class extends Error{} },'@/lib/lexical/wordbookContext':{ WordbookError },
    '@/lib/lexical/wordbook.server':{ operateWordbook:async(...input)=>{ calls++;args=input;return { saved:true,domain:'reading' }; } },
    '@/lib/reading/fullSetAttemptServer':{},'@/lib/writingServer':{}
  });
  const selection={ access:{ kind:'reading',attemptId:'11111111-1111-4111-8111-111111111111' },sourceType:'rap',sourceItemId:'item',contentBlockId:'question:q:stem',startOffset:0,endOffset:5,selectedText:'green',blockText:'green energy' };
  const input={ action:'save',selection,entryId:'11111111-1111-4111-8111-111111111112',occurrenceId:'11111111-1111-4111-8111-111111111113',studentId:'attacker',domain:'writing',example_text:'invented' };
  const request=(value=input)=>new Request('http://localhost/api/lexical/wordbook',{ method:'POST',body:JSON.stringify(value) });
  assert.equal((await route.POST(request())).status,401);assert.equal(calls,0);
  auth={ client:{},userId:'trusted',error:null };
  for(const invalid of [{ ...input,entryId:'invalid' },{ ...input,action:'merge' },{ ...input,selection:{ ...selection,sourceType:'web' } }])
    assert.equal((await route.POST(request(invalid))).status,400);
  assert.equal(calls,0);const response=await route.POST(request());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(args[2],'trusted');assert.deepEqual(args[3],selection);assert.equal(args[4],input.entryId);assert.equal(args[6],'save');
  assert.doesNotMatch(JSON.stringify(args),/attacker|invented/);
});
