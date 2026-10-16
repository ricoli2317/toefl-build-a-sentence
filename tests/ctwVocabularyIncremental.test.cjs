const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const f=require('./helpers/ctwIncrementalFixture.cjs');
const {planCtw,prepareCtw,verifyCtw,digest,validateIncrementalForms}=f.core;
const {buildCtwDeltaSql}=require('../lib/ctw-vocabulary/incrementalSql.ts');
const reviewRuntime=require('../lib/ctw-vocabulary/review.ts');
const server=require('../lib/ctw-vocabulary/review.server.ts');
const store=require('../lib/ctw-vocabulary/store.server.ts');
const local=require('../lib/lexical/wordbookReviewLocal.ts');
const {readCtwSnapshotViaApi}=require('../lib/ctw-vocabulary/incrementalSnapshot.server.ts');

test('explicit user-confirmed NEW scope processes only those IDs without reconstructing historical coverage',()=>{
  const s=f.snapshot(),cp={version:'ctw-incremental-checkpoint-v1',sources:{},new_canonical_scope:{ids:['new'],authority:'Explicit user confirmation: all prior canonical already processed'}};
  const p=planCtw(s,cp);assert.deepEqual(p.new_canonical,['new']);assert.deepEqual(p.unchanged,['historical']);assert.deepEqual(p.previous.sources,{});
  assert.equal(p.candidates.length,4);const pub=prepareCtw(p,f.review(p));assert.equal(pub.new_entries.length,1);
  assert.ok(!pub.next_checkpoint.new_canonical_scope);assert.equal(Object.keys(pub.next_checkpoint.sources).length,2);
  for(const ids of [['missing'],['new','new'],[]])assert.throws(()=>planCtw(s,{...cp,new_canonical_scope:{...cp.new_canonical_scope,ids}}));
  assert.throws(()=>planCtw(s,{...cp,sources:f.checkpoint(s).sources}));
});
test('API-only capture matches canonical SQL snapshot, reads no student/assets, and rejects moving multi-page observations',async()=>{
  const s=f.snapshot(1),tables={
    reading_logical_items:s.canonical.map(c=>({logical_item_id:c.sourceItemId,module:'ctw'})),
    reading_questions:s.canonical.map(c=>({logical_item_id:c.sourceItemId,question_id:c.sourceItemId,module:'ctw'})),
    reading_ctw_paragraphs:s.canonical.flatMap(c=>c.paragraphs.map(p=>({question_id:c.sourceItemId,paragraph_id:p.paragraphId,paragraph_order:p.paragraphOrder}))),
    reading_ctw_segments:s.canonical.flatMap(c=>c.segments.map(t=>({question_id:c.sourceItemId,paragraph_id:t.paragraphId,segment_order:t.segmentOrder,segment_type:t.segmentType,text_content:t.textContent,slot_id:t.slotId}))),
    reading_ctw_slots:s.canonical.flatMap(c=>c.slots.map(t=>({question_id:c.sourceItemId,paragraph_id:t.paragraphId,slot_id:t.slotId,answer:t.answer}))),
    ctw_vocabulary_entries:s.entries,ctw_vocabulary_cefr_memberships:s.memberships};
  let moving=false,entryReads=0;
  const db={from(table){assert.ok(Object.hasOwn(tables,table));let start=0,end=999;const q={select(){return q;},range(a,b){start=a;end=b;return q;},eq(){return q;},order(){return q;},then(resolve){
    const data=structuredClone(tables[table].slice(start,end+1));if(table==='ctw_vocabulary_entries'&&++entryReads%2===0&&moving)data[0].cefr='A2';return Promise.resolve({data,error:null}).then(resolve);
  }};return q;}};
  assert.deepEqual(await readCtwSnapshotViaApi(db),s);moving=true;await assert.rejects(readCtwSnapshotViaApi(db),/drift across API/);
});

