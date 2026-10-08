const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractWordbookContext, WordbookError } = require('../lib/lexical/wordbookContext.ts');
const { operateWordbook, readWordbookStatus, addWordbookStatus, wordbookDomain } = require('../lib/lexical/wordbook.server.ts');
const { canonicalSourceTextHash } = require('../lib/lexical/hash.ts');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root,p),'utf8');
const a2 = read('supabase/student_wordbook_v1_phase_a2_20261008.sql');
const runtime = process.env.WORDBOOK_SQL_TEST_PGLITE;
const PGlite = runtime ? require(path.resolve(runtime)).PGlite : null;
const engineTest = (name,fn) => test(name,{ skip:!PGlite },fn);
// Reuse A1's explicitly OFFLINE dependency model without running/modifying its tests.
const model = read('tests/studentWordbookSql.test.js');
const dependencies = vm.runInNewContext(model.slice(model.indexOf('const U1 ='),model.indexOf('async function fixture()')) + '\ndependencies;');
const U = '00000000-0000-4000-8000-000000000001';
const E = '00000000-0000-4000-8000-000000000011';
const O = '00000000-0000-4000-8000-000000000013';
const attemptId = '11111111-1111-4111-8111-111111111111';
const text = 'We are running every day.';
const entry = { entry_id:E,canonical_expression:'run',normalized_expression:'run',expression_type:'word',identity_variant:'',review_status:'generated',lemma:'run' };
const occurrence = { occurrence_id:O,entry_id:E,source_type:'ctw',source_item_id:'fixture',content_block_id:'paragraph:p',
  start_offset:7,end_offset:14,surface_text:'running',context_text:text,sentence_id:null,context_pos:'verb',context_meaning_zh:'跑步',context_definition_en:'Move quickly.',review_status:'generated' };
const block = { source_type:'ctw',source_item_id:'fixture',content_block_id:'paragraph:p',block_kind:'ctw_paragraph',source_text_hash:canonicalSourceTextHash(text),generation_status:'generated' };
const expected = (o=occurrence,e=entry,b=block,context=extractWordbookContext(o.context_text,b.block_kind,o)) => ({
  entry_id:e.entry_id,source_type:o.source_type,source_item_id:o.source_item_id,content_block_id:o.content_block_id,
  start_offset:o.start_offset,end_offset:o.end_offset,surface_text:o.surface_text,context_text:o.context_text,sentence_id:o.sentence_id,
  context_pos:o.context_pos,context_meaning_zh:o.context_meaning_zh,context_definition_en:o.context_definition_en,
  canonical_expression:e.canonical_expression,normalized_expression:e.normalized_expression,expression_type:e.expression_type,identity_variant:e.identity_variant,
  source_text_hash:b.source_text_hash,source_block_kind:b.block_kind,...context });
const contextFor = (text, surface, kind='ctw_paragraph', extra={}) => extractWordbookContext(text,kind,{
  start_offset:text.indexOf(surface),end_offset:text.indexOf(surface)+surface.length,surface_text:surface,context_text:text,sentence_id:null,...extra });
