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
  '@/lib/lexical/lookup': require('../lib/lexical/lookup.ts')
});
test('shared lookup card renders only canonical expression, context POS, Chinese meaning and English definition', () => {
  const html = renderToStaticMarkup(React.createElement(ui.LexicalLookupCard,{ state:{ selected:'green',result:{ status:'matched',match:'exact_token',
    entry:{ canonical_expression:'green' },occurrence:{ surface_text:'green',context_pos:'adjective',context_meaning_zh:'环保的',context_definition_en:'Good for the environment.' } } } }));
  for (const value of ['green','adjective','环保的','Good for the environment.']) assert.ok(html.includes(value));
  assert.doesNotMatch(html,/button|生词本|common_senses|derived_words|useful_patterns/);
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
  assert.match(reading,/canonical \?\? slot.prefix/);
  assert.doesNotMatch(reading,/Dictionary lookup is not configured/);
});
test('selection interaction captures UTF-16 range, restricts regions, cancels stale fetches, closes outside/Escape/cancel', () => {
  const source = read('components/lexical/LexicalLookup.tsx');
  assert.match(source,/domLexicalSelection/); assert.match(source,/region.current\?\.contains\(start\)/);
  assert.match(source,/onPointerUp/); assert.match(source,/abort.current\?\.abort\(\)/);
  assert.match(source,/pointerdown/); assert.match(source,/Escape/); assert.match(source,/selectionchange/);
  const reading = read('components/reading/ReadingPractice.tsx');
  assert.match(reading,/lexical.lookup\(`material:\$\{material.materialId\}`, rdlLexicalSelection\(selectionMap, range\)\)/);
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
  assert.match(reading, /lexicalAccess=\{variant === "session"[\s\S]*kind: "reading_wrongbook", attemptId: currentOccurrence!.attemptId/);
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
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i],v => { hooks[i] = v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current:initial }; return hooks[i]; },
    useCallback(callback,deps) { const i = cursor++; const previous = hooks[i];
      if (!previous || deps.some((d,j) => d !== previous.deps[j])) hooks[i] = { deps,callback };
      return hooks[i].callback;
    },
    useEffect(callback,deps) { const i = cursor++; const previous = hooks[i];
      if (!previous || deps.some((d,j) => d !== previous.deps[j])) effects.push(() => { previous?.cleanup?.(); hooks[i] = { deps,cleanup:callback() }; });
    }
  };
  let selected = { startOffset:0,endOffset:5,selectedText:'green',blockText:'green energy' };
  const renderer = compile('components/lexical/LexicalLookup.tsx', {
    react:hookReact,
    '@/lib/supabase/client':{ createBrowserSupabase:() => ({ auth:{ getSession:async () => ({ data:{ session:{ access_token:'fixture-token' } } }) } }) },
    '@/lib/lexical/selection':{ domLexicalSelection:() => selected },
    '@/lib/lexical/lookup':{ parseLookupRequest }
  });
  class FakeNode {}
  class FakeElement extends FakeNode {
    constructor() { super(); this.dataset = { lexicalBlock:'question:q:stem',lexicalOffset:'0' };this.textContent = 'green energy'; }
    closest() { return this; }
    contains(node) { return node === this; }
  }
  const block = new FakeElement(); const outside = new FakeElement(); let collapsed = false;
  const previous = Object.fromEntries(['Node','Element','document','window','fetch'].map(k => [k,global[k]]));
  global.Node = FakeNode; global.Element = FakeElement;
  global.document = { addEventListener:(event,callback) => listeners.set(event,callback),removeEventListener:(event,callback) => { if (listeners.get(event) === callback) listeners.delete(event); } };
  global.window = { getSelection:() => ({ isCollapsed:collapsed,rangeCount:1,getRangeAt:() => ({ startContainer:block,endContainer:block }) }) };
  global.fetch = async (url,init) => new Promise(resolve => pending.push({ url,init,resolve }));
  const props = { sourceType:'rap',sourceItemId:'item',access:{ kind:'reading',attemptId:'11111111-1111-4111-8111-111111111111' },children:'source' };
  const render = (enabled = true) => {
    cursor = 0;
    const tree = renderer.LexicalLookupProvider({ ...props,enabled });
    const [region,panel] = tree.props.children;
    region.ref.current = { contains:node => node === block };
    if (panel) panel.ref.current = { contains:() => false };
    effects.splice(0).forEach(fn => fn());
    return { region,panel };
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    let view = render(); view.region.props.onPointerUp({ target:block }); await settle();
    assert.equal(pending.length,1);
    assert.equal(pending[0].url,'/api/lexical/lookup');
    assert.equal(pending[0].init.headers.Authorization,'Bearer fixture-token');
    assert.equal(JSON.parse(pending[0].init.body).selectedText,'green');
    view = render(); assert.ok(view.panel);
    selected = { ...selected,startOffset:6,endOffset:12,selectedText:'energy' };
    view.region.props.onPointerUp({ target:block }); await settle();
    assert.equal(pending.length,2); assert.equal(pending[0].init.signal.aborted,true);
    pending[0].resolve({ ok:true,json:async () => ({ status:'unmatched' }) }); await settle();
    view = render(); assert.equal(view.panel.props.children[1].props.state.selected,'energy');
    pending[1].resolve({ ok:true,json:async () => ({ status:'unmatched' }) }); await settle();
    view = render(); assert.equal(view.panel.props.children[1].props.state.result.status,'unmatched');
    listeners.get('pointerdown')({ target:outside }); view = render(); assert.equal(view.panel,null);
    view = render(false); view.region.props.onPointerUp({ target:block }); await settle(); assert.equal(pending.length,2);
    view = render(true); view.region.props.onPointerUp({ target:block }); await settle(); view = render();
    collapsed = true; listeners.get('selectionchange')(); assert.equal(render().panel,null);
  } finally {
    for (const slot of hooks) slot?.cleanup?.();
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; }
  }
});
