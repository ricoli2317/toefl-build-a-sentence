const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {parseWordbookBatchDelete,wordbookSerial,wordbookSelectionIdentity}=require('../lib/lexical/wordbookManagement.ts');
const {wordbookExampleTail,twoLinePrefix}=require('../lib/lexical/wordbookPresentation.ts');
const {deleteWordbookBatch}=require('../lib/lexical/wordbookManagement.server.ts');
const {WordbookError}=require('../lib/lexical/wordbookContext.ts');
const h=require('./helpers/wordbookManagementFixture.cjs');
const engine=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const invalid='00000000-0000-4000-8000-000000009999';
test('batch body accepts only domain + bounded unique UUID entry IDs, never student identity',()=>{
  assert.deepEqual(parseWordbookBatchDelete({domain:'reading',entryIds:[h.E.toUpperCase()]}),{domain:'reading',entryIds:[h.E]});
  for(const v of [null,[],{}, {domain:'other',entryIds:[h.E]}, {domain:'reading',entryIds:[]}, {domain:'reading',entryIds:[h.E,h.E.toUpperCase()]},
    {domain:'reading',entryIds:['bad']},{domain:'reading',entryIds:[null]}, {domain:'reading',entryIds:Array(51).fill(h.E)},
    {domain:'reading',entryIds:[h.E],student_id:h.V}, {domain:'reading',entryIds:[h.E],action:'remove'}])assert.throws(()=>parseWordbookBatchDelete(v));
});
test('serials count entries across 20+1 pages; every filter/sort/owner/domain identifies a fresh selection',()=>{
  assert.equal(wordbookSerial(1,20,0),1);assert.equal(wordbookSerial(1,20,19),20);assert.equal(wordbookSerial(2,20,0),21);
  const filters={page:1,sort:'newest',start:'',end:''},base=wordbookSelectionIdentity(h.U,'reading',filters);
  for(const changes of [{page:2},{sort:'oldest'},{start:'2026-10-08',end:'2026-10-08'}])assert.notEqual(wordbookSelectionIdentity(h.U,'reading',{...filters,...changes}),base);
  assert.notEqual(wordbookSelectionIdentity(h.V,'reading',filters),base);assert.notEqual(wordbookSelectionIdentity(h.U,'writing',filters),base);
});
test('ellipsis tail contains an intact source grapheme, original sentence remains untouched',()=>{
  for(const text of [h.sentence,'a👨‍👩‍👧‍👦','e\u0301','a😀','中文']){const [body,last]=wordbookExampleTail(text);assert.equal(body+last,text);assert.equal([...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(last)].length,1);}
  const prefix=twoLinePrefix(h.sentence,(text,toggle)=>text.length+(toggle?3:0)<=60);assert.ok(h.sentence.startsWith(prefix));
  const source=fs.readFileSync(path.join(__dirname,'../components/student/WordbookExample.tsx'),'utf8');
  assert.match(source,/getBoundingClientRect\(\)\.width/);assert.match(source,/createElement\("button"\)/);assert.match(source,/wordbookExampleTail\(value\)/);
});
function fakeDb(overrides={}){
  const calls=[];const db={from:()=>{const q={select:()=>q,eq:()=>q,in:async()=>({data:[{wordbook_entry_id:h.E,student_id:h.U,domain:'reading'}],error:null})};return q;},
    rpc:async(name,args)=>{calls.push({name,args});return {data:{domain:'reading',deletedCount:1,deletedEntryIds:[h.E]},error:null};},...overrides};return {db,calls};
}
test('server verifies owner/domain before one atomic RPC and checks exact result IDs',async()=>{
  const {db,calls}=fakeDb();const result=await deleteWordbookBatch(db,h.U,{domain:'reading',entryIds:[h.E]});assert.equal(result.deletedCount,1);
  assert.deepEqual(calls,[{name:'delete_student_wordbook_entries_v1',args:{p_student_id:h.U,p_domain:'reading',p_entry_ids:[h.E]}}]);
  await assert.rejects(deleteWordbookBatch(db,h.V,{domain:'reading',entryIds:[h.E]}),e=>e.status===409);assert.equal(calls.length,1);
  await assert.rejects(deleteWordbookBatch(db,h.U,{domain:'writing',entryIds:[h.E]}),e=>e.status===409);assert.equal(calls.length,1);
  for(const response of [{data:null,error:{code:'PGRST202'}},{data:{domain:'writing',deletedCount:1,deletedEntryIds:[h.E]}},
    {data:{domain:'reading',deletedCount:1,deletedEntryIds:[h.O]}},{data:null,error:{message:'WORDBOOK_BATCH_NOT_FOUND'}}]){
    const d=fakeDb({rpc:async()=>response}).db;await assert.rejects(deleteWordbookBatch(d,h.U,{domain:'reading',entryIds:[h.E]}),e=>e instanceof WordbookError);
  }
});
test('actual POST authenticates first, rejects injected owner/invalid IDs, returns trusted errors/no-store helper',async()=>{
  let auth=false,service=0;const calls=[];const exported={};const code=fs.readFileSync(path.join(__dirname,'../app/api/student/wordbook/batch-delete/route.ts'),'utf8');
  vm.runInNewContext(require('typescript').transpileModule(code,{compilerOptions:{module:require('typescript').ModuleKind.CommonJS}}).outputText,{exports:exported,require(name){
    if(name.includes('attemptServer'))return {requireReadingAttemptStudent:async()=>auth?{userId:h.U}:{error:{status:401}},readingAttemptJson:(body,options)=>({body,status:options?.status??200})};
    if(name.includes('supabase/server'))return {createServiceSupabase:()=>{service++;return{};}};
    if(name.endsWith('wordbookManagement'))return {parseWordbookBatchDelete};
    if(name.endsWith('wordbookManagement.server'))return {deleteWordbookBatch:async(db,user,input)=>{calls.push({user,input});return {domain:input.domain,deletedCount:input.entryIds.length,deletedEntryIds:input.entryIds};}};
    if(name.endsWith('wordbookContext'))return {WordbookError};throw Error(name);
  }});
  const request=body=>new Request('https://offline.invalid/api',{method:'POST',body:JSON.stringify(body)});
  const body={domain:'reading',entryIds:[h.E]};assert.equal((await exported.POST(request(body))).status,401);assert.equal(service,0);
  auth=true;for(const b of [{...body,student_id:h.V},{...body,entryIds:['bad']},{...body,entryIds:[]}])assert.equal((await exported.POST(request(b))).status,400);
  assert.equal(service,0);assert.equal((await exported.POST(request(body))).status,200);assert.equal(calls[0].user,h.U);assert.equal(service,1);
});
test('actual read hook and layout cache reject late pre-deletion list/date responses after targeted invalidation',async()=>{
  const runtime=await require('./helpers/wordbookReadHarness.cjs').harness('student',h.U),r=runtime.reader();
  try { for(const url of ['/api/student/wordbook?domain=reading','/api/student/wordbook/activity-dates?domain=reading&month=2026-10']) {
    r.read(url);const old=r.requests.at(-1);
    runtime.emit({type:'WORDBOOK_CHANGED',studentId:h.U,wordbookDomain:'reading'});
    r.read(url);const fresh=r.requests.at(-1);assert.notEqual(old,fresh);
    old.resolve({items:['deleted'],dates:['2026-10-08']});await runtime.tick();assert.equal(r.read(url).data,undefined);
    fresh.resolve({items:[],dates:[]});await runtime.tick();assert.deepEqual(r.read(url).data,{items:[],dates:[]});
  } } finally {runtime.cleanup();}
});
const snapshot=async db=>(await db.query(`select (select jsonb_agg(to_jsonb(w) order by wordbook_entry_id) from student_wordbook_entries w) entries,
  (select count(*) from student_wordbook_senses) senses,(select count(*) from student_wordbook_examples) examples,
  (select count(*) from student_wordbook_example_senses) edges,(select count(*) from student_wordbook_canonical_links) links,
  (select count(*) from student_wordbook_activities) activities`)).rows[0];
