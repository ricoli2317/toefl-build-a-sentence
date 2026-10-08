const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseWordbookQuery, zonedMidnight, wordbookContextRows, WORDBOOK_HEADERS } = require('../lib/lexical/wordbookList.ts');
const { readWordbookList, readWordbookActivityDates } = require('../lib/lexical/wordbookList.server.ts');
const { localDayRange, parseDateInputValue, normalizeDateDraft } = require('../lib/studentDates.ts');
const read = p => fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const sql = read('supabase/student_wordbook_v1_phase_a3_20261008.sql');
const preflight = read('supabase/student_wordbook_v1_phase_a3_preflight_20261008.sql');
const runtime = process.env.WORDBOOK_SQL_TEST_PGLITE;
const PGlite = runtime ? require(path.resolve(runtime)).PGlite : null;
const engineTest = (name,fn) => test(name,{ skip:!PGlite },fn);
const model = read('tests/studentWordbookSql.test.js');
const dependencies = vm.runInNewContext(model.slice(model.indexOf('const U1 ='),model.indexOf('async function fixture()')) + '\ndependencies;');
const U='00000000-0000-4000-8000-000000000001', V='00000000-0000-4000-8000-000000000002';
const E='00000000-0000-4000-8000-000000000011', O='00000000-0000-4000-8000-000000000013';
async function fixture(install=true) {
  const db=new PGlite();
  await db.exec(dependencies);
  await db.exec(read('supabase/student_wordbook_v1_20261008.sql'));
  await db.exec(read('supabase/student_wordbook_v1_phase_a2_20261008.sql'));
  await db.exec(`grant select on profiles to service_role;
    update lexical_occurrences set context_text='We run daily.',start_offset=3,end_offset=6,surface_text='run',context_pos='verb' where occurrence_id='${O}';
    insert into lexical_source_blocks values('00000000-0000-4000-8000-000000000014','ctw','fixture','paragraph:p','ctw_paragraph','hash','generated');`);
  if(install) { await db.exec(preflight);await db.exec(sql); }
  return db;
}
async function payload(db,occ=O) {
  const o=(await db.query('select * from lexical_occurrences where occurrence_id=$1',[occ])).rows[0];
  const e=(await db.query('select * from lexical_entries where entry_id=$1',[o.entry_id])).rows[0];
  const b=(await db.query('select * from lexical_source_blocks where source_type=$1 and source_item_id=$2 and content_block_id=$3',[o.source_type,o.source_item_id,o.content_block_id])).rows[0];
  return { ...Object.fromEntries(['entry_id','source_type','source_item_id','content_block_id','start_offset','end_offset','surface_text','context_text','sentence_id','context_pos','context_meaning_zh','context_definition_en'].map(k=>[k,o[k]])),
    ...Object.fromEntries(['canonical_expression','normalized_expression','expression_type','identity_variant'].map(k=>[k,e[k]])),
    source_text_hash:b.source_text_hash,source_block_kind:b.block_kind,example_text:o.context_text,context_kind:'sentence',extraction_method:'whole_sentence_block' };
}
async function save(db,action='save',user=U,occ=O) {
  return (await db.query('select operate_student_wordbook_v1($1,$2,$3,$4::jsonb) result',[user,occ,action,JSON.stringify(await payload(db,occ))])).rows[0].result;
}
const events=async(db,user=U,domain='reading')=>(await db.query('select * from student_wordbook_activities where student_id=$1 and domain=$2 order by activity_at,activity_id',[user,domain])).rows;
const list=async(db,{ user=U,domain='reading',page=1,size=20,sort='newest',start=null,end=null }={})=>(await db.query('select read_student_wordbook_v1($1,$2,$3,$4,$5,$6,$7) result',[user,domain,page,size,sort,start,end])).rows[0].result;
const dates=async(db,domain='reading',zone='Asia/Shanghai',month='2026-10-01',user=U)=>(await db.query('select read_student_wordbook_activity_dates_v1($1,$2,$3,$4) result',[user,domain,zone,month])).rows[0].result;

