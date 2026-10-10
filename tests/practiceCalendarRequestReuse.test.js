const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { harness, compile, scheduler } = require('./helpers/wordbookReadHarness.cjs');
const { parsePracticeActivityQuery, readPracticeActivityDates } = require('../lib/practiceActivityDates.server.ts');
const { parseWordbookQuery } = require('../lib/lexical/wordbookList.ts');
const { readWordbookReviewHistory } = require('../lib/lexical/wordbookList.server.ts');

for (const kind of ['student', 'teacher']) {
  test(`${kind}: real read hook + existing layout cache reuse subjects/months/details, auth notifications never reload`, async () => {
    const h = await harness(kind); const r = h.reader();
    try {
      const root = kind === 'student' ? '/api/student/wordbook' : '/api/teacher/students/student-a/wordbook';
      const reading = root + '?domain=reading', writing = root + '?domain=writing';
      const oldest = root + '?domain=reading&sort=oldest';
      const month = root + '/activity-dates?domain=reading&month=2026-10';
      const oldMonth = root + '/activity-dates?domain=reading&month=2026-09';
      const history = root + '/review/history?domain=reading&page=1';
      const detail = root + '/review/round-a?domain=reading';
      assert.equal(r.read(null).loading,false);assert.equal(r.requests.length,0);
      for (const url of [reading, writing, oldest, month, oldMonth, history, detail]) {
        assert.equal(r.read(url).loading, true); r.requests.at(-1).resolve({ url }); await h.tick();
        assert.deepEqual(r.read(url).data, { url });
      }
      const count = r.requests.length;
      for (const url of [reading, writing, reading, writing, oldest, reading, oldest, month, oldMonth, month, history, detail, history, detail]) {
        const read = r.read(url); assert.equal(read.loading, false); assert.equal(read.data.url, url);
      }
      for (let i = 0; i < 3; i++) { h.authEvent(); assert.equal(r.read(writing).loading, false); }
      assert.equal(r.requests.length, count);
      // Remount a page/detail with the SAME layout provider. No request/blank paint.
      const reopened = h.reader(); assert.equal(reopened.read(reading).data.url, reading); assert.equal(reopened.requests.length, 0);
      assert.equal(reopened.read(detail).data.url,detail);assert.equal(reopened.requests.length,0);
      assert.equal(reopened.read(detail,0,{sessionReady:false}).data.url,detail);
      assert.equal(reopened.read(detail,0,{sessionReady:false}).loading,false);assert.equal(reopened.requests.length,0);
      const unauthorized = reopened.read(writing, 0, { studentId: 'student-b' });
      assert.equal(unauthorized.data, undefined); assert.equal(unauthorized.loading, true);
    } finally { h.cleanup(); }
  });

  test(`${kind}: collection mutation refreshes only matching student/domain, not review snapshots; late old reads cannot restore data`, async () => {
    const h = await harness(kind); const r = h.reader();
    try {
      const reading = '/api/student/wordbook?domain=reading';
      const writing = '/api/student/wordbook?domain=writing';
      const result = '/api/student/wordbook/review/session?domain=reading';
      for (const url of [reading, writing, result]) { r.read(url); r.requests.at(-1).resolve({ url, version: 1 }); await h.tick(); r.read(url); }
      const before = r.requests.length;
      h.emit({ type: 'WORDBOOK_CHANGED', studentId: 'student-a', wordbookDomain: 'reading' });
      assert.equal(r.read(writing).data.version, 1); assert.equal(r.read(result).data.version, 1); assert.equal(r.requests.length, before);
      r.read(reading); assert.equal(r.requests.length, before + 1); const old = r.requests.at(-1);
      h.emit({ type: 'WORDBOOK_CHANGED', studentId: 'student-a', wordbookDomain: 'reading' });
      r.read(reading); const fresh = r.requests.at(-1); assert.notEqual(old, fresh);
      old.resolve({ version: 0 }); await h.tick(); assert.notEqual(r.read(reading).data?.version, 0);
      fresh.resolve({ version: 2 }); await h.tick(); assert.equal(r.read(reading).data.version, 2);
    } finally { h.cleanup(); }
  });

  test(`${kind}: new/changed review invalidates only its domain history and affected result, preserving other rounds and subjects`, async()=>{
    const h=await harness(kind),r=h.reader();
    try{
      const root=kind==='student'?'/api/student/wordbook/review':'/api/teacher/students/student-a/wordbook/review';
      const list=`${root}/history?domain=reading`,dates=`${root}/activity-dates?domain=reading&month=2026-10`,
        detail=kind==='student'?`${root}/round-a?round=1`:`${root}/round-a?domain=reading`,other=`${root}/round-b?domain=reading`,writing=`${root}/history?domain=writing`;
      for(const url of [list,dates,detail,other,writing]){r.read(url);r.requests.at(-1).resolve({url});await h.tick();r.read(url);}
      h.emit({type:'WORDBOOK_REVIEW_CHANGED',studentId:'student-b',wordbookDomain:'reading',reviewSessionId:'round-a'});
      r.read(list);assert.equal(r.requests.length,5);
      h.emit({type:'WORDBOOK_REVIEW_CHANGED',studentId:'student-a',wordbookDomain:'reading',reviewSessionId:'round-a'});
      r.read(writing);r.read(other);assert.equal(r.requests.length,5);
      r.read(list);r.read(dates);r.read(detail);assert.equal(r.requests.length,8);
    }finally{h.cleanup();}
  });
}