engine('offline batch deletes entire multi-sense entries, cascades six layers, keeps other user/domain and corpus',async()=>{
  const db=await h.fixture({populate:true});try{
    const reading=await h.list(db),writing=await h.list(db,{domain:'writing'}),other=await h.list(db,{user:h.V});const ids=reading.items.slice(0,2).map(i=>i.wordbookEntryId);
    assert.equal(reading.total,21);assert.equal((await h.list(db,{page:2})).items.length,1);assert.equal(reading.items[0].senses.length,2);
    const corpus=(await db.query('select * from lexical_entries order by entry_id')).rows;
    await db.exec('set role service_role');const result=await h.remove(db,ids);await db.exec('reset role');assert.equal(result.deletedCount,2);
    for(const table of ['entries','senses','examples','example_senses','canonical_links','activities'])assert.equal((await db.query(`select count(*)::int n from student_wordbook_${table} where wordbook_entry_id=any($1::uuid[])`,[ids])).rows[0].n,0);
    assert.deepEqual(await h.list(db,{domain:'writing'}),writing);assert.deepEqual(await h.list(db,{user:h.V}),other);assert.deepEqual((await db.query('select * from lexical_entries order by entry_id')).rows,corpus);
  }finally{await db.close();}
});
engine('offline invalid/cross-owner/cross-domain/missing/repeated IDs reject the whole batch',async()=>{
  const db=await h.fixture({populate:true});try{
    const own=(await h.list(db)).items[0].wordbookEntryId,foreign=(await h.list(db,{user:h.V})).items[0].wordbookEntryId,writing=(await h.list(db,{domain:'writing'})).items[0].wordbookEntryId,before=await snapshot(db);
    for(const ids of [[own,foreign],[own,writing],[own,invalid],[own,own],[],[null],Array(51).fill(own)]){await assert.rejects(h.remove(db,ids));assert.deepEqual(await snapshot(db),before);}
    await h.remove(db,[own]);const after=await snapshot(db);await assert.rejects(h.remove(db,[own]),/WORDBOOK_BATCH_NOT_FOUND/);assert.deepEqual(await snapshot(db),after);
    for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(h.remove(db,[writing],'writing'),/permission denied/);await db.exec('reset role');}
  }finally{await db.close();}
});
engine('offline late cascade failure rolls back all entries and children; activity dates update and single cancel still works',async()=>{
  const db=await h.fixture({populate:true});try{
    const all=(await h.list(db)).items,ids=all.slice(0,2).map(i=>i.wordbookEntryId),before=await snapshot(db);
    await db.exec(`create function fail_batch_child() returns trigger language plpgsql as $$ begin if old.wordbook_entry_id='${ids[1]}' then raise exception 'OFFLINE_BATCH_ROLLBACK'; end if; return old; end; $$;
      create trigger fail_batch_child before delete on student_wordbook_activities for each row execute function fail_batch_child();`);
    await assert.rejects(h.remove(db,ids),/OFFLINE_BATCH_ROLLBACK/);assert.deepEqual(await snapshot(db),before);await db.exec('drop trigger fail_batch_child on student_wordbook_activities');
    const last=(await h.list(db,{page:2})).items[0].wordbookEntryId;assert.deepEqual(await h.dates(db,'reading','Asia/Shanghai','2026-09-01'),['2026-09-30']);await h.remove(db,[last]);assert.deepEqual(await h.dates(db,'reading','Asia/Shanghai','2026-09-01'),[]);
    await h.save(db);assert.equal((await h.list(db)).total,21);await h.save(db,'remove');assert.equal((await h.list(db)).total,20);
  }finally{await db.close();}
});
engine('offline migration is additive, duplicate install fails, verifies exact body and keeps historical RPC unchanged',async()=>{
  const db=await h.fixture();try{
    await db.exec(h.read('supabase/student_wordbook_v1_bugfix_verify_20261008.sql'));
    await assert.rejects(db.exec(h.read('supabase/student_wordbook_v1_batch_delete_20261008.sql')),/ALREADY_INSTALLED/);await db.exec('rollback');
    await db.exec(h.read('supabase/student_wordbook_v1_batch_delete_verify_20261008.sql'));
  }finally{await db.close();}
});