test('API parses strict owner-free paging/single day/range, timezone/DST boundaries and invalid input',()=>{
  const q=parseWordbookQuery(new URLSearchParams('domain=reading&date=2026-10-08&timeZone=Asia/Shanghai'));
  assert.equal(q.startAt,'2026-10-07T16:00:00.000Z');assert.equal(q.endAt,'2026-10-08T16:00:00.000Z');
  const dst=parseWordbookQuery(new URLSearchParams('start=2026-03-08&end=2026-03-08&timeZone=America/New_York'));
  assert.equal((Date.parse(dst.endAt)-Date.parse(dst.startAt))/3600000,23);
  assert.equal(zonedMidnight('2026-11-01','America/New_York'),'2026-11-01T04:00:00.000Z');
  const reverse=parseWordbookQuery(new URLSearchParams('start=2026-10-10&end=2026-10-08'));
  assert.equal(reverse.startAt,q.startAt);
  for(const params of ['student_id=other','page=0','page=1.5','pageSize=51','sort=bad','date=2026-02-30','start=2026-10-08&date=2026-10-09','domain=other','timeZone=bad','month=2026-13','end=2026-10-08','domain=reading&domain=writing'])
    assert.throws(()=>parseWordbookQuery(new URLSearchParams(params)),params);
  assert.equal(parseDateInputValue('2026-02-30'),null);
  assert.deepEqual(normalizeDateDraft({ start:'2026-10-10',end:'2026-10-08' },''),{ start:'2026-10-08',end:'2026-10-10' });
  assert.ok(localDayRange(new Date()).startAt);
});
test('server performs one scoped paginated RPC or light month RPC, surfaces missing A3 rather than fake empty data',async()=>{
  const calls=[];const db={ rpc:async(name,args)=>{ calls.push({name,args});return {data:name.includes('dates')?['2026-10-08']:{items:[],total:0,page:1,pageSize:20},error:null}; } };
  const q=parseWordbookQuery(new URLSearchParams('domain=writing&month=2026-10&page=2&sort=oldest'));
  await readWordbookList(db,U,q);await readWordbookActivityDates(db,U,q);
  assert.equal(calls.length,2);assert.equal(calls[0].args.p_student_id,U);assert.equal(calls[0].args.p_domain,'writing');assert.equal(calls[0].args.p_page,2);
  assert.equal(calls[1].args.p_month,'2026-10-01');
  await assert.rejects(readWordbookList({rpc:async()=>({error:{code:'PGRST202'},data:null})},U,q),/A3_UNAVAILABLE/);
});
test('six headers and context row association preserve all senses and exact example strings',()=>{
  assert.deepEqual(WORDBOOK_HEADERS.reading,['序号','词条','词性','语境义','例句','派生']);
  assert.deepEqual(WORDBOOK_HEADERS.writing,['序号','词条','词性','语境义','例句','常见搭配']);
  const item={senses:[{senseId:'s1',contextPos:'verb',exampleIds:['e2','e1']},{senseId:'s2',contextPos:'noun',exampleIds:['e1']}],examples:[{exampleId:'e1',text:'  Original\n sentence. '},{exampleId:'e2',text:'Second.'}]};
  const rows=wordbookContextRows(item);
  assert.deepEqual(rows.map(r=>[r.sense.senseId,r.example.text,r.first,r.span]),[['s1','Second.',true,2],['s1','  Original\n sentence. ',false,2],['s2','  Original\n sentence. ',true,1]]);
});
test('actual GET handlers authenticate before service-role, reject arbitrary student ids, and forward only trusted identity',async()=>{
  const ts=require('typescript');
  for(const file of ['app/api/student/wordbook/route.ts','app/api/student/wordbook/activity-dates/route.ts']) {
    let authorized=true, serviceCalls=0;const calls=[];
    const fakeDb={rpc:async(name,args)=>{calls.push({name,args});return {data:name.includes('dates')?[]:{items:[],total:0},error:null};}};
    const exported={};
    vm.runInNewContext(ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{
      exports:exported,URL,Request,require(name) {
        if(name.includes('attemptServer')) return {
          requireReadingAttemptStudent:async()=>authorized?{userId:U}:{error:{status:401}},
          readingAttemptJson:(body,options)=>({body,status:options?.status??200})
        };
        if(name.includes('supabase/server')) return {createServiceSupabase:()=>{serviceCalls++;return fakeDb;}};
        if(name.endsWith('wordbookList.server')) return {readWordbookList,readWordbookActivityDates};
        if(name.endsWith('wordbookList')) return {parseWordbookQuery};
        throw Error(`unexpected import ${name}`);
      }
    });
    const suffix=file.includes('activity-dates')?'&month=2026-10':'';
    const url=`https://offline.invalid/api?domain=writing${suffix}`;
    authorized=false;assert.equal((await exported.GET(new Request(url))).status,401);assert.equal(serviceCalls,0);
    authorized=true;assert.equal((await exported.GET(new Request(`${url}&student_id=${V}`))).status,400);assert.equal(serviceCalls,0);
    assert.equal((await exported.GET(new Request(url))).status,200);assert.equal(serviceCalls,1);assert.equal(calls[0].args.p_student_id,U);
    assert.match(read(file),/requireReadingAttemptStudent/);
    assert.match(read('lib/reading/attemptServer.ts'),/Cache-Control", "no-store/);
  }
});
engineTest('A3 RPC: first save/sense/example/source/association append records real activities; repeats and reads are inert',async()=>{
  const db=await fixture();try {
    await save(db);assert.equal((await events(db)).length,1);assert.equal((await events(db))[0].event_type,'first_save');
    await db.exec(read('supabase/student_wordbook_v1_phase_a3_verify_20261008.sql'));
    for(let i=0;i<5;i++) await save(db);assert.equal((await events(db)).length,1);
    await db.exec(`update lexical_occurrences set context_meaning_zh='经营' where occurrence_id='${O}'`);await save(db);assert.equal((await events(db)).length,2);
    await db.exec(`update lexical_occurrences set context_text='They run daily.' where occurrence_id='${O}'`);await save(db);assert.equal((await events(db)).length,3);
    await db.exec(`update lexical_occurrences set source_type='rdl' where occurrence_id='${O}';update lexical_source_blocks set source_type='rdl',block_kind='rdl_material';`);
    await save(db);assert.equal((await events(db)).length,4);
    const item=(await list(db)).items[0];assert.equal(item.senses.length,2);assert.equal(item.examples.length,2);assert.deepEqual(item.sourceTypes,['ctw','rdl']);
    await list(db);await dates(db);await db.exec(`update lexical_entries set derived_words='[{"expression":"runner"}]' where entry_id='${E}'`);
    await save(db);assert.equal((await events(db)).length,4);
    await db.exec(`update lexical_occurrences set context_meaning_zh='运行' where occurrence_id='${O}'`);
    await save(db);assert.equal((await events(db)).length,5); // existing sense/example, new relation (fixture's first meaning is 运行)
  } finally { await db.close(); }
});
engineTest('A3: activity insertion failure rolls back all content/source changes; append-only and effective ACLs',async()=>{
  const db=await fixture();try {
    await db.exec(`create function fail_activity_test() returns trigger language plpgsql as $$ begin raise exception 'TEST_ACTIVITY_FAILURE'; end; $$;
      create trigger fail_activity_test before insert on student_wordbook_activities for each row execute function fail_activity_test();`);
    await assert.rejects(save(db),/TEST_ACTIVITY_FAILURE/);assert.equal((await list(db)).total,0);
    assert.equal((await db.query('select count(*)::int n from student_wordbook_entries')).rows[0].n,0);
    await db.exec('alter table student_wordbook_activities disable trigger fail_activity_test');await save(db);
    await db.exec(`alter table student_wordbook_activities enable trigger fail_activity_test;
      update lexical_occurrences set source_type='rdl' where occurrence_id='${O}';update lexical_source_blocks set source_type='rdl';`);
    await assert.rejects(save(db),/TEST_ACTIVITY_FAILURE/);
    assert.deepEqual((await list(db)).items[0].sourceTypes,['ctw']);assert.equal((await events(db)).length,1);
    await assert.rejects(db.exec(`update student_wordbook_activities set activity_at=now()`),/APPEND_ONLY/);
    for(const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);await assert.rejects(list(db),/permission denied/i);await assert.rejects(dates(db),/permission denied/i);
      await assert.rejects(save(db),/permission denied/i);await assert.rejects(db.exec('select * from student_wordbook_activities'),/permission denied/i);await db.exec('reset role');
    }
    await db.exec('set role service_role');assert.equal((await list(db)).total,1);await db.exec('reset role');
  } finally { await db.close(); }
});
engineTest('A3: historical real first/sense/example times only, content unchanged and rerun fails atomically',async()=>{
  const db=await fixture(false);try {
    await save(db);
    const w=(await db.query('select wordbook_entry_id from student_wordbook_entries')).rows[0].wordbook_entry_id;
    await db.query(`insert into student_wordbook_senses(wordbook_entry_id,student_id,domain,context_pos,context_meaning_zh,first_saved_at)
      values($1,$2,'reading','noun','历史可靠义项','2026-10-05T02:00:00Z')`,[w,U]);
    await db.query(`insert into student_wordbook_examples(wordbook_entry_id,student_id,domain,example_text,context_kind,source_block_kind,extraction_method,source_types,first_saved_at)
      values($1,$2,'reading','An older exact example.','sentence','ctw_paragraph','whole_sentence_block',array['ctw'],'2026-10-06T02:00:00Z')`,[w,U]);
    const before=(await db.query('select to_jsonb(w) value from student_wordbook_entries w')).rows;
    await db.exec(preflight);await db.exec(sql);
    assert.deepEqual((await db.query('select to_jsonb(w) value from student_wordbook_entries w')).rows,before);
    assert.equal((await events(db)).length,3); // A2 same-transaction times dedupe; real child dates recover
    assert.deepEqual((await events(db)).filter(e=>e.event_type==='historical_created').map(e=>new Date(e.activity_at).toISOString()),['2026-10-05T02:00:00.000Z','2026-10-06T02:00:00.000Z']);
    await assert.rejects(db.exec(sql),/DRIFT/);await db.exec('rollback');
    assert.equal((await list(db)).total,1);
  } finally { await db.close(); }
});
engineTest('A3: deterministic multi-canonical enrichment keeps full-value dedupe/provenance/conflicts; disabled retained, identity drift excluded, next read live',async()=>{
  const db=await fixture();try {
    await save(db);const w=(await list(db)).items[0].wordbookEntryId;
    const other='00000000-0000-4000-8000-000000000071';
    await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant,derived_words,useful_patterns,common_senses)
      values($1,'run','run','word','approved-v2','[{"expression":"runner","relation":"noun","meaning_zh":"跑者"},{"expression":"runner","relation":"noun","meaning_zh":"参赛者"}]',
      '[{"pattern":"run a business","meaning_zh":"经营企业"}]','[{"pos":"verb","definition_en":"Move quickly.","meaning_zh":"跑"}]')`,[other]);
    await db.query(`insert into student_wordbook_canonical_links(wordbook_entry_id,student_id,domain,lexical_entry_id,canonical_normalized_expression,canonical_expression_type,canonical_identity_variant,association_kind,identity_review_reference)
      values($1,$2,'reading',$3,'run','word','approved-v2','reviewed_equivalent','OFFLINE-APPROVAL-ONLY')`,[w,U,other]);
    await db.query(`update lexical_entries set derived_words='[{"meaning_zh":"跑者","relation":"noun","expression":"runner"}]',review_status='disabled' where entry_id=$1`,[E]);
    let item=(await list(db)).items[0];
    assert.deepEqual(item.enrichmentSources.map(s=>s.lexicalEntryId),[E,other]);assert.equal(item.enrichmentSources[0].canonicalStatus,'disabled');
    const derived=item.enrichmentItems.filter(i=>i.field==='derived_words');assert.equal(derived.length,2);assert.ok(derived.every(i=>i.hasConflict));
    assert.deepEqual(derived.find(i=>i.value.meaning_zh==='跑者').lexicalEntryIds,[E,other]);
    const snapshots=JSON.stringify([item.senses,item.examples]);const n=(await events(db)).length;
    await db.query(`update lexical_entries set derived_words='[{"expression":"running","relation":"adjective","meaning_zh":"运行中的"}]' where entry_id=$1`,[E]);
    item=(await list(db)).items[0];assert.ok(item.enrichmentItems.some(i=>i.value.expression==='running'));assert.equal(JSON.stringify([item.senses,item.examples]),snapshots);
    await db.query(`update lexical_entries set identity_variant='unauthorized-drift' where entry_id=$1`,[other]);
    item=(await list(db)).items[0];assert.equal(item.enrichmentSources[1].enrichmentStatus,'identity_drift');assert.equal(item.enrichmentSources[1].derivedWords,null);
    assert.equal(item.enrichmentItems.filter(i=>i.field==='derived_words').length,1);assert.equal((await events(db)).length,n);
  } finally { await db.close(); }
});
engineTest('A3: pagination orders by effective activity, range-local latest and stable unique id for exact timestamp ties',async()=>{
  const db=await fixture();try {
    const ids=['00000000-0000-4000-8000-000000000081','00000000-0000-4000-8000-000000000082','00000000-0000-4000-8000-000000000083'];
    for(let i=0;i<ids.length;i++) {
      await db.query(`insert into student_wordbook_entries(wordbook_entry_id,student_id,domain,expression,normalized_expression,expression_type,identity_variant,first_saved_at)
        values($1,$2,'reading',$3,$3,'word','','2026-10-01T00:00:00Z')`,[ids[i],U,`offline-${i}`]);
      await db.query(`insert into student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at)
        values($1,$2,'reading','first_save','2026-10-01T00:00:00Z'),($1,$2,'reading','append',$3)`,[ids[i],U,`2026-10-${i===2?'10':'08'}T00:00:00Z`]);
    }
    const paged=[];for(let page=1;page<=3;page++) paged.push((await list(db,{page,size:1})).items[0].wordbookEntryId);
    assert.deepEqual(paged,[ids[2],ids[0],ids[1]]);assert.equal(new Set(paged).size,3);
    assert.deepEqual((await list(db,{sort:'oldest'})).items.map(i=>i.wordbookEntryId),ids);
    const range={start:'2026-10-01T00:00:00Z',end:'2026-10-09T00:00:00Z'};
    assert.deepEqual((await list(db,range)).items.map(i=>i.wordbookEntryId),ids);
    assert.equal((await list(db,{page:4,size:1})).items.length,0);
  } finally { await db.close(); }
});
engineTest('A3: midnight/DST month marks, schema drift preflight and corrupted verify fail closed',async()=>{
  const db=await fixture();try {
    await save(db);const w=(await list(db)).items[0].wordbookEntryId;
    await db.exec('delete from student_wordbook_activities');
    for(const at of ['2026-03-01T04:59:59Z','2026-03-01T05:00:00Z','2026-03-08T06:59:59Z','2026-03-08T07:00:00Z','2026-04-01T03:59:59Z','2026-04-01T04:00:00Z'])
      await db.query(`insert into student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at) values($1,$2,'reading','append',$3)`,[w,U,at]);
    assert.deepEqual(await dates(db,'reading','America/New_York','2026-03-01'),['2026-03-01','2026-03-08','2026-03-31']);
    const spring=parseWordbookQuery(new URLSearchParams('date=2026-03-08&timeZone=America/New_York'));
    assert.equal((await list(db,{start:spring.startAt,end:spring.endAt})).total,1);
    await db.exec('alter table student_wordbook_activities disable trigger student_wordbook_activities_append_guard');
    await assert.rejects(db.exec(read('supabase/student_wordbook_v1_phase_a3_verify_20261008.sql')),/APPEND_GUARD/);await db.exec('rollback');
  } finally { await db.close(); }
  const old=await fixture(false);try {
    await old.exec('alter table student_wordbook_examples disable trigger student_wordbook_examples_snapshot_guard');
    await assert.rejects(old.exec(preflight),/HISTORY_GUARD/);await old.exec('rollback');
    await assert.rejects(old.exec(sql),/HISTORY_GUARD/);await old.exec('rollback');
    assert.equal((await old.query("select to_regclass('public.student_wordbook_activities') as table")).rows[0].table,null);
  } finally { await old.close(); }
});
engineTest('A3: calendar/day/range include unique entries with FULL contexts; sort uses range-latest activity, stable ID ties',async()=>{
  const db=await fixture();try {
    await save(db);const w=(await list(db)).items[0].wordbookEntryId;
    // Offline fixture uses original production columns; historical time scenarios
    // insert facts directly only in this local model, never production backfill.
    await db.exec('delete from student_wordbook_activities');
    await db.query(`insert into student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at)
      values($1,$2,'reading','first_save','2026-10-07T16:00:00Z'),($1,$2,'reading','append','2026-10-09T16:00:00Z'),($1,$2,'reading','append','2026-10-11T16:00:00Z')`,[w,U]);
    assert.deepEqual(await dates(db),['2026-10-08','2026-10-10','2026-10-12']);
    for(const day of ['08','10','12']) assert.equal((await list(db,{start:`2026-10-${String(+day-1).padStart(2,'0')}T16:00:00Z`,end:`2026-10-${day}T16:00:00Z`})).total,1);
    const range=await list(db,{start:'2026-10-07T16:00:00Z',end:'2026-10-10T16:00:00Z'});
    assert.equal(range.total,1);assert.equal(range.items.length,1);assert.equal(range.items[0].examples.length,1);
    assert.equal(Date.parse(range.items[0].sortActivityAt),Date.parse('2026-10-09T16:00:00Z'));
    assert.equal(Date.parse(range.items[0].lastActivityAt),Date.parse('2026-10-11T16:00:00Z'));
    assert.equal((await list(db,{start:'2026-10-08T16:00:00Z',end:'2026-10-09T16:00:00Z'})).total,0);
    await db.exec(`update lexical_occurrences set source_type='bas' where occurrence_id='${O}';update lexical_source_blocks set source_type='bas',block_kind='bas_prompt';`);
    await save(db);await save(db,'save',V);assert.equal((await list(db,{domain:'writing'})).total,1);assert.equal((await list(db,{user:V,domain:'writing'})).total,1);
    assert.deepEqual(await dates(db,'reading','Asia/Shanghai','2026-10-01',V),[]);
    await db.exec(`update lexical_occurrences set source_type='ctw' where occurrence_id='${O}';update lexical_source_blocks set source_type='ctw',block_kind='ctw_paragraph';`);
    await save(db,'remove');assert.deepEqual(await dates(db),[]);assert.equal((await list(db)).total,0);assert.equal((await list(db,{domain:'writing'})).total,1);
    const fresh=await save(db);assert.notEqual(fresh.wordbookEntryId,w);assert.equal((await events(db)).length,1);
  } finally { await db.close(); }
});
