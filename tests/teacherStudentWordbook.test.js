const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createMockSupabase } = require('./fixtures/mockSupabase.js');
const { loadTeacherScope } = require('../lib/teacherScope.server.ts');
const review = require('../lib/lexical/wordbookReview.ts');
const list = require('../lib/lexical/wordbookList.ts');
const listServer = require('../lib/lexical/wordbookList.server.ts');
const { reviewRpc } = require('../lib/lexical/wordbookReview.server.ts');
const { deleteWordbookBatch } = require('../lib/lexical/wordbookManagement.server.ts');
const { WordbookError } = require('../lib/lexical/wordbookContext.ts');
const student = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const teacher = '11111111-1111-4111-8111-111111111111';
const sid = n => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function compile(file, mocks) {
  const filename = path.join(__dirname, '..', file), old = Module._load;
  Module._load = function(name, parent, isMain) { return Object.hasOwn(mocks, name) ? mocks[name] : old.call(this, name, parent, isMain); };
  try {
    const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(ts.transpileModule(read(file), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
    return m.exports;
  } finally { Module._load = old; }
}
const json = (body, options) => Response.json(body, { ...options, headers: { 'Cache-Control': 'no-store' } });
const summary = { correct: 4, incorrect: 1, spellingCorrect: 2, spellingTotal: 3, posCorrect: 3, posTotal: 3, choiceCorrect: 2, choiceTotal: 2 };
const word = domain => ({ wordbookEntryId: sid(99), domain, expression: 'green', sourceTypes: domain === 'reading' ? ['rap'] : ['bas'],
  senses: [{ senseId: 'sense', contextPos: 'adjective', contextMeaningZh: '环保的', contextDefinitionEn: 'Environmentally friendly.', exampleIds: ['example'] }],
  examples: [{ exampleId: 'example', text: 'We use green energy.' }], enrichmentItems: [] });

function fixture(domains = ['reading', 'writing'], role = 'teacher') {
  const sessions = Array.from({ length: 12 }, (_, i) => ({ session_id: sid(i + 1), student_id: student, domain: 'reading',
    started_at: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`, total: 5, answered: 5, status: 'completed', mode: 'random', settings: {}, source_types: ['rap'] }));
  sessions.push({ ...sessions[0], session_id: sid(20), domain: 'writing', source_types: ['bas'] }, { ...sessions[0], session_id: sid(30), student_id: other });
  const tables = { teacher_student_bindings: domains.map(domain => ({ teacher_id: teacher, student_id: student, domain,
    student: { id: student, role: 'student', is_active: true, full_name: 'Fixture Student', email: 'fixture@example.invalid' } })),
    student_wordbook_review_sessions: sessions, student_wordbook_entries: [{ wordbook_entry_id: sid(99), student_id: student, domain: 'reading' }] };
  const calls = [];
  const base = createMockSupabase(tables, { rpc(name, args) {
    calls.push({ rpc: name, args });
    if (name === 'read_student_wordbook_v1') return { data: { items: [word(args.p_domain)], total: 1, page: args.p_page, pageSize: args.p_page_size } };
    if (name === 'read_student_wordbook_activity_dates_v1') return { data: ['2026-10-08'] };
    if (name === 'read_wordbook_review_history_v1') {
      const rows=sessions.filter(s=>s.student_id===args.p_student&&s.domain===args.p_domain).sort((a,b)=>b.started_at.localeCompare(a.started_at));
      if(args.p_month)return {data:{dates:[...new Set(rows.map(s=>s.started_at.slice(0,10)))]}};
      return {data:{items:rows.slice((args.p_page-1)*10,args.p_page*10).map(({student_id,...s})=>({...s,summary})),total:rows.length,page:args.p_page,pageSize:10}};
    }
    if (name === 'wordbook_review_read') {
      const session = sessions.find(s => s.student_id === args.p_student && s.session_id === args.p_session);
      assert.ok(session);
      const { student_id, ...publicSession } = session;
      return { data: { session: publicSession, summary, composition: { spellingPos: 3, meaningChoice: 2 }, item: { itemId: 'historical-item' } } };
    }
    throw new Error(`Forbidden non-read RPC: ${name}`);
  } });
  const db = { rpc: base.rpc, from(table) {
    const q = base.from(table), call = { table, filters: [], count: false }; calls.push(call);
    const proxy = new Proxy(q, { get(target, key) {
      if (['insert', 'upsert', 'update', 'delete'].includes(key)) return () => { throw new Error('Teacher attempted a write'); };
      if (key === 'then') return (resolve, reject) => target.then(result => {
        if (call.count) result.count = (tables[table] ?? []).filter(row => call.filters.every(([k, v]) => row[k] === v)).length;
        return resolve(result);
      }, reject);
      const fn = target[key]; if (typeof fn !== 'function') return fn;
      return (...args) => {
        if (key === 'eq') call.filters.push(args);
        if (key === 'select') { call.columns = args[0]; call.count = Boolean(args[1]?.count); }
        const result = fn(...args); return result === q ? proxy : result;
      };
    } }); return proxy;
  } };
  let account = { userId: teacher, role, error: null };
  const authMocks = { bearerToken: req => req.headers.get('Authorization'), requireTeacherOnly: async () => account };
  const { teacherWordbookRead } = compile('lib/lexical/teacherWordbook.server.ts', {
    '@/lib/auth': authMocks, '@/lib/supabase/server': { createServiceSupabase: () => db },
    '@/lib/teacherScope.server': { loadTeacherScope }, '@/lib/reading/attemptServer': { readingAttemptJson: json },
    './wordbookList.ts': list, './wordbookList.server.ts': listServer, './wordbookReview.ts': review, './wordbookReview.server.ts': { reviewRpc }
  });
  const route = file => compile(file, { '@/lib/lexical/teacherWordbook.server': { teacherWordbookRead } });
  const root = 'app/api/teacher/students/[studentId]/wordbook';
  const routes = { list: route(`${root}/route.ts`), scope: route(`${root}/scope/route.ts`), dates: route(`${root}/activity-dates/route.ts`),
    history: route(`${root}/review/history/route.ts`), historyDates: route(`${root}/review/activity-dates/route.ts`), result: route(`${root}/review/[sessionId]/route.ts`) };
  return { tables, calls, db, authMocks, routes, setAccount: value => { account = value; }, async send(kind, query = '', target = student, session = sid(1)) {
    return routes[kind].GET(new Request(`https://offline.invalid/api?${query}`, { headers: { Authorization: 'Bearer offline' } }),
      { params: { studentId: target, sessionId: session } });
  } };
}

for (const domains of [['reading'], ['writing'], ['reading', 'writing']]) {
  test(`${domains.join('+')} bindings: actual teacher GETs use student owner and expose only authorized subjects`, async () => {
    const f = fixture(domains);
    assert.deepEqual((await (await f.send('scope')).json()).domains, domains);
    for (const domain of ['reading', 'writing']) {
      const start = f.calls.length;
      for (const kind of ['list', 'dates', 'history', 'historyDates', 'result']) {
        const response = await f.send(kind, `domain=${domain}${kind === 'dates' || kind === 'historyDates' ? '&month=2026-10' : ''}`, student, domain === 'writing' ? sid(20) : sid(1));
        assert.equal(response.status, domains.includes(domain) ? 200 : 403);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        const body = await response.json();
        if (!domains.includes(domain)) { assert.deepEqual(Object.keys(body).sort(), ['code', 'error']); continue; }
        if (kind === 'list') assert.deepEqual(body.items, [word(domain)]);
        if (kind === 'history') { assert.equal(body.total, domain === 'reading' ? 12 : 1); assert.ok(body.items.every(s => s.domain === domain)); assert.deepEqual(body.items[0].summary, summary); }
        if (kind === 'result') { assert.equal(body.session.domain, domain); assert.deepEqual(body.summary, summary); }
      }
      if (!domains.includes(domain)) assert.ok(f.calls.slice(start).every(c => c.table === 'teacher_student_bindings'));
    }
    assert.ok(f.calls.filter(c => c.rpc).every(c => (c.args.p_student ?? c.args.p_student_id) === student));
  });
}

test('unbound, disabled or non-student target and unauthenticated/non-teacher actors cannot read any content', async () => {
  for (const condition of ['unbound', 'inactive', 'target-teacher', 'student-actor', 'admin-actor', 'missing-auth']) {
    const f = fixture();
    if (condition === 'unbound') f.tables.teacher_student_bindings = [];
    if (condition === 'inactive') f.tables.teacher_student_bindings.forEach(b => { b.student.is_active = false; });
    if (condition === 'target-teacher') f.tables.teacher_student_bindings.forEach(b => { b.student.role = 'teacher'; });
    if (condition === 'student-actor' || condition === 'admin-actor') f.setAccount({ userId: teacher, role: condition.split('-')[0] });
    if (condition === 'missing-auth') f.setAccount({ userId: null, role: null, error: 'unauthenticated' });
    for (const kind of ['scope', 'list', 'dates', 'history', 'historyDates', 'result']) {
      assert.equal((await f.send(kind, kind === 'scope' ? '' : 'domain=reading&month=2026-10')).status, 403);
    }
    assert.ok(f.calls.every(c => c.table === 'teacher_student_bindings'));
  }
});

test('authorized domain cannot disguise a cross-domain, cross-owner, missing or unbound-student result', async () => {
  const f = fixture(['reading']);
  for (const [target, session] of [[student, sid(20)], [student, sid(30)], [student, sid(999)], [other, sid(30)]]) {
    const start = f.calls.length, response = await f.send('result', 'domain=reading', target, session);
    assert.equal(response.status, 403); assert.deepEqual(Object.keys(await response.json()).sort(), ['code', 'error']);
    assert.ok(!f.calls.slice(start).some(c => c.rpc));
  }
});

test('a subject on another student or another teacher never grants that subject on the target student', async () => {
  const f = fixture(['reading']);
  f.tables.teacher_student_bindings.push(
    { teacher_id: teacher, student_id: other, domain: 'writing', student: { id: other, role: 'student', is_active: true } },
    { teacher_id: other, student_id: student, domain: 'writing', student: { id: student, role: 'student', is_active: true } }
  );
  assert.deepEqual((await (await f.send('scope')).json()).domains, ['reading']);
  for (const kind of ['list', 'dates', 'history', 'result']) assert.equal((await f.send(kind, 'domain=writing&month=2026-10')).status, 403);
  assert.ok(!f.calls.some(c => c.rpc));
});

test('history counts/pagination are domain-scoped before reading summaries; invalid filters/actions never run an RPC', async () => {
  const f = fixture(['reading']);
  const page = await (await f.send('history', 'domain=reading&page=2')).json();
  assert.equal(page.total, 12); assert.equal(page.items.length, 2); assert.equal(page.page, 2);
  assert.ok(page.items.every(s => s.domain === 'reading'));
  const query = f.calls.find(c => c.rpc === 'read_wordbook_review_history_v1');
  assert.equal(query.args.p_student,student); assert.equal(query.args.p_domain,'reading');
  assert.ok(!f.calls.some(c=>c.rpc==='wordbook_review_read'));
  for (const [kind, query] of [['list', ''], ['list', 'domain=reading&student_id=' + other], ['list', 'domain=reading&page=bad'],
    ['list', 'domain=reading&domain=reading'], ['dates', 'domain=reading'], ['history', 'domain=reading&action=availability'],
    ['history', 'domain=reading&page=0'], ['history', 'domain=reading&pageSize=50'], ['historyDates', 'domain=reading&month=2026-10&start=2026-10-01'],
    ['result', 'domain=reading&round=1'], ['result', 'domain=reading&action=sync']]) {
    const start = f.calls.length;
    assert.equal((await f.send(kind, query)).status, 400);
    assert.ok(!f.calls.slice(start).some(c => c.rpc));
  }
  for (const route of Object.values(f.routes)) assert.deepEqual(Object.keys(route).sort(), ['GET', 'dynamic']);
});

test('direct student batch-delete API with a teacher token cannot delete target student entries or accept injected owner', async () => {
  const f = fixture();
  const route = compile('app/api/student/wordbook/batch-delete/route.ts', {
    '@/lib/reading/attemptServer': { requireReadingAttemptStudent: async () => ({ userId: teacher }), readingAttemptJson: json },
    '@/lib/supabase/server': { createServiceSupabase: () => f.db },
    '@/lib/lexical/wordbookManagement': require('../lib/lexical/wordbookManagement.ts'),
    '@/lib/lexical/wordbookManagement.server': { deleteWordbookBatch }, '@/lib/lexical/wordbookContext': { WordbookError }
  });
  const send = body => route.POST(new Request('https://offline.invalid/api', { method: 'POST', body: JSON.stringify(body) }));
  assert.equal((await send({ domain: 'reading', entryIds: [sid(99)] })).status, 409);
  assert.equal((await send({ domain: 'reading', entryIds: [sid(99)], student_id: student })).status, 400);
  assert.ok(!f.calls.some(c => c.rpc));
});

test('direct student review writes cannot impersonate the viewed student; target sessions are rejected for every write action', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => {
    calls.push({ name, args }); assert.equal(args.p_student, teacher);
    assert.ok(args.p_session === sid(1) || args.p_parent === sid(1));
    return { data: null, error: { message: 'REVIEW_NOT_FOUND' } };
  } };
  const mocks = {
    '@/lib/reading/attemptServer': { requireReadingAttemptStudent: async () => ({ userId: teacher }), readingAttemptJson: json },
    '@/lib/supabase/server': { createServiceSupabase: () => db }, '@/lib/lexical/wordbookReview': review,
    '@/lib/lexical/wordbookReview.server': { reviewRpc }, '@/lib/lexical/wordbookReviewPresentation': {},
    '@/lib/lexical/wordbookList':list,'@/lib/lexical/wordbookList.server':listServer,
    '@/lib/lexical/wordbookReviewRound.server': { readReviewRound: () => { throw new Error('Must never read target round'); } }
  };
  const setup = compile('app/api/student/wordbook/review/route.ts', mocks);
  const session = compile('app/api/student/wordbook/review/[sessionId]/route.ts', mocks);
  const post = body => new Request('https://offline.invalid/api', { method: 'POST', body: JSON.stringify(body) });
  const settings = { domain: 'reading', sources: ['rap'], mode: 'random', count: 1, timeZone: 'Asia/Shanghai' };
  for (const body of [{ settings, requestId: sid(9), student_id: student }, { settings: { ...settings, student_id: student }, requestId: sid(9) }]) {
    assert.equal((await setup.POST(post(body))).status, 400);
  }
  assert.equal(calls.length, 0);
  for (const body of [{ action: 'retry', requestId: sid(9) }, { action: 'start_test', itemId: sid(2) },
    { action: 'study_next', itemId: sid(2) }, { action: 'repeat', itemId: sid(2) }, { action: 'advance', itemId: sid(2) },
    { action: 'answer', itemId: sid(2), answer: { optionId: sid(3) } },
    { action: 'sync', command: { id: sid(9), itemId: sid(2), action: 'answer', answer: { optionId: sid(3) } } }]) {
    assert.equal((await session.POST(post(body), { params: { sessionId: sid(1) } })).status, 404);
  }
});

