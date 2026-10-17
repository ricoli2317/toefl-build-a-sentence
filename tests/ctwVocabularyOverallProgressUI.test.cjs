const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const ts = require('typescript'), React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const { readFileSync } = require('node:fs');
const read = file => readFileSync(file, 'utf8');
function compile(file, mocks, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
  } }).outputText, { exports, ...globals, require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name) });
  return exports;
}
const Link = ({ children, href, ...props }) => React.createElement('a', { href, ...props }, children);
const teacher = compile('components/teacher/TeacherUI.tsx', { 'next/link': Link });
function catalog(progress, tab = 'mixed') {
  const { CtwVocabularyCatalog } = compile('components/student/CtwVocabulary.tsx', {
    'next/link': Link, 'next/navigation': { useRouter: () => ({}), useSearchParams: () => new URLSearchParams(tab === 'cefr' ? 'tab=cefr' : '') },
    '@/components/StudentDataCache': { useStudentDataCache: () => ({}) }, '@/components/shared/ConfirmDialog': { ConfirmDialog: () => null },
    '@/components/assignments/AssignmentPresentation': {}, '@/components/shared/PracticeHistoryRows': {},
    './StudentUI': { StudentNavigation: () => null }, './WordbookReview': {}, './CtwVocabularyReviewResult': {},
    './useCtwVocabulary': { useVocabularyRead: () => ({ data: { lists: [] } }), useVocabularyRequest: () => ({ studentId: 'owner' }) },
    './useCtwVocabularyProgress': { useCtwVocabularyProgress: () => progress }, './useCtwReview': {},
    '@/components/teacher/TeacherUI': teacher, '@/lib/lexical/wordbookReviewLocal': {}, '@/lib/ctw-vocabulary/review': {},
    '@/lib/ctw-vocabulary/round': require('../lib/ctw-vocabulary/round.ts'),
    '@/lib/studentNavigation': { STUDENT_ROUTES: {} }, './CtwVocabulary.module.css': { overallProgress: 'overall-progress' }
  }, { URLSearchParams });
  return renderToStaticMarkup(React.createElement(CtwVocabularyCatalog));
}
test('shared practice-history bar centers count in the track and keeps percentage to its right in either edition', () => {
  for (const tab of ['mixed', 'cefr']) {
    const html = catalog({ data: { mastered: 110, total: 1000 } }, tab);
    assert.match(html, /aria-label="词测总进度" aria-valuemin="0" aria-valuemax="1000" aria-valuenow="110"/);
    assert.match(html, /absolute inset-0 flex items-center justify-center[^>]*>110\/1000<\/span>/);
    assert.match(html, /style="width:11%"/); assert.match(html, />11%<\/span>/);
    assert.match(html, /bg-gradient-to-r from-\[#b69aff\] to-student-primary/);
    assert.ok(html.indexOf('role="tablist"') < html.indexOf('overall-progress'));
    assert.ok(html.indexOf('overall-progress') < html.indexOf('测试历史'));
  }
  const css = read('components/student/CtwVocabulary.module.css');
  assert.match(css, /align-items: center/); assert.match(css, /@container \(max-width: 34rem\)/);
  assert.match(css, /order: 3;\s*flex-basis: 100%/);
  const original = renderToStaticMarkup(React.createElement(teacher.TeacherAccuracyBar, { value: 0.11 }));
  assert.match(original, /h-2/); assert.doesNotMatch(original, /absolute inset-0/);
});
test('zero mastery/empty library show 0%, while loading/errors never masquerade as zero progress', () => {
  for (const total of [0, 1000]) {
    const html = catalog({ data: { mastered: 0, total } });
    assert.ok(html.includes(`>0/${total}</span>`)); assert.match(html, /width:0%/); assert.match(html, />0%<\/span>/);
    assert.doesNotMatch(html, /NaN|Infinity/);
  }
  assert.match(catalog({}), /正在加载词测总进度/);
  const error = catalog({ error: 'failed' });
  assert.match(error, /总进度读取失败/); assert.match(error, /重试/); assert.doesNotMatch(error, /role="progressbar"|>0%/);
});

function hookHarness() {
  let slots = [], cursor = 0, queued = [], cleanups = [], calls = [], intervals = new Set();
  const win = new EventTarget(), doc = new EventTarget(); doc.visibilityState = 'visible';
  win.setInterval = fn => { intervals.add(fn); return fn; }; win.clearInterval = fn => intervals.delete(fn);
  let session = { studentId: 'one', accessToken: 'synthetic-token' };
  const getSession = () => session;
  let result = { mastered: 1, total: 10 }, fetcher = async () => result;
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old[n])) {
      slots[i] = deps; queued.push(() => { cleanups[i]?.(); cleanups[i] = fn(); });
    } }
  };
  const { useCtwVocabularyProgress } = compile('components/student/useCtwVocabularyProgress.ts', {
    react, '@/components/StudentDataCache': { useStudentDataCache: () => ({ getSession, studentId: session?.studentId ?? null, sessionReady: true }) },
    '@/lib/ctw-vocabulary/round': { VOCABULARY_API: '/api/student/ctw-vocabulary' },
    '@/lib/lexical/wordbookReviewRequest': { fetchReview: async (...args) => { calls.push(args); return fetcher(...args); } }
  }, { window: win, document: doc, AbortController, Error });
  return { calls, win, doc, intervals,
    render() { cursor = 0; const state = useCtwVocabularyProgress(); queued.splice(0).forEach(fn => fn()); return state; },
    unmount() { cleanups.forEach(fn => fn?.()); cleanups = []; slots = []; },
    setResult(value) { result = value; }, setFetcher(fn) { fetcher = fn; },
    setOwner(id) { session = id ? { studentId: id, accessToken: 'synthetic-token' } : null; }
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
test('progress bypasses long-lived caches and refetches on re-entry, focus, visibility, answer ACK and visible interval, not tab renders', async () => {
  const h = hookHarness(); h.render(); await flush();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], '/api/student/ctw-vocabulary/progress');
  h.render(); h.render(); assert.equal(h.calls.length, 1); // TAB/re-renders share the same aggregate
  h.setResult({ mastered: 2, total: 11 }); h.win.dispatchEvent(new Event('focus')); await flush();
  assert.equal(h.render().data.total, 11); assert.equal(h.render().data.mastered, 2);
  h.doc.visibilityState = 'hidden'; h.intervals.forEach(fn => fn()); assert.equal(h.calls.length, 2);
  h.doc.visibilityState = 'visible'; h.doc.dispatchEvent(new Event('visibilitychange')); await flush();
  h.win.dispatchEvent(new Event('ctw-vocabulary-progress-changed')); await flush();
  h.intervals.forEach(fn => fn()); await flush(); assert.equal(h.calls.length, 5);
  h.unmount(); assert.equal(h.intervals.size, 0);
  h.setResult({ mastered: 2, total: 15 }); h.render(); await flush();
  assert.equal(h.calls.length, 6); assert.equal(h.render().data.total, 15);
  h.unmount();
});
test('late responses cannot leak across students; failures expose retry rather than indefinite stale totals', async () => {
  const h = hookHarness(); let resolve;
  h.setFetcher(() => new Promise(r => { resolve = r; })); h.render();
  h.setOwner('two'); h.setFetcher(async () => ({ mastered: 0, total: 12 }));
  assert.equal(h.render().data, undefined); await flush();
  resolve({ mastered: 9, total: 10 }); await flush();
  assert.equal(h.render().data.mastered, 0); assert.equal(h.render().data.total, 12);
  h.setFetcher(async () => { throw Error('synthetic failure'); });
  h.win.dispatchEvent(new Event('focus')); await flush();
  assert.equal(h.render().data, undefined); assert.equal(h.render().error, 'synthetic failure');
  h.setFetcher(async () => ({ mastered: 1, total: 13 })); h.render().retry(); h.render(); await flush();
  assert.equal(h.render().data.total, 13); assert.equal(h.render().error, undefined);
  h.unmount();
});