test('deterministic extraction: abbreviations, initials, decimals, quotes, UTF-16 and exact original slices', () => {
  for (const [text,surface,want] of [
    ['Dr. Smith was running at 3.5 mph. It was raining.','running','Dr. Smith was running at 3.5 mph.'],
    ['The U.S. was growing quickly. It was stable.','growing','The U.S. was growing quickly.'],
    ['Donald J. Kessler was working. It was late.','working','Donald J. Kessler was working.'],
    ['“We are growing.” It was late.','growing','“We are growing.”'],
    ['😀 We are growing. It was late.','growing','😀 We are growing.']
  ]) { const result=contextFor(text,surface); assert.equal(result.context_kind,'sentence'); assert.equal(result.example_text,want); }
});
test('all six sources preserve true short fragments; natural fields are not AI-completed sentences', () => {
  for (const kind of ['ctw_paragraph','rdl_question_option','rap_title','bas_prompt','email_subject','academic_student_response']) {
    const result=contextFor('Growing opportunities','Growing',kind);
    assert.equal(result.context_kind,'fragment'); assert.equal(result.example_text,'Growing opportunities');
  }
  assert.equal(contextFor('There are opportunities.','opportunities','email_subject').context_kind,'fragment');
  assert.equal(contextFor('Header\n\nGrowing opportunities\n\nFooter','Growing','rdl_material').example_text,'Growing opportunities');
});
test('verified boundary failures return explicit no-example; stale spans still fail closed', () => {
  for (const [text,surface] of [['growing '.repeat(200),'growing'],['We are growing. It was late.','growing. It'],['We are growing... It was late.','growing... It']])
    assert.deepEqual(contextFor(text,surface),{example_text:null,context_kind:null,extraction_method:'verified_no_example_boundary'});
  assert.throws(()=>contextFor('We are growing.','growing','ctw_paragraph',{ context_text:'stale' }),/核验/);
  assert.throws(()=>contextFor('We are growing.','growing','ctw_paragraph',{ start_offset:0 }),/核验/);
  assert.equal(contextFor('Growing\nopportunities','Growing').context_kind,'fragment');
  assert.equal(contextFor('They are living in the U.S. It is growing.','growing').example_text,null);
  assert.equal(contextFor('Acme Corp. Was growing quickly. It is expanding.','growing').example_text,null);
});
test('RAP sentence map must exactly reconstruct the block and uniquely contain the whole occurrence', () => {
  const text='We are growing. It was late.';
  const o={ start_offset:7,end_offset:14,surface_text:'growing',context_text:text,sentence_id:'s1' };
  const map=[{ sentence_id:'s1',sentence_text:'We are growing.' },{ sentence_id:'s2',sentence_text:'It was late.' }];
  assert.equal(extractWordbookContext(text,'rap_paragraph',o,map).extraction_method,'canonical_sentence');
  assert.throws(()=>extractWordbookContext(text,'rap_paragraph',{ ...o,sentence_id:'wrong' },map),WordbookError);
  assert.throws(()=>extractWordbookContext(text,'rap_paragraph',o,[{ ...map[0],sentence_text:'invented' }]),WordbookError);
});