test('only new canonical correct-answer anchors; REUSE/ordinary text excluded, duplicate answers share one base',()=>{
  const s=f.snapshot(),p=planCtw(s,f.checkpoint(s));
  assert.deepEqual(p.new_canonical,['new']);assert.deepEqual(p.unchanged,['historical']);
  assert.equal(p.candidates.length,4);assert.ok(p.candidates.every(c=>c.normalized_answer!=='ordinaryword'));
  const r=f.review(p),pub=prepareCtw(p,r);
  assert.equal(pub.reuse.length,1);assert.equal(pub.senses.length,1);assert.equal(pub.new_entries.length,1);
  assert.equal(pub.new_entries[0].list_position,50);assert.equal(pub.memberships[0].cefr_group,'B2');
  assert.deepEqual(s,p.snapshot);assert.equal(pub.senses[0].entry_id,s.entries[0].entry_id);
  assert.deepEqual(prepareCtw(p,r),pub);
});
test('context review must be complete, hash-bound, in scope and not overwrite existing senses/CEFR',()=>{
  const s=f.snapshot(),p=planCtw(s,f.checkpoint(s)),r=f.review(p);
  const fails=mutate=>{const copy=structuredClone(r);mutate(copy);assert.throws(()=>prepareCtw(p,copy));};
  fails(x=>x.decisions.pop());fails(x=>x.decisions.push(x.decisions[0]));fails(x=>x.decisions[0].candidate_id='extra');
  fails(x=>x.plan_sha256='0'.repeat(64));fails(x=>x.reviewer='');fails(x=>x.decisions[0].reason='');
  fails(x=>x.decisions[1].sense=s.entries[0].senses[0]);fails(x=>x.new_words[0].cefr_review.reference='legacy-A2');
  fails(x=>x.new_words[0].cefr_review.pos_sense_rationale='');fails(x=>x.new_words[0].forms_review='');
  fails(x=>x.new_words.push(f.word('unrelated')));fails(x=>x.new_words[0].senses.push(f.sense('verb','无答案来源')));
  fails(x=>x.new_words[0].irregular_forms=[{form_type:'past',answers:['novelworded']}]);
  const repeated=structuredClone(p);repeated.snapshot.canonical[1].slots[0].answer='drift';assert.throws(()=>prepareCtw(repeated,r));
});
test('base candidates use existing inflections as suggestions, all ambiguous senses still require review',()=>{
  const s=f.snapshot();s.entries[0].word='carry';s.entries[0].normalized_word='carry';s.entries[0].senses=[f.sense('verb')];
  s.canonical[1]=f.canonical('new',['carried','CARRY','carrying']);
  const p=planCtw(s,f.checkpoint(s));assert.ok(p.candidates.every(c=>c.base_candidates.includes('carry')));
  assert.throws(()=>prepareCtw(p,{...f.review(p),decisions:[]}));
  s.canonical[1]=f.canonical('new',['running','studied']);const unseen=planCtw(s,f.checkpoint(s));
  assert.ok(unseen.candidates[0].base_candidates.includes('run'));assert.ok(unseen.candidates[1].base_candidates.includes('study'));
});
test('canonical duplicate topology, changed history and stale layout fail closed, removed items never delete words',()=>{
  const s=f.snapshot(),cp=f.checkpoint(s);
  const duplicate=structuredClone(s);duplicate.canonical.push(duplicate.canonical[0]);assert.throws(()=>planCtw(duplicate,cp),/Duplicate canonical/);
  const bad=structuredClone(s);bad.canonical[1].slots.push({...bad.canonical[1].slots[0],slotId:'unplaced'});assert.throws(()=>planCtw(bad,cp),/Unplaced/);
  const changed=structuredClone(s);changed.canonical[0].slots[0].answer='changed';const p=planCtw(changed,cp);
  assert.deepEqual(p.changed,['historical']);assert.throws(()=>prepareCtw(p,f.review(p)),/Previously synced/);
  const gap=structuredClone(s);gap.entries[1].list_position=4;assert.throws(()=>planCtw(gap,cp),/layout/);
  const removed=structuredClone(s);removed.canonical.shift();const rp=planCtw(removed,cp);assert.deepEqual(rp.removed,['historical']);
  assert.equal(prepareCtw(rp,f.review(rp)).plan.snapshot.entries.length,s.entries.length);
});
test('all CEFR levels append within their own tail; C1/C2 share a group; mixed rollover preserves every old member',()=>{
  const s=f.snapshot(49),names=['newa','newb','newc','newd','newe','newf'],levels=['A1','A2','B1','B2','C1','C2'];
  s.canonical[1]=f.canonical('new',names);
  const p=planCtw(s,f.checkpoint(s)),r={version:'ctw-incremental-review-v1',plan_sha256:digest(p),reviewer:'synthetic',
    decisions:p.candidates.map((c,i)=>({candidate_id:c.id,base_form:names[i],action:'new',sense_index:0,reason:'Synthetic'})),
    new_words:names.map((n,i)=>f.word(n,levels[i]))};
  const pub=prepareCtw(p,r);
  assert.deepEqual(pub.new_entries.map(e=>[e.list_number,e.list_position]),[[1,50],[2,1],[2,2],[2,3],[2,4],[2,5]]);
  assert.deepEqual(pub.memberships.map(m=>[m.cefr_group,m.list_number,m.list_position]),[['A1',1,50],['A2',1,1],['B1',1,1],['B2',1,1],['C1-C2',1,1],['C1-C2',1,2]]);
});
test('same base supports multiple POS/senses; duplicate new sense contexts append only once',()=>{
  const s=f.snapshot();s.canonical[1]=f.canonical('new',['bank','bank','novelword','novelword']);
  const p=planCtw(s,f.checkpoint(s)),r=f.review(p);
  r.decisions[0]={...r.decisions[1],candidate_id:p.candidates[0].id};
  r.new_words[0].senses.push(f.sense('verb','另一词性'));
  r.decisions[3].sense_index=1;
  const pub=prepareCtw(p,r);assert.equal(pub.senses[0].senses.length,1);assert.equal(pub.new_entries[0].senses.length,2);
  r.new_words[0].word='Novelword';const proper=prepareCtw(p,r);
  assert.equal(proper.new_entries[0].word,'Novelword');assert.equal(proper.new_entries[0].normalized_word,'novelword');
  assert.equal(proper.new_entries[0].entry_id,pub.new_entries[0].entry_id);
});