test('student completed result renders the cached round on the first hook render without waiting for an effect or exposing a different owner',()=>{
  const runner=scheduler(),local=require('../lib/lexical/wordbookReviewLocal.ts');
  const round={session:{session_id:'round-a',domain:'reading',total:1,answered:1,status:'completed'},composition:{spellingPos:1,meaningChoice:0},
    cards:[{itemId:'one',position:1,kind:'spelling_pos',sourceTypes:['ctw'],targetForms:['yield'],expected:{expression:'yield',pos:'noun',standardPos:'noun',meaning:'产量',examples:[]}}]};
  const hook=compile('components/student/useWordbookLocalReview.ts',{
    react:runner.hooks,'@/components/StudentDataCache':{useStudentDataCache:()=>({invalidate(){},getEntry:key=>key.startsWith('student-a:')?{status:'success',data:round}:undefined})},
    './StudentWordbook':{wordbookReadCacheKey:(_url,access)=>`${access.studentId}:round-a`},
    '@/lib/lexical/wordbookReviewLocal':local,'@/lib/lexical/wordbookReviewRequest':{},'@/lib/cacheInvalidation':{}
  });
  const request=()=>{throw Error('First render must not request data');};
  const state=runner.render(()=>hook.useWordbookLocalReview('student-a','round-a',request)).state;
  assert.equal(state.flow.phase,'result');assert.equal(state.session.session_id,'round-a');
  assert.equal(runner.render(()=>hook.useWordbookLocalReview('student-b','round-a',request)).state,undefined);
});

test('teacher binding removal invalidates cached scope/list/details; late in-flight responses cannot restore revoked data',async()=>{
  const h=await harness('teacher'),r=h.reader();
  try{
    const root='/api/teacher/students/student-a/wordbook',scope=root+'/scope',list=root+'?domain=reading';
    r.read(scope);r.requests.at(-1).resolve({domains:['reading']});await h.tick();assert.ok(r.read(scope).data);
    r.read(list);const old=r.requests.at(-1);
    h.emit({type:'TEACHER_BINDING_UPDATED',studentId:'student-a'});
    assert.equal(h.cache.getEntry(r.module.wordbookReadCacheKey(scope,r.access)),undefined);
    old.resolve({items:['revoked']});await h.tick();
    assert.equal(h.cache.getEntry(r.module.wordbookReadCacheKey(list,r.access)),undefined);
  }finally{h.cleanup();}
});