// Minimal relational read double; the production server helpers, matching and
// authorization execute unchanged. RPC effects use the real local SQL below.
function database(tables,rpc) {
  const calls=[];
  return { calls, rpc:async (name,args)=>{ calls.push({ rpc:name,args });return rpc ? rpc(name,args) : { data:{ saved:true,domain:'reading' },error:null }; },
    from(table) { const filters=[];let single=false;let limit=Infinity;calls.push({ table,filters });
      const q={ select(){ return q; },eq(k,v){ filters.push([k,'eq',v]);return q; },neq(k,v){ filters.push([k,'neq',v]);return q; },
        lte(k,v){ filters.push([k,'lte',v]);return q; },gte(k,v){ filters.push([k,'gte',v]);return q; },in(k,v){ filters.push([k,'in',v]);return q; },
        order(){ return q; },limit(v){ limit=v;return q; },maybeSingle(){ single=true;return q; },
        then(resolve,reject) { const rows=(tables[table]??[]).filter(row=>filters.every(([k,op,v])=>{
          const x=k.split('.').reduce((r,key)=>r?.[key],row);return op==='eq'?x===v:op==='neq'?x!==v:op==='lte'?x<=v:op==='gte'?x>=v:v.includes(x);
        })).slice(0,limit);return Promise.resolve({ data:single?rows[0]??null:rows,error:null }).then(resolve,reject); }
      };return q;
    }
  };
}
const selection={ access:{ kind:'reading',attemptId },sourceType:'ctw',sourceItemId:'fixture',contentBlockId:'paragraph:p',startOffset:7,endOffset:14,selectedText:'running',blockText:text };
const readers={ fullSetAttempt:async()=>({}),writingAttempt:async()=>({}),writingQuestion:async()=>({}),basFinalVisible:()=>true };
function tables() { return {
  reading_attempts:[{ attempt_id:attemptId,student_id:U,logical_item_id:'fixture',task_type:'ctw',status:'submitted',submitted_at:'now' }],
  reading_logical_items:[{ logical_item_id:'fixture',module:'ctw' }],reading_ctw_paragraphs:[{ paragraph_id:'p',question_id:'q' }],
  reading_questions:[{ question_id:'q',logical_item_id:'fixture',module:'ctw' }],
  reading_ctw_segments:[{ paragraph_id:'p',segment_type:'text',text_content:text }],reading_ctw_slots:[],
  lexical_source_blocks:[{ ...block }],lexical_occurrences:[{ ...occurrence,lexical_entries:{ ...entry } }] };
}
test('actual server save reauthorizes/relooks up, rebuilds canonical payload and ignores client domain/text/enrichment', async () => {
  const db=database(tables());
  await operateWordbook(db,db,U,{ ...selection,domain:'writing',example_text:'FAKE',common_senses:['FAKE'] },E,O,'save',readers);
  const rpc=db.calls.find(c=>c.rpc);assert.equal(rpc.rpc,'operate_student_wordbook_v1');
  assert.equal(rpc.args.p_student_id,U);assert.equal(rpc.args.p_expected.example_text,text);
  assert.doesNotMatch(JSON.stringify(rpc.args),/FAKE|common_senses|"domain"/);
  assert.equal(wordbookDomain('bas'),'writing');assert.equal(wordbookDomain('rap'),'reading');
});
test('server rejects illegal ownership, active results, mismatched identity, disabled entry/occurrence and stale hash before RPC', async () => {
  for (const change of [t=>t.reading_attempts[0].student_id='stranger',t=>t.reading_attempts[0].status='in_progress',
    t=>t.lexical_source_blocks[0].source_text_hash='stale',t=>t.lexical_occurrences[0].review_status='disabled',
    t=>t.lexical_occurrences[0].lexical_entries.review_status='disabled',t=>t.lexical_occurrences[0].context_text='stale']) {
    const t=tables();change(t);const db=database(t);await assert.rejects(operateWordbook(db,db,U,selection,E,O,'save',readers));
    assert.equal(db.calls.some(c=>c.rpc),false);
  }
  const db=database(tables());await assert.rejects(operateWordbook(db,db,U,selection,E,'wrong','save',readers),e=>e.status===403);
  assert.equal(db.calls.some(c=>c.rpc),false);
});
test('verified extraction failure sends only explicit no-example to atomic RPC; remove needs no example', async () => {
  const t=tables();const long='running '.repeat(1000);
  t.reading_ctw_segments[0].text_content=long;t.lexical_source_blocks[0].source_text_hash=canonicalSourceTextHash(long);
  Object.assign(t.lexical_occurrences[0],{ start_offset:0,end_offset:7,context_text:long });
  const r={ ...selection,startOffset:0,endOffset:7,blockText:long };const db=database(t);
  await operateWordbook(db,db,U,r,E,O,'save',readers);
  assert.equal(db.calls.find(c=>c.rpc).args.p_expected.example_text,null);
  await operateWordbook(db,db,U,r,E,O,'remove',readers);assert.equal(db.calls.filter(c=>c.rpc).length,2);
});
test('no-example fallback never turns missing SQL, database errors or mismatched RPC domain into a success', async () => {
  const t=tables(),long='running '.repeat(1000);
  t.reading_ctw_segments[0].text_content=long;t.lexical_source_blocks[0].source_text_hash=canonicalSourceTextHash(long);
  Object.assign(t.lexical_occurrences[0],{start_offset:0,end_offset:7,context_text:long});
  const r={...selection,startOffset:0,endOffset:7,blockText:long};
  for(const response of [{data:null,error:{message:'WORDBOOK_INVALID_CONTEXT'}},{data:null,error:{message:'database unavailable'}},{data:{saved:true,domain:'writing'},error:null}]){
    const db=database(t,async()=>response);await assert.rejects(operateWordbook(db,db,U,r,E,O,'save',readers),e=>e.code==='WORDBOOK_UNAVAILABLE');
  }
});
test('status uses bounded owner/domain/canonical unique key and lookup tolerates status failure', async () => {
  const db=database({ student_wordbook_canonical_links:[{ student_id:U,domain:'reading',lexical_entry_id:E,wordbook_entry_id:'saved' }] });
  assert.equal((await readWordbookStatus(db,U,'ctw',E)).saved,true);
  assert.equal((await readWordbookStatus(db,U,'bas',E)).saved,false);
  assert.equal((await readWordbookStatus(db,'other','ctw',E)).saved,false);
  const result={ status:'matched',entry:{ entry_id:E },occurrence:{ source_type:'ctw' } };
  assert.deepEqual((await addWordbookStatus({ from(){ throw Error('offline'); } },U,result)).wordbook,{ available:false });
});