const Link = ({ href, children, ...props }) => React.createElement('a', { ...props, href }, children);
const commonMocks = {
  'next/link': Link, '@/components/StudentDataCache': { useOptionalStudentDataCache:()=>null,useStudentDataCache: () => { throw new Error('Teacher must not use student cache'); } },
  '@/components/TeacherDataCache':{useOptionalTeacherDataCache:()=>null},'@/lib/cacheInvalidation':{},
  '@/lib/lexical/wordbookList': list, '@/lib/lexical/wordbookReview': review,
  '@/lib/studentDates': require('../lib/studentDates.ts'), '@/lib/studentNavigation': { STUDENT_ROUTES: { home: '/student', wordbook: '/student/wordbook' } }
};
test('shared wordbook view shows only bound tabs, one history entry, no management UI; student defaults retain both tabs and writes', () => {
  const { WordbookView } = compile('components/student/StudentWordbook.tsx', { ...commonMocks,
    '@/components/student/StudentUI': { StudentNavigation: () => null }, '@/components/student/StudentDateSelection': { StudentDateSelection: () => null },
    './WordbookExample': { WordbookExample: ({ text }) => text }, '@/components/shared/ConfirmDialog': { ConfirmDialog: () => null },
    '@/lib/lexical/wordbookManagement': require('../lib/lexical/wordbookManagement.ts'),
    '@/lib/lexical/wordbookPresentation': require('../lib/lexical/wordbookPresentation.ts'), './StudentWordbook.module.css': {} });
  const access = { getSession: () => null, sessionReady: false, studentId: student };
  for (const domains of [['reading'], ['writing'], ['reading', 'writing']]) {
    const html = renderToStaticMarkup(React.createElement(WordbookView, { access, domains, readOnly: true, navigation: null,
      apiRoot: '/api/teacher/students/target/wordbook', historyHref: domain => `/teacher/history?domain=${domain}` }));
    assert.equal((html.match(/>复习历史</g) ?? []).length, 1);
    assert.doesNotMatch(html, /管理|开始复习|删除|错词再练|开始测试|type="checkbox"|href="\/student/);
    if (domains.length === 1) { assert.doesNotMatch(html, /role="tab"/); assert.doesNotMatch(html, domains[0] === 'reading' ? /Writing/ : /Reading/); }
    else assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
  }
  const html = renderToStaticMarkup(React.createElement(WordbookView, { access }));
  assert.match(html, />管理</); assert.match(html, />开始复习</); assert.equal((html.match(/role="tab"/g) ?? []).length, 2);
});

test('history and result reuse student displays without resume, retry, new-round or test actions in teacher mode', () => {
  const { WordbookReviewHistoryList } = compile('components/student/WordbookReview.tsx', { ...commonMocks,
    'next/navigation': {}, './StudentUI': {}, './StudentDateSelection': {}, './WordbookReviewWorkspace': {}, './useWordbookLocalReview': {}, './StudentWordbook': {},
    '@/lib/lexical/wordbookReviewRequest': {}, '@/lib/lexical/wordbookReviewLocal': {}, './WordbookReviewSetup.module.css': {} });
  const f = fixture(); const session = f.tables.student_wordbook_review_sessions[0];
  const history = { items: [{ ...session, summary }, { ...session, session_id: sid(88), status: 'active', summary }], total: 2 };
  const html = renderToStaticMarkup(React.createElement(WordbookReviewHistoryList, { history, readOnly: true, resultHref: id => `/teacher/result/${id}` }));
  assert.match(html, /查看结果/); assert.match(html, /查看已保存记录/); assert.match(html, /答对 4/);
  assert.doesNotMatch(html, /恢复复习|开始新复习|href="\/student/);
  const { WordbookReviewResult } = compile('components/student/WordbookReviewWorkspace.tsx', { ...commonMocks,
    './WordbookReviewWorkspace.module.css': {}, '@/lib/lexical/wordbookReviewInput': {} });
  const state = { session, summary };
  const teacherHtml = renderToStaticMarkup(React.createElement(WordbookReviewResult, { state, readOnly: true }));
  const studentHtml = renderToStaticMarkup(React.createElement(WordbookReviewResult, { state }));
  assert.match(teacherHtml, /80%/); assert.match(teacherHtml, /2\/3 · 67%/); assert.match(teacherHtml, /3\/3 · 100%/);
  assert.doesNotMatch(teacherHtml, /button|href=|错词再练|新一轮复习/);
  assert.match(studentHtml, /错词再练/); assert.match(studentHtml, /新一轮复习/);
  assert.equal(teacherHtml.slice(0, teacherHtml.lastIndexOf('</dl>') + 5), studentHtml.slice(0, studentHtml.lastIndexOf('</dl>') + 5));
});

test('student-detail entry is lazy, right aligned and preserves teacher return context; no new wordbook fetch on the detail home', () => {
  const source = read('components/teacher/TeacherStudentPracticeSection.tsx');
  assert.match(source, /teacher-button-primary ml-auto shrink-0 gap-2/);
  assert.match(source, /<BookMarked aria-hidden="true" size=\{18\}/);
  assert.match(read('components/student/StudentShell.tsx'), /href: STUDENT_ROUTES.wordbook,\s+icon: BookMarked/);
  assert.match(source, /teacherReturnToHref\(`\/teacher\/students\/\$\{encodeURIComponent\(studentId\)\}\/wordbook`, selfHref\)/);
  assert.match(source, /prefetch=\{false\}>\s*<BookMarked[^\n]+生词本/);
  assert.doesNotMatch(source, /api\/teacher[^\n]*wordbook|useWordbookRead/);
});

test('isolated Postgres: teacher results equal student saved results and succeed inside READ ONLY without initializing flow',
  { skip: !process.env.WORDBOOK_SQL_TEST_PGLITE }, async () => {
    const h = require('./helpers/wordbookReviewFixture.cjs');
    const sql = await h.fixture();
    try {
      await sql.exec(h.read('supabase/student_wordbook_review_v1_immersive_migration.sql'));
      await h.save(sql);
      const active = await h.create(sql), completed = await h.create(sql);
      await h.submit(sql, completed.session.session_id, completed.item.itemId, { spelling: 'run', pos: 'verb' });
      const adapter = require('./helpers/wordbookReviewApiFixture.cjs').client(sql);
      const db = {
        async rpc(name, args) {
          assert.equal(name, 'wordbook_review_read');
          try {
            return { data: (await sql.query('select wordbook_review_read($1,$2,$3) result',
              [args.p_student, args.p_session, args.p_position])).rows[0].result };
          } catch (error) { return { error }; }
        },
        from(table) {
          const builder = adapter.from(table);
          builder.maybeSingle = async () => { const result = await builder; return { ...result, data: result.data?.[0] ?? null }; };
          return builder;
        }
      };
      const { teacherWordbookRead } = compile('lib/lexical/teacherWordbook.server.ts', {
        '@/lib/auth': { bearerToken: () => 'offline', requireTeacherOnly: async () => ({ userId: teacher, role: 'teacher' }) },
        '@/lib/supabase/server': { createServiceSupabase: () => db },
        '@/lib/teacherScope.server': { loadTeacherScope: async () => ({
          studentProfiles: new Map([[h.U, { displayName: 'Isolated student' }]]), studentDomains: new Map([[h.U, ['reading']]])
        }) },
        '@/lib/reading/attemptServer': { readingAttemptJson: json }, './wordbookList.ts': list,
        './wordbookList.server.ts': listServer, './wordbookReview.ts': review, './wordbookReview.server.ts': { reviewRpc }
      });
      for (const round of [active, completed]) {
        const expected = await h.get(sql, round.session.session_id);
        await sql.exec('begin read only');
        const response = await teacherWordbookRead(new Request('https://offline.invalid/api?domain=reading'),
          { studentId: h.U, sessionId: round.session.session_id }, 'result');
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), expected);
        await sql.exec('rollback');
      }
      assert.equal((await sql.query('select count(*)::int n from student_wordbook_review_flow')).rows[0].n, 0);
      // Even the service-only student write RPCs enforce the target's owner.
      await assert.rejects(h.submit(sql, active.session.session_id, active.item.itemId, { spelling: 'run', pos: 'verb' }, h.V), /REVIEW_NOT_FOUND/);
      await assert.rejects(h.create(sql, {}, h.V, completed.session.session_id), /REVIEW_NOT_FOUND/);
    } finally { await sql.close(); }
  });