test('monthly query rejects owner injection, duplicates, invalid months/timezones/tasks; permission intersection happens before ONE dates-only RPC', async () => {
  for (const query of ['month=2026-06', 'month=2026-13', 'month=2099-01', 'month=2026-10&studentId=other',
    'month=2026-10&month=2026-10', 'month=2026-10&timeZone=invalid', 'month=2026-10&tasks=ctw,ctw', 'month=2026-10&tasks=bad']) {
    assert.throws(() => parsePracticeActivityQuery(new URLSearchParams(query)));
  }
  const calls = [], db = { from() { throw Error('No history/content queries allowed'); }, rpc: async (name, args) => {
    calls.push({ name, args }); return { data: ['2026-10-02'] };
  } };
  const query = parsePracticeActivityQuery(new URLSearchParams('month=2026-10&tasks=ctw,email'));
  assert.deepEqual((await readPracticeActivityDates(db, 'student-a', query, ['reading'], true)).dates, ['2026-10-02']);
  assert.equal(calls.length, 1); assert.equal(calls[0].name, 'read_practice_activity_dates_v1');
  assert.deepEqual(calls[0].args.p_tasks, ['ctw']); assert.equal(calls[0].args.p_student, 'student-a');
  await readPracticeActivityDates(db, 'student-a', { ...query, tasks: ['email'] }, ['reading'], true);
  assert.equal(calls.length, 1);
});

test('student/teacher dates routes authenticate bindings, deny unbound students and never query unauthorized domains', async () => {
  let role = 'teacher', bound = ['reading']; const calls = [];
  const db = { rpc: async (name, args) => { calls.push(args); return { data: [] }; } };
  const route = compile('app/api/teacher/students/[studentId]/practice/activity-dates/route.ts', {
    '@/lib/auth': { bearerToken: () => '', requireTeacherOnly: async () => ({ userId: 'teacher', role }) },
    '@/lib/reading/attemptServer': { readingAttemptJson: Response.json }, '@/lib/supabase/server': { createServiceSupabase: () => db },
    '@/lib/teacherScope.server': { loadTeacherScope: async () => ({ studentProfiles: new Map([['student-a', {}]]), studentDomains: new Map([['student-a', bound]]) }) },
    '@/lib/practiceActivityDates.server': { parsePracticeActivityQuery, readPracticeActivityDates }
  });
  const send = id => route.GET(new Request('http://offline.invalid/?month=2026-10&tasks=ctw,email'), { params: { studentId: id } });
  assert.equal((await send('student-a')).status, 200); assert.deepEqual(calls[0].p_tasks, ['ctw']);
  assert.equal((await send('student-b')).status, 403);
  bound = []; assert.equal((await send('student-a')).status, 403);
  bound = ['writing']; assert.equal((await send('student-a')).status, 200); assert.deepEqual(calls[1].p_tasks, ['email']);
  role = 'admin'; assert.equal((await send('student-a')).status, 403); assert.equal(calls.length, 2);
  let userId = 'student-a', denied = false;
  const student = compile('app/api/student/practice-history/activity-dates/route.ts', {
    '@/lib/auth': { bearerToken: () => '', requireUserWithRole: async () => ({ userId, error: denied ? 'unauthorized' : null }) },
    '@/lib/reading/attemptServer': { readingAttemptJson: Response.json }, '@/lib/supabase/server': { createServiceSupabase: () => db },
    '@/lib/practiceActivityDates.server': { parsePracticeActivityQuery, readPracticeActivityDates }
  });
  const studentSend = query => student.GET(new Request(`http://offline.invalid/?${query}`));
  assert.equal((await studentSend('month=2026-10&tasks=ctw,email')).status,200);
  assert.equal(calls[2].p_student,userId);assert.deepEqual(calls[2].p_tasks,['ctw','email']);
  assert.equal((await studentSend('month=2026-10&studentId=student-b')).status,400);
  denied=true;assert.equal((await studentSend('month=2026-10')).status,401);assert.equal(calls.length,3);
});