async function fixture() {
  const db=new PGlite();await db.exec(dependencies);await db.exec(read('supabase/student_wordbook_v1_20261008.sql'));await db.exec(a2);
  // Optional compatibility run of the unchanged A2 scenarios against A3 RPC.
  if (process.env.WORDBOOK_SQL_TEST_A3 === '1') await db.exec(read('supabase/student_wordbook_v1_phase_a3_20261008.sql'));
  if (process.env.WORDBOOK_SQL_TEST_BUGFIX === '1') await db.exec(read('supabase/student_wordbook_v1_bugfix_20261008.sql'));
  await db.exec('grant select on profiles to service_role');
  await db.query(`update lexical_occurrences set start_offset=7,end_offset=14,surface_text='running',context_text=$1,context_pos='verb',context_definition_en='Move quickly.' where occurrence_id=$2`,[text,O]);
  await db.query(`insert into lexical_source_blocks values('00000000-0000-4000-8000-000000000014','ctw','fixture','paragraph:p','ctw_paragraph',$1,'generated')`,[block.source_text_hash]);
  return db;
}
const call=async(db,action='save',payload=expected(),user=U,occ=O)=>(await db.query('select public.operate_student_wordbook_v1($1,$2,$3,$4::jsonb) as result',[user,occ,action,JSON.stringify(payload)])).rows[0].result;
const counts=async db=>(await db.query(`select
  (select count(*)::int from student_wordbook_entries) entries,
  (select count(*)::int from student_wordbook_canonical_links) canonical,
  (select count(*)::int from student_wordbook_senses) senses,
  (select count(*)::int from student_wordbook_examples) examples,
  (select count(*)::int from student_wordbook_example_senses) links`)).rows[0];