test('actual progress handler rejects injected student/mode parameters and keeps shared auth/no-store boundaries', async () => {
  const input = require('../lib/ctw-vocabulary/input.ts'); let allowed = false, calls = 0;
  const scoped = { jwt: true };
  const route = compile('app/api/student/ctw-vocabulary/progress/route.ts', {
    '@/lib/ctw-vocabulary/input': input,
    '@/lib/ctw-vocabulary/http.server': { vocabularyRoute: async (request, work) => {
      if (!allowed) return { status: 401 };
      try { return { status: 200, data: await work(scoped, 'owner') }; }
      catch (e) { return { status: e instanceof input.VocabularyInputError ? 400 : 500 }; }
    } },
    '@/lib/ctw-vocabulary/store.server': { readVocabularyOverallProgress: async client => { assert.equal(client, scoped); calls++; return { mastered: 1, total: 10 }; } }
  }, { URL });
  const request = search => new Request('https://offline.invalid/api/student/ctw-vocabulary/progress' + search);
  assert.equal((await route.GET(request(''))).status, 401); assert.equal(calls, 0);
  allowed = true;
  for (const search of ['?studentId=other', '?edition=cefr', '?total=1000', '?mastered=99'])
    assert.equal((await route.GET(request(search))).status, 400);
  assert.equal(calls, 0); assert.equal((await route.GET(request(''))).status, 200); assert.equal(calls, 1);
  assert.equal(route.dynamic, 'force-dynamic');
  assert.match(read('lib/ctw-vocabulary/http.server.ts'), /"Cache-Control": "no-store"/);
  assert.match(read('lib/lexical/wordbookReviewRequest.ts'), /cache: "no-store"/);
});
