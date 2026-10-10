// Isolated Postgres tests only: no env, production client, SQL or student writes.
const test=require('node:test'),assert=require('node:assert/strict');
const h=require('./helpers/wordbookFixedPoolFixture.cjs');
const {wordbookContextForm}=require('../lib/lexical/wordbookContextForm.ts');
const {wordbookContextRows}=require('../lib/lexical/wordbookList.ts');
const {spellingShape}=require('../lib/lexical/wordbookReviewPresentation.ts');
const {insertReviewSpelling,constrainReviewSpelling,spellingInputValue}=require('../lib/lexical/wordbookReviewInput.ts');
const {gradeReview}=require('../lib/lexical/wordbookReviewLocal.ts');
const {reviewRpc}=require('../lib/lexical/wordbookReview.server.ts');
const migration='supabase/student_wordbook_review_context_coverage_migration.sql';
const reviewed={occurrence_id:'7d9149ee-c1b6-52a8-8da7-21094c9b4446',entry_id:'2276d60e-63b6-505d-89b6-cc531c1a61d1',
  source_type:'academic_discussion',source_item_id:'5971fd56-b771-4ab3-9b8c-443068c5fa1b',content_block_id:'student-response:1',
  surface_text:'motivated',context_pos:'verb',context_meaning_zh:'有动力的',context_definition_en:'Give reason to act.'};
const targetEntry='3b34cff2-4169-5086-8708-d9987b118108';
const sourceText='I do not think volunteers should receive any form of compensation because it can change the true meaning of volunteering. Volunteering should be about helping others, not earning rewards. Even small rewards may result in attracting people who are not truly motivated to help the cause.';
const sourceFixture={expression:'motivate',surface:'motivated',pos:'verb',meaning:'有动力的',source:'academic_discussion',definition:'Give reason to act.',
  entry_id:reviewed.entry_id,occurrence_id:reviewed.occurrence_id,source_item_id:reviewed.source_item_id,content_block_id:reviewed.content_block_id,context_text:sourceText};
const engine=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
async function fixture(){const db=await h.fixture();await db.exec(h.read('supabase/student_wordbook_review_v1_choice_preference_migration.sql'));
  await db.exec(h.read('supabase/student_wordbook_review_v1_immersive_migration.sql'));
  await db.exec('alter table lexical_occurrences add column updated_at timestamptz default now()');
  await db.query("insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant) values($1,'motivated','motivated','word','')",[targetEntry]);
  await save(db,{...sourceFixture,collect:false});return db;}
