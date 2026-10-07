const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCategoryDraftQueue } = require('../lib/reading/categoryDraftQueue.ts');
const { categoryWorkspace, categoryResultHref, categorySourceElapsedSeconds } = require('../lib/reading/questionCategory.ts');
const { getReadingCategoryResultNavigation, withStudentReturnTo, safeStudentReturnTo } = require('../lib/studentNavigation.ts');
const { studentPracticeRecordResultTarget } = require('../lib/studentPracticeHistory.ts');
const read = (f) => fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('category history result/review chain preserves exact returnTo after refresh', () => {
  const history = '/student/practice-history?date=2026-10-07&task=rap';
  const record = {kind:'question_category',attemptId:'s',taskType:'rap'};
  const result = studentPracticeRecordResultTarget(record,history).href;
  const url = new URL(result,'https://fixture.invalid');
  assert.equal(url.pathname,categoryResultHref('s'));
  assert.equal(url.searchParams.get('returnTo'),history);
  const nav = getReadingCategoryResultNavigation(url.searchParams.get('returnTo'));
  assert.equal(nav.backHref,history);
  assert.deepEqual(nav.crumbs.map(c=>c.label),['学生首页','练习历史','练习结果']);
  const review = new URL(withStudentReturnTo(`${url.pathname}/questions/1`,history),'https://fixture.invalid');
  const resultBack = withStudentReturnTo(categoryResultHref('s'),safeStudentReturnTo(review.searchParams.get('returnTo')));
  assert.equal(resultBack,result);
  for (const file of ['app/student/question-category-practice/sessions/[sessionId]/page.tsx',
    'app/student/question-category-practice/sessions/[sessionId]/questions/[questionIndex]/page.tsx']) assert.match(read(file),/safeStudentReturnTo\(searchParams.returnTo\)/);
});
test('direct category result defaults to catalog and unsafe context is rejected', () => {
  for (const returnTo of [undefined,'https://evil.invalid/student/practice-history','//evil.invalid/student/x','/teacher/x']) {
    const nav = getReadingCategoryResultNavigation(returnTo);
    assert.equal(nav.backHref,'/student/question-category-practice');
    assert.deepEqual(nav.crumbs.map(c=>c.label),['学生首页','按题型分类练习','练习结果']);
  }
});
test('result reuses the same StudentPage as wrongbook, without bespoke sidebar CSS',()=>{
  for(const file of ['app/student/question-category-practice/sessions/[sessionId]/page.tsx','app/student/wrong-questions/sessions/[sessionId]/page.tsx']) {
    assert.match(read(file),/<StudentPage title="查看阅读结果">/);
    assert.doesNotMatch(read(file),/margin-left|padding-left|calc\(/);
  }
});
test('workspace lookup restores every group, including legacy single-workspace draft',()=>{
  const A = {answers:{q:'a'},elapsedSeconds:10}; const B = {answers:{q:'b'},elapsedSeconds:12};
  assert.equal(categoryWorkspace({draft:{workspaces:{A,B}}},'A'),A);
  assert.equal(categoryWorkspace({draft:{workspaces:{A,B}}},'B'),B);
  assert.equal(categoryWorkspace({draft:{logicalItemId:'A',workspace:A}},'A'),A);
  assert.equal(categoryWorkspace({draft:{logicalItemId:'A',workspace:A}},'B'),undefined);
});
test('resume seeds saved + dirty source seconds once, even for passages not yet hydrated',()=>{
  const session={groups:[{logicalItemId:'A'},{logicalItemId:'B'},{logicalItemId:'C'}],
    progress:{A:{elapsedSeconds:10},B:{elapsedSeconds:5}},
    draft:{workspaces:{A:{elapsedSeconds:12},B:{elapsedSeconds:8}}}};
  assert.deepEqual(categorySourceElapsedSeconds(session),{A:12,B:8,C:0});
  assert.equal(Object.values(categorySourceElapsedSeconds(session)).reduce((a,b)=>a+b,0),20);
  assert.match(read('components/reading/ReadingMultiSourceSessionRunner.tsx'),/sourceTimes = useRef<Record<string, number>>\(\{ \.\.\.practiceSession.sourceElapsedSeconds \}\)/);
});
test('draft queue coalesces typing and flushes before source leave/final Submit',async()=>{
  const writes=[]; let release;
  const queue=createCategoryDraftQueue(async(item,draft)=>{writes.push([item,draft]); if(draft===2) await new Promise(r=>{release=r;});});
  queue.schedule('A',1,()=>{}); queue.schedule('A',2,()=>{});
  const A=queue.flush('A'); await Promise.resolve();
  queue.schedule('B',3,()=>{}); const B=queue.flush('B'); await Promise.resolve();
  assert.deepEqual(writes,[['A',2]]);
  release(); await A; await B;
  assert.deepEqual(writes,[['A',2],['B',3]]); queue.dispose();
});
test('autosave errors cannot be swallowed by navigation flush; newer snapshot can recover',async()=>{
  let fail=true; const queue=createCategoryDraftQueue(async()=>{if(fail) throw new Error('offline');});
  queue.schedule('A',1,()=>{});
  await assert.rejects(queue.flush('A'),/offline/);
  fail=false; queue.schedule('A',2,()=>{}); await queue.flush('A'); queue.dispose();
});
test('finishing does not publish a submitted source frame; category/wrongbook editability stays separate',()=>{
  const runner=read('components/reading/ReadingMultiSourceSessionRunner.tsx');
  const finishing=runner.slice(runner.indexOf('if (source.sessionCompleted'),runner.indexOf('const initialAnswers = source.prepareAnswers'));
  assert.match(finishing,/finished.current = true;[\s\S]*onCompleted\(\);[\s\S]*return;/);
  assert.doesNotMatch(finishing,/setRendered|setSubmitting\(false\)/);
  assert.match(runner,/pending: pending \|\| submitting/);
  const shell=read('components/reading/ReadingPractice.tsx');
  assert.match(shell,/session\?\.sourceReadOnly \?\? attempt.status === "submitted"/);
  assert.match(shell,/questionClockPausedRef/);
});
test('incremental RPC covers saved-group updates, recompute, atomic final bank, and freeze',()=>{
  const sql=read('supabase/reading_question_category_editable_20261007.sql');
  assert.doesNotMatch(sql,/create table|alter table|update public.reading_questions/i);
  assert.match(sql,/on conflict \(session_id,question_id\) do update/);
  assert.match(sql,/greatest\(answer.question_time_seconds,excluded.question_time_seconds\)/);
  assert.match(sql,/elapsed_seconds = v_elapsed,total_points = v_total,correct_points = v_correct/);
  assert.match(sql,/if p_finalize then[\s\S]*where session_id = p_session_id and not is_correct;[\s\S]*apply_student_wrong_question_events/);
  assert.ok(sql.indexOf("if v_session.status = 'completed' then\n    return")<sql.indexOf('insert into public.reading_question_category_session_answers'));
  assert.doesNotMatch(read('app/api/reading/question-category/sessions/[sessionId]/groups/[itemId]/route.ts'),/applyReadingGradedWrongEvents/);
});
