// No browser/runtime dependency: execute the real hooks and layout cache methods
// with a small deterministic hook scheduler. Network responses remain offline.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), React = require('react');
const root = path.resolve(__dirname, '../..');
function compile(file, mocks) {
  const filename = path.join(root, file), old = Module._load;
  Module._load = function(name, parent, main) { return Object.hasOwn(mocks, name) ? mocks[name] : old.call(this, name, parent, main); };
  try {
    const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
    return m.exports;
  } finally { Module._load = old; }
}
function scheduler() {
  let cursor = 0, pending = [], dirty = false;
  const slots = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = { ...React,
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) {
      const old = slots[i]; slots[i] = { deps }; pending.push(() => { old?.cleanup?.(); slots[i].cleanup = fn(); }); } },
    useLayoutEffect(fn, deps) { return hooks.useEffect(fn, deps); }
  };
  return { hooks, render(fn) { cursor = 0; dirty = false; return fn(); }, flush() { const jobs = pending; pending = []; jobs.forEach(fn => fn()); },
    get dirty() { return dirty; }, unmount() { slots.forEach(s => s.cleanup?.()); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function harness(kind = 'student', owner = 'student-a') {
  const provider = scheduler(), listeners = [], authListeners = [];
  const session = { user: { id: kind === 'student' ? owner : 'teacher-a' }, access_token: 'offline-token' };
  const auth = { getSession: async () => ({ data: { session } }), onAuthStateChange(fn) { authListeners.push(fn); return { data: { subscription: { unsubscribe() {} } } }; } };
  const exports = compile(`components/${kind === 'student' ? 'Student' : 'Teacher'}DataCache.tsx`, {
    react: provider.hooks, '@/lib/supabase/client': { createBrowserSupabase: () => ({ auth }) },
    '@/lib/cacheInvalidation': { cacheDomainsForEvent: () => [], subscribeToCacheInvalidation(fn) { listeners.push(fn); return () => {}; } },
    '@/lib/studentSetStatus': require('../../lib/studentSetStatus.ts')
  });
  const Provider = exports[kind === 'student' ? 'StudentDataCacheProvider' : 'TeacherDataCacheProvider'];
  let cache;
  const update = () => { cache = provider.render(() => Provider({ children: null })).props.value; provider.flush(); };
  update(); await tick(); update();
  const readers = [];
  function reader() {
    const runner = scheduler(); let pendingFetch;
    const requests = [];
    const originalFetch = global.fetch;
    const mocks = {
      react: runner.hooks, 'next/link': () => null,
      '@/components/StudentDataCache': { useStudentDataCache: () => cache, useOptionalStudentDataCache: () => kind === 'student' ? cache : null },
      '@/components/TeacherDataCache': { useOptionalTeacherDataCache: () => kind === 'teacher' ? cache : null },
      '@/lib/cacheInvalidation': { publishCacheInvalidation: e => listeners.forEach(fn => fn(e)) },
      '@/components/student/StudentUI': {}, '@/components/student/StudentDateSelection': {}, './WordbookExample': {},
      '@/components/shared/ConfirmDialog': {}, '@/lib/lexical/wordbookPresentation': require('../../lib/lexical/wordbookPresentation.ts'),
      '@/lib/lexical/wordbookManagement': require('../../lib/lexical/wordbookManagement.ts'),
      '@/lib/studentNavigation': { STUDENT_ROUTES: {} }, '@/lib/studentDates': require('../../lib/studentDates.ts'),
      '@/lib/lexical/wordbookList': require('../../lib/lexical/wordbookList.ts'), './StudentWordbook.module.css': {}
    };
    const module = compile('components/student/StudentWordbook.tsx', mocks);
    global.fetch = async url => new Promise(resolve => requests.push({ url, resolve(data) { resolve({ ok: true, json: async () => data }); } }));
    const access = { studentId: owner, sessionReady: true, actorId: kind === 'teacher' ? 'teacher-a' : undefined, getSession: () => ({ accessToken: 'offline-token' }) };
    const read = (url, revision = 0, override = {}) => { update();
      const value = runner.render(() => module.useWordbookRead(url, revision, { ...access, ...override })); runner.flush(); return value; };
    const result = { read, requests, runner, module, access, cleanup() { runner.unmount(); global.fetch = originalFetch; } };
    readers.push(result); return result;
  }
  return { reader, get cache() { update(); return cache; }, update, tick, emit(e) { listeners.forEach(fn => fn(e)); update(); },
    authEvent() { authListeners.forEach(fn => fn('SIGNED_IN', session)); update(); }, cleanup() { readers.reverse().forEach(r => r.cleanup()); provider.unmount(); } };
}
module.exports = { harness, scheduler, compile, tick };