async function save(db,{expression='sample',surface=expression,pos='noun',meaning='样本',source='ctw',definition='Isolated context.',...overrides}={}){
  const e=(await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant)
    values($1,$2,lower($2),'word','') on conflict(normalized_expression,expression_type,identity_variant) do update set canonical_expression=excluded.canonical_expression returning entry_id`,[overrides.entry_id??h.uuid(),expression])).rows[0];
  const text=overrides.context_text??`We use ${surface} in this context.`,start=text.indexOf(surface);
  const o={occurrence_id:overrides.occurrence_id??h.uuid(),entry_id:e.entry_id,source_type:source,source_item_id:overrides.source_item_id??h.uuid(),
    content_block_id:overrides.content_block_id??h.uuid(),surface_text:surface,context_text:text,start_offset:start,end_offset:start+surface.length,
    context_pos:pos,context_meaning_zh:meaning,context_definition_en:definition};
  await db.query(`insert into lexical_source_blocks(block_id,source_type,source_item_id,content_block_id,source_text_hash,generation_status,block_kind)
    values(gen_random_uuid(),$1,$2,$3,'hash','generated','sentence') on conflict(source_type,source_item_id,content_block_id) do nothing`,[source,o.source_item_id,o.content_block_id]);
  await db.query(`insert into lexical_occurrences(occurrence_id,entry_id,source_type,source_item_id,content_block_id,surface_text,context_text,
    start_offset,end_offset,context_pos,context_meaning_zh,context_definition_en,review_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'generated') on conflict(occurrence_id) do nothing`,Object.values(o));
  if(overrides.collect===false)return {o};
  const payload=await h.payload(db,o.occurrence_id);Object.assign(payload,{example_text:text,context_kind:'sentence',extraction_method:'verified_sentence_span'});
  const saved=(await db.query('select operate_student_wordbook_v1($1,$2,\'save\',$3::jsonb) result',[h.U,o.occurrence_id,JSON.stringify(payload)])).rows[0].result;
  return {...saved,o};
}
const candidates=async(db,sources,domain='reading')=>(await db.query('select * from wordbook_review_candidates($1,$2,$3::text[],null,null)',[h.U,domain,sources])).rows;
const items=async(db,id)=>(await db.query('select wordbook_entry_id,kind,snapshot from student_wordbook_review_items where session_id=$1 order by position',[id])).rows;
test('fixed spaces never consume input; hyphens are hidden, editable and count toward the limit',()=>{
  for(const [expression,typed] of [['result in','resultin'],['drop-off','drop-off'],['in front of','infrontof'],['well-known long-term','well-knownlong-term']]){
    const shape=spellingShape(expression);assert.equal(shape.replace(/\s/g,'').length,typed.length);assert.ok(!shape.includes('-'));
    const edit=insertReviewSpelling(shape,'',0,0,typed+'ZZ');assert.equal(edit.value,expression);assert.equal(edit.caret,typed.length);
    assert.equal(insertReviewSpelling(shape,'',0,0,expression).value,expression);
  }
  assert.deepEqual(insertReviewSpelling(spellingShape('result in'),'result in',6,7,'XYZ'),{value:'result Xn',caret:7});
  assert.equal(constrainReviewSpelling(spellingShape('result in'),'result in','resultn').value,'result n');
  assert.equal(insertReviewSpelling(spellingShape('result in'),'result n',6,6,'i').value,'result in');
  assert.equal(spellingInputValue(insertReviewSpelling(spellingShape('drop-off'),'',0,0,'dropoff').value),'dropoff');
  const card={kind:'spelling_pos',expected:{expression:'drop-off',pos:'noun'}};
  assert.equal(gradeReview(card,{spelling:'dropoff',pos:'noun'}).assessments.spelling,false);
  assert.equal(gradeReview(card,{spelling:'dropXoff',pos:'noun'}).assessments.spelling,false);
  assert.equal(gradeReview(card,{spelling:'drop-off',pos:'noun'}).correct,true);
});
test('context display uses canonical identity and stored sense without a motivated special case',()=>{
  assert.deepEqual(wordbookContextForm(reviewed,{canonical_expression:'motivate'}),{expression:'motivate',contextPos:'verb',contextMeaningZh:'有动力的',contextDefinitionEn:'Give reason to act.'});
  assert.equal(reviewed.context_pos,'verb');
  for(const patch of [{occurrence_id:h.uuid()},{context_meaning_zh:'激励'},{source_type:'rdl'},{context_pos:'adjective'}]){
    const o={...reviewed,...patch};assert.equal(wordbookContextForm(o,{canonical_expression:'motivate'}).contextPos,o.context_pos);
  }
  for(const [expression,pos] of [['interested','adjective'],['involved','verb'],['involved','adjective'],['yields','noun'],['record','verb'],['record','noun']])
    assert.equal(wordbookContextForm({...reviewed,occurrence_id:h.uuid(),surface_text:expression,context_pos:pos},{canonical_expression:expression}).contextPos,pos);
});
test('lookup renders corrected stored POS/form and canonical identity; orphan saved examples remain visible',()=>{
  const ts=require('typescript'),vm=require('node:vm'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
  const source=h.read('components/lexical/LexicalLookup.tsx'),exports={};
  vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('export function LexicalLookupCard')),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,{exports,React,wordbookContextForm});
  const corrected={...reviewed,entry_id:targetEntry,context_pos:'adjective',context_definition_en:'Eager to help the cause.'};
  const result={status:'matched',match:'exact_token',entry:{entry_id:targetEntry,canonical_expression:'motivated',expression_type:'word',lemma:'motivated'},occurrence:corrected};
  const html=renderToStaticMarkup(React.createElement(exports.LexicalLookupCard,{state:{selected:'motivated',result}}));
  assert.match(html,/>motivated<\/p>/);assert.match(html,/>adjective<\/p>/);assert.doesNotMatch(html,/标准词条：/);assert.match(html,/有动力的/);assert.equal(result.occurrence.context_pos,'adjective');
  const item={expression:'motivated',sourceTypes:['academic_discussion'],senses:[{senseId:'s',contextPos:'adjective',contextMeaningZh:'有动力的',contextDefinitionEn:null,exampleIds:['old'],contextForms:[{...wordbookContextForm(corrected,result.entry),occurrenceId:reviewed.occurrence_id,sourceType:'academic_discussion',exampleIds:[]}]}],examples:[{exampleId:'old',text:'An older saved example.',sourceTypes:['academic_discussion']}]};
  const rows=wordbookContextRows(item);assert.equal(rows.length,2);assert.equal(rows[0].expression,'motivated');assert.equal(rows[1].example.text,'An older saved example.');
});
test('coverage RPC failures return actionable 409 messages rather than a generic service error',async()=>{
  for(const [code,expected] of [['REVIEW_COVERAGE_MISSING:ctw','CTW 没有'],['REVIEW_COVERAGE_COUNT:3','至少选择 3 个'],['REVIEW_COVERAGE_OVERLAP','词条重叠']])
    await assert.rejects(reviewRpc({rpc:async()=>({error:{message:code}})},'wordbook_review_create',{}),e=>e.status===409&&e.message.includes(expected));
});
engine('manual data repair preserves collection IDs/dates and history; stored lookup/save/list/new review agree',async()=>{
  const db=await fixture();try{
    const saved=await save(db,sourceFixture);
    await save(db,{expression:'motivate',surface:'motivated',pos:'verb',meaning:'激励',source:'academic_discussion',definition:'Inspired action',entry_id:reviewed.entry_id,
      occurrence_id:'5010c2e4-196b-50ed-87ea-3794fd6317ed',context_text:'Political cartoons motivated voters to demand better leadership.',collect:false});
    const otherOccurrences=(await db.query('select * from lexical_occurrences where occurrence_id<>$1 order by occurrence_id',[reviewed.occurrence_id])).rows;
    const evidenceBefore=(await db.query('select * from student_wordbook_source_evidence where occurrence_id=$1',[reviewed.occurrence_id])).rows[0];
    const collectionBefore=(await db.query('select wordbook_entry_id,first_saved_at from student_wordbook_entries where wordbook_entry_id=$1',[saved.wordbookEntryId])).rows[0];
    const senseBefore=(await db.query('select sense_id,first_saved_at from student_wordbook_senses where wordbook_entry_id=$1',[saved.wordbookEntryId])).rows[0];
    const old=await h.create(db,h.settings(['academic_discussion'],'writing'));
    const snapshot=(await items(db,old.session.session_id))[0];assert.equal(snapshot.snapshot.expression,'motivate');
    await h.submit(db,old.session.session_id,old.item.itemId,{spelling:'motivated',pos:'adjective'});
    await h.pool(db);
    const protectedTables=['lexical_entries','student_wordbook_examples','student_wordbook_example_senses','student_wordbook_activities','student_wordbook_review_items','student_wordbook_review_answers','student_wordbook_review_sessions','wordbook_review_fixed_distractors'];
    const before=await Promise.all(protectedTables.map(async t=>(await db.query(`select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) rows from ${t} t`)).rows[0].rows));
    await db.exec(h.read(migration));
    assert.deepEqual((await db.query('select * from lexical_occurrences where occurrence_id<>$1 order by occurrence_id',[reviewed.occurrence_id])).rows,otherOccurrences);
    const evidenceAfter=(await db.query('select * from student_wordbook_source_evidence where occurrence_id=$1',[reviewed.occurrence_id])).rows[0];
    assert.deepEqual(evidenceAfter,{...evidenceBefore,lexical_entry_id:targetEntry,canonical_normalized_expression:'motivated'});
    for(const signature of ['wordbook_saved_contexts(uuid,text[])','wordbook_review_cover(jsonb,text[])','wordbook_review_select(jsonb,text[],integer)']){
      const acl=(await db.query('select has_function_privilege(\'anon\',$1,\'EXECUTE\') a,has_function_privilege(\'authenticated\',$1,\'EXECUTE\') u,has_function_privilege(\'service_role\',$1,\'EXECUTE\') s',[signature])).rows[0];assert.deepEqual(acl,{a:false,u:false,s:true});
    }
    const after=await Promise.all(protectedTables.map(async t=>(await db.query(`select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) rows from ${t} t`)).rows[0].rows));assert.deepEqual(after,before);
    assert.deepEqual((await db.query('select wordbook_entry_id,first_saved_at from student_wordbook_entries where wordbook_entry_id=$1',[saved.wordbookEntryId])).rows[0],collectionBefore);
    assert.deepEqual((await db.query('select sense_id,first_saved_at from student_wordbook_senses where wordbook_entry_id=$1',[saved.wordbookEntryId])).rows[0],senseBefore);
    const freshPayload=await h.payload(db,reviewed.occurrence_id);assert.equal(freshPayload.entry_id,targetEntry);assert.equal(freshPayload.canonical_expression,'motivated');assert.equal(freshPayload.context_pos,'adjective');assert.equal(freshPayload.context_meaning_zh,'有动力的');
    const resaved=(await db.query("select operate_student_wordbook_v1($1,$2,'save',$3::jsonb) result",[h.U,reviewed.occurrence_id,JSON.stringify(freshPayload)])).rows[0].result;
    assert.equal(resaved.wordbookEntryId,saved.wordbookEntryId);
    assert.deepEqual((await db.query('select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) rows from student_wordbook_activities t')).rows[0].rows,before[protectedTables.indexOf('student_wordbook_activities')]);
    const listing=await h.list(db,{domain:'writing'});const rows=wordbookContextRows(listing.items[0]);assert.equal(rows[0].expression,'motivated');assert.equal(rows[0].sense.contextPos,'adjective');assert.equal(rows[0].sense.contextMeaningZh,'有动力的');assert.equal(listing.items[0].expression,'motivated');
    const created=await h.create(db,h.settings(['academic_discussion'],'writing'));
    const next=(await items(db,created.session.session_id))[0];assert.equal(next.snapshot.expression,'motivated');assert.equal(next.snapshot.pos,'adjective');assert.equal(next.snapshot.standardPos,'adjective');
    assert.equal(next.snapshot.meaning,'有动力的');assert.equal(next.snapshot.canonicalExpression,'motivated');assert.equal(next.wordbook_entry_id,saved.wordbookEntryId);
    assert.deepEqual((await items(db,old.session.session_id))[0],snapshot);
    const historicalRetry=await h.create(db,{},h.U,old.session.session_id);const retryItem=(await items(db,historicalRetry.session.session_id))[0];
    assert.equal(retryItem.snapshot.expression,'motivated');assert.equal(retryItem.snapshot.pos,'adjective');assert.equal(retryItem.snapshot.meaning,'有动力的');assert.equal(retryItem.snapshot.evidence[0].lexical_entry_id,targetEntry);
    assert.deepEqual((await items(db,old.session.session_id))[0],snapshot);
    const study=(await db.query('select wordbook_review_flow_state($1,$2) result',[h.U,created.session.session_id])).rows[0].result;
    assert.equal(study.presentation.expression,'motivated');assert.equal(study.presentation.pos,'adjective');
    await db.query("select wordbook_review_flow_state($1,$2,'start_test',$3)",[h.U,created.session.session_id,study.item.itemId]);
    const answer=await h.submit(db,created.session.session_id,study.item.itemId,{spelling:'motivated',pos:'adjective'});assert.equal(answer.item.answer.correct,true);
  }finally{await db.close();}
});
engine('repair splits only the bad source from a shared motivate collection and reuses an already-saved motivated entry',async()=>{
  const db=await fixture();try{
    const wrong=await save(db,sourceFixture);
    const correct=await save(db,{expression:'motivate',surface:'motivated',pos:'verb',meaning:'激励',source:'academic_discussion',definition:'Inspired action',
      entry_id:reviewed.entry_id,occurrence_id:'5010c2e4-196b-50ed-87ea-3794fd6317ed',
      context_text:'Political cartoons exposed corruption and motivated voters to demand better leadership.'});
    assert.equal(correct.wordbookEntryId,wrong.wordbookEntryId);
    const adjective=await save(db,{expression:'motivated',pos:'adjective',meaning:'积极的',source:'academic_discussion',definition:'Willing to work hard',entry_id:targetEntry});
    const untouched=async()=>({
      occurrence:(await db.query('select * from lexical_occurrences where occurrence_id=$1',[correct.o.occurrence_id])).rows,
      senses:(await db.query("select * from student_wordbook_senses where context_meaning_zh in ('激励','积极的') order by sense_id")).rows,
      activities:(await db.query('select * from student_wordbook_activities order by activity_id')).rows,
      correctEvidence:(await db.query('select * from student_wordbook_source_evidence where occurrence_id=$1',[correct.o.occurrence_id])).rows
    });
    const before=await untouched();await db.exec(h.read(migration));assert.deepEqual(await untouched(),before);
    const wrongEv=(await db.query('select * from student_wordbook_source_evidence where occurrence_id=$1',[reviewed.occurrence_id])).rows[0];
    assert.equal(wrongEv.wordbook_entry_id,adjective.wordbookEntryId);assert.equal(wrongEv.lexical_entry_id,targetEntry);
    const listing=await h.list(db,{domain:'writing'});assert.equal(listing.total,2);
    const verb=listing.items.find(i=>i.wordbookEntryId===correct.wordbookEntryId);assert.equal(verb.expression,'motivate');assert.deepEqual(verb.senses.map(s=>s.contextMeaningZh),['激励']);
    const adj=listing.items.find(i=>i.wordbookEntryId===adjective.wordbookEntryId);assert.deepEqual(new Set(adj.senses.map(s=>s.contextMeaningZh)),new Set(['有动力的','积极的']));
    assert.ok(wordbookContextRows(adj).some(r=>r.sense.contextMeaningZh==='有动力的'&&r.sense.contextPos==='adjective'&&r.example.text===sourceText));
    const all=await candidates(db,['academic_discussion'],'writing');assert.equal(all.length,2);
    assert.ok(all.some(c=>c.snapshot?.pos==='verb'&&c.snapshot.meaning==='激励'));
    const fresh=await h.payload(db,reviewed.occurrence_id);const saveAgain=(await db.query("select operate_student_wordbook_v1($1,$2,'save',$3::jsonb) result",[h.U,reviewed.occurrence_id,JSON.stringify(fresh)])).rows[0].result;
    assert.equal(saveAgain.wordbookEntryId,adjective.wordbookEntryId);
    const newStudent=(await db.query("select operate_student_wordbook_v1($1,$2,'save',$3::jsonb) result",[h.V,reviewed.occurrence_id,JSON.stringify(fresh)])).rows[0].result;
    const newList=await h.list(db,{domain:'writing',user:h.V});assert.equal(newList.items[0].wordbookEntryId,newStudent.wordbookEntryId);assert.equal(newList.items[0].expression,'motivated');assert.equal(newList.items[0].senses[0].contextPos,'adjective');
    const round=await h.create(db,h.settings(['academic_discussion'],'writing'),h.V);const snapshot=(await items(db,round.session.session_id))[0].snapshot;assert.equal(snapshot.expression,'motivated');assert.equal(snapshot.pos,'adjective');
  }finally{await db.close();}
});
engine('identity collision merges only the erroneous shell, preserving activity IDs/dates and review history',async()=>{
  const db=await fixture();try{
    const wrong=await save(db,sourceFixture);
    const adjective=await save(db,{expression:'motivated',pos:'adjective',meaning:'积极的',source:'academic_discussion',entry_id:targetEntry});
    const old=await h.create(db,h.settings(['academic_discussion'],'writing',2));
    for(const item of (await db.query('select item_id from student_wordbook_review_items where session_id=$1 order by position',[old.session.session_id])).rows)
      await h.submit(db,old.session.session_id,item.item_id,{spelling:'wrong',pos:'noun'});
    const historyBefore=await items(db,old.session.session_id);
    const answersBefore=(await db.query('select * from student_wordbook_review_answers order by item_id')).rows;
    const before=(await db.query('select activity_id,activity_at,event_type from student_wordbook_activities order by activity_id')).rows;
    await db.exec(h.read(migration));
    assert.deepEqual(await items(db,old.session.session_id),historyBefore);
    assert.deepEqual((await db.query('select * from student_wordbook_review_answers order by item_id')).rows,answersBefore);
    assert.deepEqual((await db.query('select activity_id,activity_at,event_type from student_wordbook_activities order by activity_id')).rows,before);
    assert.equal((await db.query('select count(*)::int n from student_wordbook_entries where wordbook_entry_id=$1',[wrong.wordbookEntryId])).rows[0].n,0);
    const list=await h.list(db,{domain:'writing'});assert.equal(list.total,1);assert.equal(list.items[0].wordbookEntryId,adjective.wordbookEntryId);assert.equal(list.items[0].senses.length,2);
    const retry=await h.create(db,{},h.U,old.session.session_id);assert.equal(retry.session.total,1);
    const selected=await items(db,retry.session.session_id);assert.equal(selected[0].wordbook_entry_id,adjective.wordbookEntryId);assert.equal(selected[0].snapshot.expression,'motivated');assert.equal(selected[0].snapshot.pos,'adjective');
    for(const table of ['student_wordbook_entries','student_wordbook_senses','student_wordbook_source_evidence','student_wordbook_activities'])
      assert.equal((await db.query('select count(*)::int n from pg_trigger where tgrelid=$1::regclass and not tgisinternal and tgenabled<>\'O\'',[table])).rows[0].n,0);
    await assert.rejects(db.exec("update student_wordbook_senses set context_pos='verb' where context_meaning_zh='有动力的'"),/IMMUTABLE/);
  }finally{await db.close();}
});
engine('a shared motivate collection without a motivated collection splits only the bad source, retaining correct sense/example IDs',async()=>{
  const db=await fixture();try{
    const wrong=await save(db,sourceFixture);
    await save(db,{expression:'motivate',pos:'verb',meaning:'激励',source:'write_email',definition:'Encourage someone to act.',entry_id:reviewed.entry_id});
    const before=(await db.query("select to_jsonb(s) sense,to_jsonb(x) example from student_wordbook_senses s join student_wordbook_example_senses l using(sense_id) join student_wordbook_examples x using(example_id) where s.context_meaning_zh='激励'")).rows;
    await db.exec(h.read(migration));
    assert.deepEqual((await db.query("select to_jsonb(s) sense,to_jsonb(x) example from student_wordbook_senses s join student_wordbook_example_senses l using(sense_id) join student_wordbook_examples x using(example_id) where s.context_meaning_zh='激励'")).rows,before);
    const list=await h.list(db,{domain:'writing'});assert.equal(list.total,2);
    const verb=list.items.find(i=>i.wordbookEntryId===wrong.wordbookEntryId);assert.equal(verb.expression,'motivate');assert.deepEqual(verb.sourceTypes,['write_email']);
    const adj=list.items.find(i=>i.expression==='motivated');assert.equal(adj.senses[0].contextPos,'adjective');assert.equal(adj.examples[0].text,sourceText);
    const q=h.settings(['write_email','academic_discussion'],'writing',2);assert.equal((await h.availability(db,q)).coverageError,null);
    const round=await h.create(db,q);const selected=await items(db,round.session.session_id);assert.deepEqual(new Set(selected.map(i=>i.snapshot.pos)),new Set(['verb','adjective']));
  }finally{await db.close();}
});
engine('source/association drift aborts the whole repair; no partial data or disabled guards survive rollback',async()=>{
  const db=await fixture();try{
    await save(db,sourceFixture);
    await db.exec("update lexical_source_blocks set source_text_hash='changed' where source_item_id='5971fd56-b771-4ab3-9b8c-443068c5fa1b'");
    await assert.rejects(db.exec(h.read(migration)),/KELLY_MOTIVATED_SAVED_ASSOCIATION_DRIFT/);await db.exec('rollback');
    const raw=await h.payload(db,reviewed.occurrence_id);assert.equal(raw.entry_id,reviewed.entry_id);assert.equal(raw.context_pos,'verb');
    const list=await h.list(db,{domain:'writing'});assert.equal(list.items[0].expression,'motivate');
    assert.equal((await db.query("select count(*)::int n from pg_trigger where tgname like 'student_wordbook_%guard' and tgenabled<>'O'")).rows[0].n,0);
    assert.equal((await db.query("select to_regprocedure('wordbook_saved_contexts(uuid,text[])') present")).rows[0].present,null);
  }finally{await db.close();}
});
engine('Reading CTW/RDL/RAP random 10 and CTW/RDL cover every source; overlap is assigned without repeated lexemes',async()=>{
  const db=await fixture();try{
    // CTW overlaps both choice sources: reserving it blindly for RDL would starve CTW.
    await save(db,{expression:'shared',meaning:'系统',source:'ctw'});await save(db,{expression:'shared',meaning:'系统',source:'rdl'});await save(db,{expression:'shared',meaning:'系统',source:'rap'});
    for(let i=0;i<12;i++)await save(db,{expression:'choice'+String.fromCharCode(97+i),meaning:'样本',source:i%2?'rdl':'rap'});
    await h.pool(db);await db.exec(h.read(migration));
    const all=['ctw','rdl','rap'],available=await h.availability(db,h.settings(all,'reading',10));assert.equal(available.coverageError,null);assert.equal(available.total,13);assert.deepEqual(available.sourceCounts,{ctw:1,rdl:7,rap:7});
    for(let n=0;n<3;n++){
      const created=await h.create(db,h.settings(all,'reading',10));const selected=await items(db,created.session.session_id);
      assert.equal(selected.length,10);assert.equal(new Set(selected.map(i=>i.wordbook_entry_id)).size,10);
      assert.deepEqual(new Set(selected.map(i=>i.snapshot.assignedSource)),new Set(all));
      assert.ok(selected.some(i=>i.kind==='spelling_pos'));assert.ok(selected.some(i=>i.kind==='meaning_choice'));
      for(const i of selected)assert.deepEqual(i.snapshot.testedSources,[i.snapshot.assignedSource]);
    }
    const two=await h.create(db,h.settings(['ctw','rdl'],'reading',7));assert.deepEqual(new Set((await items(db,two.session.session_id)).map(i=>i.kind)),new Set(['spelling_pos','meaning_choice']));
  }finally{await db.close();}
});
engine('Writing WE/AD/BAS covers all sources using each source sense/form and one item per lexeme',async()=>{
  const db=await fixture();try{
    await save(db,{expression:'involve',surface:'involved',source:'write_email',pos:'adjective',meaning:'参与的'});
    await save(db,{expression:'involve',surface:'involves',source:'academic_discussion',pos:'verb',meaning:'包含'});
    await save(db,{expression:'involve',surface:'involve',source:'bas',pos:'verb',meaning:'涉及'});
    await save(db,{expression:'interested',source:'write_email',pos:'adjective',meaning:'感兴趣的'});
    await save(db,{expression:'record',source:'academic_discussion',pos:'verb',meaning:'记录'});
    await save(db,{expression:'record',source:'bas',pos:'noun',meaning:'档案'});
    for(let n=0;n<8;n++)await save(db,{expression:'sample'+String.fromCharCode(97+n),source:'bas',pos:'noun',meaning:'样本'});
    await h.pool(db);await h.pool(db,'verb');await h.pool(db,'adjective');await db.exec(h.read(migration));
    const sources=['write_email','academic_discussion','bas'];const created=await h.create(db,h.settings(sources,'writing',10));
    const selected=await items(db,created.session.session_id);assert.equal(selected.length,10);assert.deepEqual(new Set(selected.map(i=>i.snapshot.assignedSource)),new Set(sources));
    assert.equal(new Set(selected.map(i=>i.wordbook_entry_id)).size,10);
    for(const i of selected)assert.equal(i.kind,i.snapshot.assignedSource==='bas'?'meaning_choice':'spelling_pos');
    const forms=await candidates(db,sources,'writing');assert.ok(forms.some(c=>c.snapshot?.expression==='involved'&&c.snapshot.pos==='adjective'));
    assert.ok(forms.some(c=>c.snapshot?.expression==='involves'&&c.snapshot.pos==='verb'));
    assert.ok(forms.some(c=>c.snapshot?.expression==='record'&&c.snapshot.pos==='noun'&&c.kind==='meaning_choice'));
  }finally{await db.close();}
});
engine('zero source, count below source count, total shortage, and Hall overlap all fail before creating a session',async()=>{
  const db=await fixture();try{
    await save(db,{expression:'shared',source:'ctw'});await save(db,{expression:'shared',source:'rdl'});
    for(let n=0;n<4;n++)await save(db,{expression:'rap'+String.fromCharCode(97+n),source:'rap'});
    await h.pool(db);await db.exec(h.read(migration));
    let q=h.settings(['ctw','rdl','rap'],'reading',3);assert.equal((await h.availability(db,q)).coverageError,'REVIEW_COVERAGE_OVERLAP');await assert.rejects(h.create(db,q),/REVIEW_COVERAGE_OVERLAP/);
    q=h.settings(['ctw','rap'],'reading',1);assert.match((await h.availability(db,q)).coverageError,/REVIEW_COVERAGE_COUNT:2/);await assert.rejects(h.create(db,q),/REVIEW_COVERAGE_COUNT:2/);
    q=h.settings(['ctw','rap'],'reading',10);await assert.rejects(h.create(db,q),/REVIEW_INSUFFICIENT:5/);
    q=h.settings(['write_email','academic_discussion','bas'],'writing',10);assert.match((await h.availability(db,q)).coverageError,/REVIEW_COVERAGE_MISSING/);await assert.rejects(h.create(db,q),/REVIEW_COVERAGE_MISSING/);
    assert.equal((await db.query('select count(*)::int n from student_wordbook_review_sessions')).rows[0].n,0);
    const graph=[['a','ctw'],['a','rdl'],['b','ctw'],['c','rap']].map(([id,source])=>({entry_id:id,snapshot:{assignedSource:source}}));
    const matched=(await db.query('select wordbook_review_cover($1::jsonb,array[\'ctw\',\'rdl\',\'rap\']) v',[JSON.stringify(graph)])).rows[0].v;
    assert.deepEqual(matched.map(c=>c.entry_id),['b','a','c']); // Greedy first pick would wrongly fail.
  }finally{await db.close();}
});
engine('real-shaped participle, inflected noun and homograph cases keep source POS/meaning; date rounds and missing provenance stay safe',async()=>{
  const db=await fixture();try{
    const samples=[
      {expression:'involve',surface:'involved',pos:'verb',meaning:'涉及',context_text:'Traditionally, drug discovery involved labor-intensive trial and error.'},
      {expression:'involved',surface:'involved',pos:'adjective',meaning:'参与的',context_text:'Dramaturges are involved only during early planning stages.'},
      {expression:'yield',surface:'yields',pos:'noun',meaning:'产量',context_text:'Practices improve soil health, crop yields, and food security.'},
      {expression:'record',surface:'record',pos:'noun',meaning:'档案'},
      {expression:'record',surface:'record',pos:'verb',meaning:'记录'}
    ];
    for(const p of samples)await save(db,p);await db.exec(h.read(migration));
    const all=await candidates(db,['ctw']);assert.equal(all.length,4);
    const entry=(await db.query("select wordbook_entry_id from student_wordbook_entries where expression='record'")).rows[0].wordbook_entry_id;
    const list=await h.list(db);const homograph=wordbookContextRows(list.items.find(i=>i.wordbookEntryId===entry));
    assert.deepEqual(new Set(homograph.map(r=>r.sense.contextPos)),new Set(['noun','verb']));
    for(const p of samples.slice(0,3)){const c=all.find(c=>c.snapshot?.expression===p.surface&&c.snapshot?.pos===p.pos);assert.ok(c);assert.equal(c.snapshot.meaning,p.meaning);}
    const day=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
    const dated=await h.create(db,{domain:'reading',sources:['ctw'],mode:'date',timeZone:'Asia/Shanghai',start:day,end:day});assert.equal(dated.session.total,4);
    await db.exec("update lexical_occurrences set context_pos='adjective' where surface_text='yields'");
    assert.ok((await candidates(db,['ctw'])).some(c=>c.reason==='missing_source_sense'));
    assert.equal((await h.availability(db,h.settings(['ctw'],'reading',3))).total,3);
  }finally{await db.close();}
});
engine('single source retains new/less-reviewed preference; create replay, historical retry and choice algorithms are preserved',async()=>{
  const db=await fixture();try{
    for(const expression of ['apple','banana','cherry'])await save(db,{expression,source:'ctw'});
    const originalBody=(await db.query("select prosrc from pg_proc where proname='wordbook_review_candidates'")).rows[0].prosrc;
    await db.exec(h.read(migration));const body=(await db.query("select prosrc from pg_proc where proname='wordbook_review_candidates'")).rows[0].prosrc;
    assert.equal(body.slice(body.indexOf("      options:='[]';"),body.indexOf('      chosen:=')),originalBody.slice(originalBody.indexOf("      options:='[]';"),originalBody.indexOf('      chosen:=')));
    const request=h.uuid(),first=await h.create(db,h.settings(['ctw'],'reading',1),h.U,null,request);
    assert.equal((await h.create(db,h.settings(['ctw'],'reading',1),h.U,null,request)).session.session_id,first.session.session_id);
    const firstItem=(await items(db,first.session.session_id))[0];
    const flow=(await db.query('select wordbook_review_flow_state($1,$2) result',[h.U,first.session.session_id])).rows[0].result;
    await h.submit(db,first.session.session_id,flow.item.itemId,{spelling:'wrong',pos:'noun'});
    const retry=await h.create(db,{},h.U,first.session.session_id);assert.deepEqual((await items(db,retry.session.session_id))[0].snapshot,firstItem.snapshot);
    const next=await h.create(db,h.settings(['ctw'],'reading',1));assert.notEqual((await items(db,next.session.session_id))[0].wordbook_entry_id,firstItem.wordbook_entry_id);
  }finally{await db.close();}
});