test('review list and calendar use one summary/dates RPC each, never a full result read', async () => {
  const calls = [], db = { rpc: async (name, args) => { calls.push({ name, args }); return { data: args.p_month ? { dates: [] } : { items: [], total: 0 } }; } };
  await readWordbookReviewHistory(db, 'student-a', parseWordbookQuery(new URLSearchParams('domain=writing&page=2&start=2026-10-01&end=2026-10-03')));
  await readWordbookReviewHistory(db, 'student-a', parseWordbookQuery(new URLSearchParams('domain=reading&month=2026-10')));
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.name === 'read_wordbook_review_history_v1'));
  assert.equal(calls[0].args.p_domain, 'writing'); assert.equal(calls[0].args.p_page, 2);
  assert.equal(calls[1].args.p_month, '2026-10-01');
});

test('student review history rejects invalid filters before SQL and returns explicit 503 if the manual RPC is unavailable', async()=>{
  const review = require('../lib/lexical/wordbookReview.ts');
  let calls=0;
  const route=compile('app/api/student/wordbook/review/route.ts',{
    '@/lib/reading/attemptServer':{requireReadingAttemptStudent:async()=>({userId:'student-a'}),readingAttemptJson:Response.json},
    '@/lib/supabase/server':{createServiceSupabase:()=>({rpc:async()=>{calls++;return {error:{message:'missing function'}};}})},
    '@/lib/lexical/wordbookReview':review,'@/lib/lexical/wordbookReview.server':{},'@/lib/lexical/wordbookReviewRound.server':{},
    '@/lib/lexical/wordbookList':{parseWordbookQuery},'@/lib/lexical/wordbookList.server':{readWordbookReviewHistory}
  });
  const send=query=>route.GET(new Request(`http://offline.invalid/?${query}`));
  for(const query of ['action=history&domain=other','action=history&page=0','action=history&timeZone=invalid',
    'action=history&start=not-a-date','action=history&domain=reading&domain=writing','action=history-dates',
    'action=history&month=2026-10','action=history&studentId=student-b']) assert.equal((await send(query)).status,400);
  assert.equal(calls,0);assert.equal((await send('action=history&domain=reading')).status,503);assert.equal(calls,1);
});

