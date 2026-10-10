// Offline, isolated Postgres only. No environment files, production clients or writes.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),{createRequire}=require('node:module');
const h=require('./helpers/wordbookFixedPoolFixture.cjs');
const {wordbookContextForm}=require('../lib/lexical/wordbookContextForm.ts');
const {wordbookContextRows}=require('../lib/lexical/wordbookList.ts');
const {spellingShape,presentReviewState}=require('../lib/lexical/wordbookReviewPresentation.ts');
const {gradeReview,localReview,reviewLocalState}=require('../lib/lexical/wordbookReviewLocal.ts');
const {readReviewRound}=require('../lib/lexical/wordbookReviewRound.server.ts');
const {client}=require('./helpers/wordbookReviewApiFixture.cjs');
// Reuse only the synthetic setup declarations, not the historical assertions.
const source=h.read('tests/studentWordbookContextCoverage.test.cjs');
const setup=vm.runInNewContext(source.slice(0,source.indexOf("test('fixed spaces"))+'\n({fixture,save,candidates,items});',
  {require:createRequire(require('node:path').resolve('tests/studentWordbookContextCoverage.test.cjs')),process,console});
const migration='supabase/student_wordbook_review_canonical_migration.sql';
const engine=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const samples=[
  ['yield','yields','noun','产量','ctw'],['compensate','compensated','verb','给予报酬','academic_discussion'],
  ['notify','notifying','verb','通知','write_email'],['sculpture','sculptures','noun','雕塑','bas'],
  ['circumstance','circumstances','noun','情况','write_email'],['none','None','pronoun','没有一个','bas'],
  ['motivated','motivated','adjective','有动力的','academic_discussion'],['upcoming','Upcoming','adjective','即将到来的','write_email'],
  ['London','London','proper_noun','伦敦','rap'],['NASA','NASA','proper_noun','美国航天局','rap']
];
async function fixture(){const db=await setup.fixture();await db.exec(h.read('supabase/student_wordbook_review_context_coverage_migration.sql'));return db;}
async function save(db,p){const [expression,surface,pos,meaning,source]=p;
  const text=surface==='None'?'None of these options work.':`We discuss ${surface} in this example.`;
  // The production canonical proper-noun identity is separate from lowercase search identity.
  if(pos==='proper_noun'){
    const e=(await db.query("insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant) values(gen_random_uuid(),$1,lower($1),'proper_noun','') returning entry_id",[expression])).rows[0];
    const id=h.uuid(),item=h.uuid(),block='proper-name',start=text.indexOf(surface);
    await db.query("insert into lexical_source_blocks values(gen_random_uuid(),$1,$2,$3,'sentence','hash','generated')",[source,item,block]);
    await db.query("insert into lexical_occurrences(occurrence_id,entry_id,source_type,source_item_id,content_block_id,surface_text,context_text,start_offset,end_offset,context_pos,context_meaning_zh,context_definition_en) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'A proper name.')",[id,e.entry_id,source,item,block,surface,text,start,start+surface.length,pos,meaning]);
    return {o:(await db.query('select * from lexical_occurrences where occurrence_id=$1',[id])).rows[0],...(await db.query("select operate_student_wordbook_v1($1,$2,'save',$3::jsonb) result",[h.U,id,JSON.stringify(await h.payload(db,id))])).rows[0].result};
  }
  return setup.save(db,{expression,surface,pos,meaning,source,context_text:text});
}
test('lookup formal headwords use canonical POS-aware identity and proper case, never surface or lemma heuristics',()=>{
  const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),exports={};
  const card=h.read('components/lexical/LexicalLookup.tsx');
  vm.runInNewContext(ts.transpileModule(card.slice(card.indexOf('export function LexicalLookupCard')),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,{exports,React,wordbookContextForm});
  for(const [expression,surface,pos,meaning] of samples){
    const o={surface_text:surface,context_pos:pos,context_meaning_zh:meaning,context_definition_en:'Stored sense.'};
    const entry={canonical_expression:expression,expression_type:pos==='proper_noun'?'proper_noun':'word',lemma:expression==='motivated'?'motivate':expression};
    const form=wordbookContextForm(o,entry);assert.equal(form.expression,expression);assert.equal(form.contextPos,pos);assert.equal(o.surface_text,surface);
    const html=renderToStaticMarkup(React.createElement(exports.LexicalLookupCard,{state:{selected:surface,result:{status:'matched',entry,occurrence:o}}}));
    assert.ok(html.includes(`>${expression}</p>`));assert.doesNotMatch(html,/标准词条：/);assert.ok(html.includes(meaning));
  }
});
engine('function-only repair keeps ALL data/history/pool unchanged and fixes canonical snapshots across Reading/Writing',async()=>{
  const db=await fixture();try{
    for(const p of samples)await save(db,p);for(const pos of ['noun','pronoun'])await h.pool(db,pos);
    const tables=['lexical_entries','lexical_occurrences','student_wordbook_entries','student_wordbook_senses','student_wordbook_examples','student_wordbook_example_senses','student_wordbook_canonical_links','student_wordbook_source_evidence','student_wordbook_activities','student_wordbook_review_items','student_wordbook_review_answers','student_wordbook_review_sessions','wordbook_review_fixed_distractors'];
    const dump=async()=>Promise.all(tables.map(async t=>(await db.query(`select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) data from ${t} t`)).rows[0].data));
    const before=await dump(),body=(await db.query("select prosrc from pg_proc where proname='wordbook_review_candidates'")).rows[0].prosrc;
    await db.exec(h.read(migration));assert.deepEqual(await dump(),before);
    const after=(await db.query("select prosrc from pg_proc where proname='wordbook_review_candidates'")).rows[0].prosrc;
    const algorithm=b=>b.slice(b.indexOf("      options:='[]';"),b.indexOf('      chosen:='));assert.equal(algorithm(after),algorithm(body));
    for(const domain of ['reading','writing']){
      const list=await h.list(db,{domain});for(const item of list.items)for(const row of wordbookContextRows(item))assert.equal(row.expression,item.expression);
      for(const item of list.items){const p=samples.find(p=>p[0]===item.expression);assert.ok(p);assert.equal(item.senses[0].contextPos,p[2]);assert.equal(item.senses[0].contextForms[0].expression,p[0]);assert.equal(item.senses[0].contextForms[0].surfaceText,p[1]);}
    }
    for(const p of samples.filter(p=>!['London','NASA'].includes(p[0]))){
      const domain=['ctw','rdl','rap'].includes(p[4])?'reading':'writing',all=await setup.candidates(db,[p[4]],domain);
      const c=all.find(c=>c.snapshot?.expression===p[0]);assert.ok(c,p[0]);assert.equal(c.snapshot.standardPos,p[2]);assert.equal(c.snapshot.meaning,p[3]);assert.deepEqual(c.snapshot.surfaceForms,[p[1]]);
    }
    // Two variants still save to a single canonical collection, retaining both evidence records.
    const first=await save(db,['yield','yield','noun','产量','ctw']);
    assert.equal((await db.query("select count(*)::int n from student_wordbook_entries where normalized_expression='yield'")).rows[0].n,1);
    assert.equal((await db.query('select count(*)::int n from student_wordbook_source_evidence where wordbook_entry_id=$1',[first.wordbookEntryId])).rows[0].n,2);
  }finally{await db.close();}
});
engine('new study/spelling/choice/retry use base form; examples retain exact surface/case and mask it; old scores never change',async()=>{
  const db=await fixture();try{
    for(const p of samples.slice(0,8))await save(db,p);for(const pos of ['noun','pronoun'])await h.pool(db,pos);
    // Reproduce the deployed regression in a completed spelling and a completed choice round.
    const old=await h.create(db,h.settings(['ctw'],'reading')),oldChoice=await h.create(db,h.settings(['bas'],'writing',2));
    const oldItems=await setup.items(db,old.session.session_id);assert.equal(oldItems[0].snapshot.expression,'yields');
    await h.submit(db,old.session.session_id,old.item.itemId,{spelling:'yield',pos:'noun'});
    for(const i of (await db.query('select item_id,snapshot from student_wordbook_review_items where session_id=$1 order by position',[oldChoice.session.session_id])).rows)
      await h.submit(db,oldChoice.session.session_id,i.item_id,{optionId:i.snapshot.options.find(o=>o.id!==i.snapshot.correctOptionId).id});
    const history=(await db.query('select * from student_wordbook_review_answers order by item_id')).rows;
    await db.exec(h.read(migration));assert.deepEqual(await setup.items(db,old.session.session_id),oldItems);assert.deepEqual((await db.query('select * from student_wordbook_review_answers order by item_id')).rows,history);
    for(const domain of ['reading','writing']){
      const sources=domain==='reading'?['ctw']:['write_email','academic_discussion','bas'];
      const count=domain==='reading'?1:7,created=await h.create(db,h.settings(sources,domain,count));
      const round=await readReviewRound(client(db),h.U,created.session.session_id);assert.deepEqual(new Set(round.cards.flatMap(c=>c.sourceTypes)),new Set(sources));
      for(const c of round.cards){
        const p=samples.find(p=>p[0]===c.expected.expression);assert.ok(p);assert.equal(c.expected.standardPos,p[2]);assert.equal(c.expected.meaning,p[3]);
        const local={...localReview(h.U,round),position:c.position};const study=reviewLocalState(local);
        assert.equal(study.item.study.expression,p[0]);assert.ok(study.item.example.some(part=>part.target&&part.text===p[1]));
        const testing=reviewLocalState({...local,phase:'test'});assert.equal(testing.item.spellingShape,spellingShape(p[0]));
        if(c.kind==='spelling_pos'){
          assert.ok(testing.item.example.some(part=>part.target&&part.text===''));assert.ok(!testing.item.example.some(part=>part.text.includes(p[1])));
          assert.equal(gradeReview(c,{spelling:p[0],pos:c.expected.pos}).correct,true);
          if(p[0].toLowerCase()!==p[1].toLowerCase())assert.equal(gradeReview(c,{spelling:p[1],pos:c.expected.pos}).assessments.spelling,false);
        }else {assert.equal(testing.item.prompt,p[0]);assert.equal(gradeReview(c,{optionId:c.expected.correctOptionId}).correct,true);}
      }
    }
    const newRound=await h.create(db,h.settings(['ctw'],'reading'));const raw=(await db.query('select wordbook_review_flow_state($1,$2) result',[h.U,newRound.session.session_id])).rows[0].result;
    assert.ok(presentReviewState(raw).item.example.some(p=>p.target&&p.text==='yields'));
    const testRaw=(await db.query("select wordbook_review_flow_state($1,$2,'start_test',$3) result",[h.U,newRound.session.session_id,raw.item.itemId])).rows[0].result;
    assert.ok(presentReviewState(testRaw).item.example.some(p=>p.target&&p.text===''));
    const saved=await h.submit(db,newRound.session.session_id,raw.item.itemId,{spelling:'yield',pos:'noun'});assert.equal(saved.item.answer.correct,true);assert.equal(saved.item.answer.expression,'yield');
    const retry=await h.create(db,{},h.U,old.session.session_id);const r=(await setup.items(db,retry.session.session_id))[0];assert.equal(r.snapshot.expression,'yield');assert.deepEqual(r.snapshot.surfaceForms,['yields']);
    const retryChoice=await h.create(db,{},h.U,oldChoice.session.session_id);const choices=await setup.items(db,retryChoice.session.session_id);assert.deepEqual(new Set(choices.map(i=>i.snapshot.expression)),new Set(['sculpture','none']));
    assert.deepEqual((await db.query('select * from student_wordbook_review_answers where session_id in ($1,$2) order by item_id',[old.session.session_id,oldChoice.session.session_id])).rows,history);
  }finally{await db.close();}
});