engineTest('shipped RPC: first/repeat save, appended sense/example/source and original snapshots/timestamps preserved',async()=>{
  const db=await fixture();try {
    const first=await call(db);const saved=(await db.query('select * from student_wordbook_entries')).rows[0];
    for(let i=0;i<10;i++) assert.deepEqual(await call(db),first);
    // Concurrent API callers queued by this single-connection engine still
    // exercise shipped RPC idempotency; NOT a multi-connection lock proof.
    const concurrent=await Promise.all(Array.from({ length:12 },()=>call(db)));
    concurrent.forEach(result=>assert.deepEqual(result,first));
    assert.deepEqual(await counts(db),{ entries:1,canonical:1,senses:1,examples:1,links:1 });
    await db.query(`update lexical_occurrences set context_meaning_zh='经营' where occurrence_id=$1`,[O]);
    await call(db,'save',expected({ ...occurrence,context_meaning_zh:'经营' }));
    assert.deepEqual(await counts(db),{ entries:1,canonical:1,senses:2,examples:1,links:2 });
    await db.query(`update lexical_occurrences set source_type='rdl' where occurrence_id=$1`,[O]);
    await db.exec(`update lexical_source_blocks set source_type='rdl',block_kind='rdl_material'`);
    await call(db,'save',expected({ ...occurrence,source_type:'rdl',context_meaning_zh:'经营' },entry,{ ...block,block_kind:'rdl_material' }));
    const ex=(await db.query('select * from student_wordbook_examples')).rows[0];assert.deepEqual(ex.source_types,['ctw','rdl']);
    assert.equal(ex.source_block_kind,'ctw_paragraph');
    const next='They are running every day.';
    await db.query(`update lexical_occurrences set context_text=$1,start_offset=9,end_offset=16 where occurrence_id=$2`,[next,O]);
    await db.query('update lexical_source_blocks set source_text_hash=$1',[canonicalSourceTextHash(next)]);
    await call(db,'save',expected({ ...occurrence,source_type:'rdl',context_meaning_zh:'经营',context_text:next,start_offset:9,end_offset:16 },entry,
      { ...block,block_kind:'rdl_material',source_text_hash:canonicalSourceTextHash(next) }));
    assert.deepEqual(await counts(db),{ entries:1,canonical:1,senses:2,examples:2,links:3 });
    const after=(await db.query('select * from student_wordbook_entries')).rows[0];
    if (process.env.WORDBOOK_SQL_TEST_BUGFIX === '1') {assert.deepEqual(after.source_types,['ctw','rdl']);delete after.source_types;delete saved.source_types;}
    assert.deepEqual(after,saved);
  } finally { await db.close(); }
});
engineTest('shipped RPC: domain/user isolation, idempotent cancel, cascade and fresh first_saved_at on re-save',async()=>{
  const db=await fixture();try {
    const first=await call(db);
    await db.query(`update lexical_occurrences set source_type='bas' where occurrence_id=$1`,[O]);await db.exec(`update lexical_source_blocks set source_type='bas',block_kind='bas_prompt'`);
    const writing=expected({ ...occurrence,source_type:'bas' },entry,{ ...block,block_kind:'bas_prompt' });
    await call(db,'save',writing);await call(db,'save',writing,'00000000-0000-4000-8000-000000000002');
    await db.query(`update lexical_occurrences set source_type='ctw' where occurrence_id=$1`,[O]);await db.exec(`update lexical_source_blocks set source_type='ctw',block_kind='ctw_paragraph'`);
    assert.equal((await call(db,'remove')).saved,false);assert.equal((await call(db,'remove')).saved,false);
    assert.deepEqual(await counts(db),{ entries:2,canonical:2,senses:2,examples:2,links:2 });
    const resaved=await call(db);assert.notEqual(resaved.wordbookEntryId,first.wordbookEntryId);
    assert.ok((await db.query('select first_saved_at from student_wordbook_entries where wordbook_entry_id=$1',[resaved.wordbookEntryId])).rows[0].first_saved_at);
  } finally { await db.close(); }
});
engineTest('shipped RPC: invalid/stale context and disabled identity reject, late failure rolls back ALL five layers and source union',async()=>{
  const db=await fixture();try {
    for(const payload of [{ ...expected(),identity_variant:'fake' },{ ...expected(),context_text:'invented' },{ ...expected(),example_text:'invented' }])
      await assert.rejects(call(db,'save',payload));
    await db.exec(`update profiles set is_active=false where id='${U}'`);await assert.rejects(call(db),/STUDENT_REQUIRED/);
    await db.exec(`update profiles set is_active=true where id='${U}'`);
    await db.exec(`create function fail_wordbook_test() returns trigger language plpgsql as $$ begin raise exception 'TEST_LATE_FAILURE'; end; $$;
      create trigger fail_wordbook_test before insert on student_wordbook_example_senses for each row execute function fail_wordbook_test();`);
    await assert.rejects(call(db),/TEST_LATE_FAILURE/);assert.deepEqual(await counts(db),{ entries:0,canonical:0,senses:0,examples:0,links:0 });
    await db.exec('alter table student_wordbook_example_senses disable trigger fail_wordbook_test');await call(db);
    await db.exec('alter table student_wordbook_example_senses enable trigger fail_wordbook_test');
    await db.query(`update lexical_occurrences set source_type='rdl' where occurrence_id=$1`,[O]);await db.exec(`update lexical_source_blocks set source_type='rdl'`);
    await assert.rejects(call(db,'save',expected({ ...occurrence,source_type:'rdl' })),/TEST_LATE_FAILURE/);
    assert.deepEqual((await db.query('select source_types from student_wordbook_examples')).rows[0].source_types,['ctw']);
  } finally { await db.close(); }
});
engineTest('shipped RPC: invoker service-role works; browsers cannot execute or write, duplicate deployment fails without replacing RPC',async()=>{
  const db=await fixture();try {
    await db.exec('set role service_role');await call(db);await db.exec('reset role');
    for(const role of ['anon','authenticated']) {
      await db.exec(`set role ${role}`);await assert.rejects(call(db),/permission denied/i);
      await assert.rejects(db.exec('delete from student_wordbook_entries'),/permission denied/i);await db.exec('reset role');
    }
    await assert.rejects(db.exec(a2),/already exists/i);await db.exec('rollback');
    assert.equal((await call(db)).saved,true);
  } finally { await db.close(); }
});
engineTest('actual server -> shipped SQL: first save/status/repeated save/remove use single atomic RPC',async()=>{
  const engine=await fixture();try {
    const t=tables();const db=database(t,async(name,args)=>({ data:await call(engine,args.p_action,args.p_expected,args.p_student_id,args.p_occurrence_id),error:null }));
    const first=await operateWordbook(db,db,U,selection,E,O,'save',readers);assert.equal(first.saved,true);
    t.student_wordbook_canonical_links=[{ student_id:U,domain:'reading',lexical_entry_id:E,wordbook_entry_id:first.wordbookEntryId }];
    assert.equal((await operateWordbook(db,db,U,selection,E,O,'status',readers)).saved,true);
    assert.equal((await operateWordbook(db,db,U,selection,E,O,'save',readers)).wordbookEntryId,first.wordbookEntryId);
    assert.equal((await operateWordbook(db,db,U,selection,E,O,'remove',readers)).saved,false);
    assert.deepEqual(await counts(engine),{ entries:0,canonical:0,senses:0,examples:0,links:0 });
  } finally { await engine.close(); }
});