const pair=(form_type,answers)=>({form_type,answers});
const forms={
  be:[pair('present_first_person_singular',['am']),pair('present_third_person_singular',['is']),pair('present_second_person_or_plural',['are']),
    pair('past_first_or_third_person_singular',['was']),pair('past_second_person_or_plural',['were']),pair('past_participle',['been'])],
  get:[pair('past',['got']),pair('past_participle',['got','gotten'])],far:[pair('comparative',['farther','further']),pair('superlative',['farthest','furthest'])],
  burn:[pair('past',['burnt','burned']),pair('past_participle',['burnt','burned'])],learn:[pair('past',['learnt','learned']),pair('past_participle',['learnt','learned'])]
};
test('Phase3 exact form policy + shared study/test/server snapshot + required-all/permutation and prompt leak protection',()=>{
  for(const[word,irregular_forms]of Object.entries(forms)){
    validateIncrementalForms(word,irregular_forms);assert.throws(()=>validateIncrementalForms(word,[]));
    const entry={...f.snapshot(1).entries[0],word,irregular_forms,senses:[f.sense('verb',`合成（${word.toUpperCase()}）`)]};
    const card=reviewRuntime.ctwReviewCard(entry,0),round=reviewRuntime.createCtwReviewRound(randomUUID(),{kind:'list',listNumber:1},[entry]);
    assert.deepEqual(card.spellingGroups,round.cards[0].spellingGroups);assert.ok(!card.prompt.includes(word.toUpperCase()));
    assert.ok(card.studySenses[0].meaning.includes(word.toUpperCase()));
    const answer={spellings:Object.fromEntries(card.spellingGroups.map(g=>[g.id,g.accepted.join(' / ')]))};
    assert.equal(local.gradeReview(card,answer).correct,true);
    for(const group of card.spellingGroups.filter(g=>g.requiredAll&&g.accepted.length>1)){
      const bad=structuredClone(answer);bad.spellings[group.id]=group.accepted[0];assert.equal(local.gradeReview(card,bad).correct,false);
      if(group.accepted.every(a=>a.length===group.accepted[0].length)){
        bad.spellings[group.id]=[...group.accepted].reverse().join(' / ');assert.equal(local.gradeReview(card,bad).correct,true);
        bad.spellings[group.id]=group.accepted.map(()=>group.accepted[0]).join(' / ');assert.equal(local.gradeReview(card,bad).correct,false);
      }
    }
  }
  const be=reviewRuntime.ctwSpellingGroups({...f.snapshot(1).entries[0],word:'be',irregular_forms:forms.be});
  assert.deepEqual(be.slice(1).map(g=>g.accepted),[['am','is','are'],['was','were'],['been']]);
});