test('offline PostgreSQL: additive read-only SQL preserves records, dedupes only dates, scopes months/tasks/owners and returns summary-only review pages',
  { skip: !process.env.WORDBOOK_SQL_TEST_PGLITE }, async () => {
    const h = require('./helpers/wordbookReviewFixture.cjs'), db = await h.fixture();
    try {
      await db.exec(`create table reading_attempts(student_id uuid,task_type text,status text,submitted_at timestamptz);
        create table attempts(student_id uuid,set_id text,submitted_at timestamptz);
        create table writing_attempts(user_id uuid,task_type text,status text,submitted_at timestamptz);
        create table reading_full_set_attempts(student_id uuid,status text,completed_at timestamptz);
        create table reading_question_category_sessions(student_id uuid,status text,completed_at timestamptz);
        create table reading_wrongbook_attempts(attempt_id text,student_id uuid,task_type text,status text,submitted_at timestamptz);
        create table student_wrong_question_sessions(student_id uuid,status text,task_type text,created_at timestamptz,completed_at timestamptz,progress jsonb);
        insert into reading_attempts values ('${h.U}','ctw','submitted','2026-10-01T16:00Z'),('${h.U}','ctw','submitted','2026-10-02T01:00Z'),
          ('${h.U}','rap','draft','2026-10-03T01:00Z'),('${h.V}','ctw','submitted','2026-10-04T01:00Z'),('${h.U}','ctw','submitted','2026-09-01T01:00Z'),
          ('${h.V}','ctw','submitted','2026-09-30T14:30Z'),('${h.V}','ctw','submitted','2026-10-03T13:30Z'),('${h.V}','ctw','submitted','2026-10-03T14:30Z');
        insert into attempts values('${h.U}','normal','2026-10-05T01:00Z'),('${h.U}','wrongbook-today','2026-10-06T01:00Z'),('${h.U}','grammar-all-1','2026-10-07T01:00Z');
        insert into writing_attempts values('${h.U}','email','submitted','2026-10-08T01:00Z'),('${h.U}','academic_discussion','draft','2026-10-09T01:00Z');
        insert into reading_full_set_attempts values('${h.U}','completed','2026-10-09T01:00Z');
        insert into reading_question_category_sessions values('${h.U}','completed','2026-10-03T01:00Z');
        insert into reading_wrongbook_attempts values('a','${h.U}','ctw','submitted','2026-10-04T01:00Z'),('b','${h.U}','rdl','submitted','2026-10-07T01:00Z'),
          ('c','${h.U}','ctw','submitted','2026-10-08T01:00Z'),('d','${h.U}','rdl','submitted','2026-10-08T02:00Z');
        insert into student_wrong_question_sessions values('${h.U}','active','ctw','2026-10-01',null,'{"one":{"attemptId":"a"}}'),
          ('${h.U}','completed','mixed','2026-10-08','2026-10-08T02:00Z','{"one":{"attemptId":"c"},"two":{"attemptId":"d"}}');`);
      await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/practice_calendar_wordbook_reads_20261010.sql'), 'utf8'));
      const dates = async (tasks, teacher = false, month = '2026-10-01') => (await db.query(
        'select read_practice_activity_dates_v1($1,$2,$3,$4,$5) result', [h.U, month, 'Asia/Shanghai', tasks, teacher])).rows[0].result;
      await db.exec('begin read only');
      assert.deepEqual(await dates(['ctw']), ['2026-10-02']);
      assert.deepEqual(await dates(['ctw'], true), ['2026-10-02','2026-10-08']); // unfinished excluded; mixed inherits first task
      assert.deepEqual(await dates(['rap','full_set']), ['2026-10-03','2026-10-09']);
      assert.deepEqual(await dates(['rdl'], true), ['2026-10-07']);
      assert.deepEqual(await dates(['build_sentence']), ['2026-10-05']);
      assert.deepEqual(await dates(['build_sentence'], true), ['2026-10-05','2026-10-06','2026-10-07']);
      assert.deepEqual(await dates(['email']), ['2026-10-08']);
      assert.deepEqual(await dates(['ctw'], false, '2026-07-01'), []);
      assert.deepEqual((await db.query("select read_practice_activity_dates_v1($1,'2026-10-01','Australia/Sydney',array['ctw'],false) result",[h.V])).rows[0].result,
        ['2026-10-01','2026-10-03','2026-10-04']); // local month boundary and DST transition
      assert.equal((await db.query('select count(*)::int n from reading_attempts')).rows[0].n, 8);
      await db.exec('commit');
      for (const month of ['2026-06-01','2099-01-01','2026-10-02']) await assert.rejects(dates(['ctw'], false, month));
      await h.save(db); const round = await h.create(db); await h.submit(db, round.session.session_id, round.item.itemId, { spelling: 'run', pos: 'verb' });
      const original = await h.get(db, round.session.session_id);
      await db.exec('begin read only');
      const history = (await db.query('select read_wordbook_review_history_v1($1,$2) result', [h.U,'reading'])).rows[0].result;
      assert.equal(history.total, 1); assert.equal(history.items.length, 1); assert.deepEqual(history.items[0].summary, original.summary);
      assert.equal(history.items[0].session_id, round.session.session_id); assert.equal(history.items[0].item, undefined);
      const empty = (await db.query('select read_wordbook_review_history_v1($1,$2) result', [h.U,'writing'])).rows[0].result;
      assert.equal(empty.total, 0);
      const month = (await db.query("select read_wordbook_review_history_v1($1,'reading',1,null,null,'2026-10-01','Asia/Shanghai') result", [h.U])).rows[0].result;
      assert.deepEqual(Object.keys(month), ['dates']); assert.equal(month.dates.length, 1);
      await db.exec('commit');
      for (const role of ['anon','authenticated']) {
        await db.exec(`set role ${role}`); await assert.rejects(dates(['ctw']), /permission denied/); await db.exec('reset role');
      }
    } finally { await db.close(); }
  });