engineTest('actual server -> upgraded SQL: verified no-example saves still authorize reconstructed CTW and dedupe activities',async()=>{
  if(process.env.WORDBOOK_SQL_TEST_BUGFIX!=='1')return;
  const engine=await fixture();try {
    const t=tables(),long='running '.repeat(1000);
    t.reading_ctw_segments[0].text_content=long;t.lexical_source_blocks[0].source_text_hash=canonicalSourceTextHash(long);
    Object.assign(t.lexical_occurrences[0],{start_offset:0,end_offset:7,context_text:long});
    await engine.query('update lexical_occurrences set context_text=$1,start_offset=0,end_offset=7 where occurrence_id=$2',[long,O]);
    await engine.query('update lexical_source_blocks set source_text_hash=$1',[canonicalSourceTextHash(long)]);
    const db=database(t,async(name,args)=>({data:await call(engine,args.p_action,args.p_expected,args.p_student_id,args.p_occurrence_id),error:null}));
    const r={...selection,startOffset:0,endOffset:7,blockText:long};
    assert.equal((await operateWordbook(db,db,U,r,E,O,'save',readers)).saved,true);await operateWordbook(db,db,U,r,E,O,'save',readers);
    assert.deepEqual(await counts(engine),{entries:1,canonical:1,senses:1,examples:0,links:0});
    assert.equal((await engine.query('select count(*)::int n from student_wordbook_activities')).rows[0].n,1);
  }finally{await engine.close();}
});

engineTest('shipped RPC: same display/lemma with a different identity_variant NEVER merges',async()=>{
  const db=await fixture();try {
    const first=await call(db);
    const e={ ...entry,entry_id:'00000000-0000-4000-8000-000000000015',identity_variant:'reviewed-homograph' };
    const o={ ...occurrence,occurrence_id:'00000000-0000-4000-8000-000000000016',entry_id:e.entry_id,content_block_id:'paragraph:p2' };
    await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant,lemma) values($1,'run','run','word',$2,'run')`,[e.entry_id,e.identity_variant]);
    await db.query(`insert into lexical_source_blocks values('00000000-0000-4000-8000-000000000017','ctw','fixture','paragraph:p2','ctw_paragraph',$1,'generated')`,[block.source_text_hash]);
    await db.query(`insert into lexical_occurrences(occurrence_id,entry_id,source_type,source_item_id,content_block_id,start_offset,end_offset,surface_text,context_text,context_pos,context_meaning_zh,context_definition_en)
      values($1,$2,'ctw','fixture','paragraph:p2',7,14,'running',$3,'verb','跑步','Move quickly.')`,[o.occurrence_id,e.entry_id,text]);
    const second=await call(db,'save',expected(o,e),U,o.occurrence_id);assert.notEqual(second.wordbookEntryId,first.wordbookEntryId);
    assert.deepEqual(await counts(db),{ entries:2,canonical:2,senses:2,examples:2,links:2 });
  } finally { await db.close(); }
});
engineTest('shipped RPC: forced hash collision compares exact sense/example snapshots and rolls back rather than silently merging',async()=>{
  const db=await fixture();try {
    // OFFLINE-only collision fixture. Production helper is never replaced.
    await db.exec(`create or replace function public.wordbook_snapshot_key(p_values text[]) returns bytea language sql immutable strict parallel safe set search_path=pg_catalog as $$ select decode(repeat('00',32),'hex'); $$;`);
    await call(db);
    await db.query(`update lexical_occurrences set context_meaning_zh='different sense' where occurrence_id=$1`,[O]);
    await assert.rejects(call(db,'save',expected({ ...occurrence,context_meaning_zh:'different sense' })),/SENSE_HASH_COLLISION/);
    const next='They are running every day.';
    await db.query(`update lexical_occurrences set context_meaning_zh='跑步',context_text=$1,start_offset=9,end_offset=16 where occurrence_id=$2`,[next,O]);
    await db.query(`update lexical_source_blocks set source_text_hash=$1`,[canonicalSourceTextHash(next)]);
    await assert.rejects(call(db,'save',expected({ ...occurrence,context_text:next,start_offset:9,end_offset:16 },entry,
      { ...block,source_text_hash:canonicalSourceTextHash(next) })),/EXAMPLE_HASH_COLLISION/);
    assert.deepEqual(await counts(db),{ entries:1,canonical:1,senses:1,examples:1,links:1 });
    assert.equal((await db.query('select example_text from student_wordbook_examples')).rows[0].example_text,text);
  } finally { await db.close(); }
});