test('actual PostgreSQL transaction: append senses only, trigger allocation/preview, byte-stable history/sessions/best and zero-write rerun',async()=>{
  const s=f.snapshot(),db=await f.database(s);
  try{
    const c=f.client(db,'authenticated',f.U),svc=f.client(db,'service_role',f.U);
    const before=await f.capture(db),p=planCtw(before,f.checkpoint(s)),pub=prepareCtw(p,f.review(p));
    await store.saveVocabularyAttempt(svc,f.U,{attemptId:randomUUID(),mode:'base_form',answers:[{entryId:s.entries[0].entry_id,spelling:'bank'}]});
    // Snapshot session is created before the vocabulary grows/gets another sense.
    const round=await server.createCtwReview(c,svc,f.U,{requestId:randomUUID(),source:{kind:'list',listNumber:1}});
    const ids=before.entries.map(e=>e.entry_id).sort();
    await db.query("update student_ctw_vocabulary_list_progress set best_accuracy=100,completed_entry_ids=$1::uuid[]",[ids]);
    const personal=async()=>({progress:(await db.query('select * from student_ctw_vocabulary_list_progress')).rows,
      sessions:(await db.query('select * from student_ctw_vocabulary_review_sessions')).rows,
      attempts:(await db.query('select * from student_ctw_vocabulary_attempts')).rows});
    const history=await personal(),entriesBefore=(await db.query('select * from ctw_vocabulary_entries order by entry_id')).rows;
    assert.equal(verifyCtw(pub,before).state,'fresh');assert.throws(()=>verifyCtw(pub,before,true));
    await db.exec(`create table mutations(op text);create function audit_ctw() returns trigger language plpgsql as $$begin insert into public.mutations values(TG_OP);return new;end$$;
      create trigger audit_ctw after insert or update or delete on ctw_vocabulary_entries for each row execute function audit_ctw();
      create trigger audit_membership after insert or update or delete on ctw_vocabulary_cefr_memberships for each row execute function audit_ctw();`);
    const sql=buildCtwDeltaSql(pub);await db.exec(sql);
    const after=await f.capture(db);assert.equal(verifyCtw(pub,after,true).state,'applied');
    assert.deepEqual(await personal(),history);
    const cards=await store.readVocabularyLists(c,'mixed');assert.equal(cards.lists[0].status,'in_progress');assert.equal(cards.lists[0].bestAccuracy,100);
    assert.deepEqual(await server.readCtwReview(c,f.U,round.session.session_id),round);
    for(const old of entriesBefore){const now=(await db.query('select * from ctw_vocabulary_entries where entry_id=$1',[old.entry_id])).rows[0];
      assert.deepEqual({...now,senses:old.senses},old);if(old.word!=='bank')assert.deepEqual(now,old);}
    assert.equal(after.entries.find(e=>e.word==='bank').senses.length,2);
    const mutations=(await db.query('select * from mutations')).rows;assert.equal(mutations.length,3);
    await db.exec(sql);assert.deepEqual((await db.query('select * from mutations')).rows,mutations);
    assert.deepEqual(await f.capture(db),after);
    assert.equal(planCtw(after,pub.next_checkpoint).candidates.length,0);
  }finally{await db.close();}
});
test('actual PostgreSQL: new reviewed irregular entries import unchanged and create required-all study/test snapshots',async()=>{
  const s=f.snapshot(1),words=Object.keys(forms),answers=['were','gotten','farther','burnt','learnt'];
  s.canonical[1]=f.canonical('new',answers);const db=await f.database(s);
  try{
    const p=planCtw(await f.capture(db),f.checkpoint(s)),r={version:'ctw-incremental-review-v1',plan_sha256:digest(p),reviewer:'synthetic',
      decisions:p.candidates.map((c,i)=>({candidate_id:c.id,base_form:words[i],action:'new',sense_index:0,reason:'Synthetic reviewed irregular base/POS in context'})),
      new_words:words.map(w=>({...f.word(w,'B1',[f.sense(w==='far'?'adverb':'verb')]),irregular_forms:forms[w]}))};
    const pub=prepareCtw(p,r);await db.exec(buildCtwDeltaSql(pub));
    assert.equal(verifyCtw(pub,await f.capture(db),true).state,'applied');
    const round=await server.createCtwReview(f.client(db,'authenticated',f.U),f.client(db,'service_role',f.U),f.U,
      {requestId:randomUUID(),source:{kind:'cefr_list',group:'B1',listNumber:1}});
    for(const card of round.cards){const entry=pub.new_entries.find(e=>e.entry_id===card.itemId);
      assert.deepEqual(card.spellingGroups,reviewRuntime.ctwSpellingGroups(entry));
      const correct={spellings:Object.fromEntries(card.spellingGroups.map(g=>[g.id,g.accepted.join(' / ')]))};
      assert.equal(local.gradeReview(card,correct).correct,true);
      if(entry.word==='get'){correct.spellings.past_participle='got';assert.equal(local.gradeReview(card,correct).correct,false);}
    }
  }finally{await db.close();}
});
test('actual PostgreSQL: both mixed and shared C1/C2 tails roll over exactly at 50 without relocating old members',async()=>{
  const s=f.snapshot(49);for(const e of s.entries)e.cefr='C1';for(const m of s.memberships)m.cefr_group='C1-C2';
  s.canonical[1]=f.canonical('new',['newa','newb','newc']);const db=await f.database(s);
  try{
    const before=await f.capture(db),p=planCtw(before,f.checkpoint(s)),r={version:'ctw-incremental-review-v1',plan_sha256:digest(p),reviewer:'synthetic',
      decisions:p.candidates.map(c=>({candidate_id:c.id,base_form:c.normalized_answer,action:'new',sense_index:0,reason:'Synthetic'})),
      new_words:['newa','newb','newc'].map((w,i)=>f.word(w,i%2?'C1':'C2'))};
    const pub=prepareCtw(p,r);await db.exec(buildCtwDeltaSql(pub));
    const after=await f.capture(db);assert.equal(verifyCtw(pub,after,true).state,'applied');
    assert.deepEqual(pub.new_entries.map(e=>[e.list_number,e.list_position]),[[1,50],[2,1],[2,2]]);
    assert.deepEqual(pub.memberships.map(e=>[e.list_number,e.list_position]),[[1,50],[2,1],[2,2]]);
    for(const old of before.memberships)assert.deepEqual(after.memberships.find(e=>e.entry_id===old.entry_id),old);
  }finally{await db.close();}
});
test('actual PostgreSQL: baseline/manual edits, canonical drift, missing trigger and late failures all roll back; retry succeeds',async()=>{
  const s=f.snapshot(),db=await f.database(s);
  try{
    const before=await f.capture(db),p=planCtw(before,f.checkpoint(s)),pub=prepareCtw(p,f.review(p)),sql=buildCtwDeltaSql(pub);
    await db.exec("update ctw_vocabulary_entries set cefr='A2' where word='bank'");
    await assert.rejects(db.exec(sql),/BASELINE_DRIFT/);await db.exec('rollback');
    await db.exec("update ctw_vocabulary_entries set cefr='A1' where word='bank'");
    await db.exec("update reading_ctw_slots set answer='drift' where question_id='new' and slot_id='s0'");
    await assert.rejects(db.exec(sql),/CANONICAL_DRIFT/);await db.exec('rollback');
    await db.exec("update reading_ctw_slots set answer='bank' where question_id='new' and slot_id='s0'");
    await db.exec('alter table ctw_vocabulary_entries disable trigger ctw_vocabulary_append_cefr');
    await assert.rejects(db.exec(sql),/APPEND_TRIGGER_REQUIRED/);await db.exec('rollback');
    await db.exec('alter table ctw_vocabulary_entries enable trigger ctw_vocabulary_append_cefr');
    await db.exec(`create function fail_new() returns trigger language plpgsql as $$begin raise exception 'synthetic late failure';end$$;
      create trigger fail_new before insert on ctw_vocabulary_entries for each row execute function fail_new();`);
    await assert.rejects(db.exec(sql),/synthetic late failure/);await db.exec('rollback');assert.deepEqual(await f.capture(db),before);
    await db.exec('drop trigger fail_new on ctw_vocabulary_entries');await db.exec(sql);assert.equal(verifyCtw(pub,await f.capture(db),true).state,'applied');
    await db.exec("update ctw_vocabulary_entries set senses='[{\"pos\":\"noun\",\"meaning_zh\":\"manual\",\"example_en\":\"Manual.\"}]' where word='bank'");
    await assert.rejects(db.exec(sql),/BASELINE_DRIFT/);await db.exec('rollback');
  }finally{await db.close();}
});
test('SQL literals cannot escape the DO delimiter; damaged membership/post-verify aborts atomically',async()=>{
  const s=f.snapshot(),db=await f.database(s);
  try{
    const p=planCtw(await f.capture(db),f.checkpoint(s)),r=f.review(p);r.decisions[1].sense.example_en="Quote ' and $ctw_delta$ and \\ remain literal.";
    const pub=prepareCtw(p,r),sql=buildCtwDeltaSql(pub);assert.ok(sql.includes('do $ctw_delta_x$'));
    await db.exec(`create function break_membership() returns trigger language plpgsql as $$begin new.list_position:=49;return new;end$$;
      create trigger break_membership before insert on ctw_vocabulary_cefr_memberships for each row execute function break_membership();`);
    await assert.rejects(db.exec(sql),/POST_VERIFY_FAILED/);await db.exec('rollback');
    assert.equal((await f.capture(db)).entries.find(e=>e.word==='bank').senses.length,1);
    await db.exec('drop trigger break_membership on ctw_vocabulary_cefr_memberships');await db.exec(sql);
    assert.equal(verifyCtw(pub,await f.capture(db),true).state,'applied');
  }finally{await db.close();}
});
