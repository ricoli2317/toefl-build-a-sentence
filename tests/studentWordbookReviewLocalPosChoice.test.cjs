const test=require('node:test'),assert=require('node:assert/strict');
const h=require('./helpers/wordbookLocalPosChoiceFixture.cjs');
const engine=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const rows=async(db,sql,p=[])=>(await db.query(sql,p)).rows;
async function saveNouns(db,source='ctw'){for(const [expression,meaning] of [['ocean','海洋'],['forest','森林'],['music','音乐']])
  await h.save(db,{expression,meaning,pos:'noun',source});}
const candidate=async(db,sources=['rap'],domain='reading',user=h.U)=>rows(db,
  'select * from wordbook_review_candidates($1,$2,$3,null,null)',[user,domain,sources]);

engine('enough current-student/current-domain words: no global read, all sources/date ranges eligible as distractors, local wins',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'system',meaning:'系统',pos:'noun',source:'rap'});await saveNouns(db);
  await h.pool(db);await h.install(db);
  await db.exec('revoke select on lexical_occurrences from service_role; set role service_role');
  assert.equal((await h.availability(db,h.settings(['rap']))).meaningChoice,1);
  assert.equal((await h.availability(db,h.settings(['ctw']))).spellingPos,3);
  const c=(await candidate(db))[0];assert.equal(c.reason,null);assert.equal(c.snapshot.pos,'noun');
  assert.ok(c.snapshot.distractors.every(d=>d.wordbookEntryId&&!d.lexicalEntryId));
  assert.deepEqual(c.snapshot.distractors.map(d=>d.text).sort(),['海洋','森林','音乐'].sort());
  const s=await h.create(db,h.settings(['rap']));assert.equal(s.item.options.length,4);
  assert.equal((await h.submit(db,s.session.session_id,s.item.itemId,{optionId:s.item.options.find(o=>o.text==='系统').id})).summary.choiceCorrect,1);
  await db.exec('reset role');
 }finally{await db.close();}
});

engine('insufficient local uses global supplementation, other student/domain/wrong or unknown POS never supplies options',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'class',meaning:'班级',pos:'proper noun',source:'bas'});
  await h.save(db,{expression:'class',meaning:'课程',pos:'noun',source:'write_email'});
  await h.save(db,{expression:'music',meaning:'音乐',pos:'noun',source:'write_email'});
  await h.save(db,{expression:'otherdomain',meaning:'A读义',pos:'noun',source:'rap'});
  await h.save(db,{expression:'otherstudent',meaning:'A他义',pos:'noun',source:'bas',user:h.V});
  await h.save(db,{expression:'adjective',meaning:'A迅速',pos:'adjective',source:'bas'});
  await h.save(db,{expression:'unknown',meaning:'A未知',pos:'unclassified',source:'bas'});
  for(const p of [{expression:'g-ocean',meaning:'海洋',pos:'noun'}, {expression:'g-forest',meaning:'森林',pos:'proper noun'},
    {expression:'g-bad',meaning:'A错误',pos:'unclassified'}, {expression:'g-adj',meaning:'A敏捷',pos:'adj.'},
    {expression:'g-pending',meaning:'A火山',pos:'noun',status:'needs_review'},
    {expression:'g-disabled',meaning:'A岩石',pos:'noun',entryStatus:'disabled'}])await h.occurrence(db,p);
  await h.install(db);const c=(await candidate(db,['bas'],'writing')).find(c=>c.snapshot?.expression==='class');
  assert.equal(c.reason,null);assert.equal(c.snapshot.meaning,'班级');assert.equal(c.snapshot.pos,'noun');
  assert.deepEqual(c.snapshot.distractors.map(d=>d.text),['音乐','森林','海洋']);
  assert.ok(c.snapshot.distractors[0].wordbookEntryId);assert.ok(c.snapshot.distractors.slice(1).every(d=>d.lexicalEntryId));
  // Unknown target POS is fail-closed, not a cross-POS answer.
  assert.equal((await candidate(db,['bas'],'writing')).find(c=>c.reason==='missing_reliable_pos').reason,'missing_reliable_pos');
  const s=await h.create(db,h.settings(['bas'],'writing',1));
  const expected=(await rows(db,'select snapshot from student_wordbook_review_items where item_id=$1',[s.item.itemId]))[0].snapshot.meaning;
  assert.equal((await h.submit(db,s.session.session_id,s.item.itemId,{optionId:s.item.options.find(o=>o.text!==expected).id})).summary.choiceCorrect,0);
 }finally{await db.close();}
});

engine('POS7 mappings: modal/auxiliary/phrasal verbs compatible; determiner/ambiguous POS excluded; shared character alone allowed',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'increase',meaning:'提高',pos:'modal verb',source:'rap'});
  for(const [expression,meaning,pos] of [['run','运行','phrasal verb'],['keep','保留','auxiliary'],['find','发现','verb'],
    ['noun','A名义','noun'],['det','A冠义','determiner'],['ambiguous','A双义','noun/verb'],['synonym','提升','verb']])
    await h.save(db,{expression,meaning,pos});
  await h.install(db);await db.exec('revoke select on lexical_occurrences from service_role; set role service_role');
  const c=(await candidate(db))[0];assert.equal(c.snapshot.pos,'verb');
  assert.deepEqual(new Set(c.snapshot.distractors.map(d=>d.text)),new Set(['运行','保留','发现']));
  const conflicts=await rows(db,"select wordbook_review_meaning_conflict('海洋','海岸') shared, wordbook_review_meaning_conflict('提高','提升') synonyms, wordbook_review_meaning_conflict('允许','不允许') negation,wordbook_review_meaning_conflict('系统',' 系统。') duplicate");
  assert.deepEqual(conflicts[0],{shared:false,synonyms:true,negation:true,duplicate:true});
  await db.exec('reset role');
 }finally{await db.close();}
});

engine('bounded global pool does not continue scanning for missing options; duplicate canonical spans dedup; greedy still fails closed',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'system',meaning:'系统',pos:'noun',source:'rap'});
  await db.exec(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type)
    select md5('cap:'||g)::uuid,'cap'||g,'cap'||g,'word' from generate_series(1,140) g;
    insert into lexical_occurrences(occurrence_id,entry_id,content_block_id,context_text,context_meaning_zh,context_pos)
    select gen_random_uuid(),md5('cap:'||g)::uuid,g::text,'Local bounded fixture.','A标签','noun' from generate_series(1,140) g;`);
  await h.pool(db);await h.install(db);
  assert.equal((await h.availability(db,h.settings(['rap']))).reasons.insufficient_distractors,1);
  // In a later call, new in-bound meanings are picked up; no persistent cache.
  await h.occurrence(db,{expression:'b','meaning':'0地点',pos:'noun'});
  await h.occurrence(db,{expression:'c','meaning':'0人群',pos:'noun'});
  assert.equal((await h.availability(db,h.settings(['rap']))).total,1);
 }finally{await db.close();}
});

engine('same expression/variants and all target saved meanings excluded; duplicate spans and cross-entry same meanings do not duplicate options',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'class',meaning:'班级',pos:'noun',source:'bas'});
  await h.save(db,{expression:'class',meaning:'课程',pos:'noun',source:'write_email'});
  await h.save(db,{expression:'class',meaning:'A异义',pos:'noun',source:'bas',variant:'other'});
  await h.save(db,{expression:'course',meaning:'课程',pos:'noun',source:'write_email'});
  await h.save(db,{expression:'music',meaning:'音乐',pos:'noun',source:'write_email'});
  await h.save(db,{expression:'another-music',meaning:' 音乐 ',pos:'noun',source:'write_email'});
  for(let n=0;n<12;n++)await h.occurrence(db,{expression:'global-ocean',meaning:n%2?' 海洋 ':'海洋',pos:'noun'});
  await h.occurrence(db,{expression:'global-forest',meaning:'森林',pos:'noun'});
  await h.occurrence(db,{expression:'global-class',meaning:'课程',pos:'noun'});
  await h.install(db);const c=(await candidate(db,['bas'],'writing')).find(c=>c.snapshot?.meaning==='班级');
  assert.ok(c);assert.deepEqual(c.snapshot.distractors.map(d=>d.text),['音乐','森林','海洋']);
  const s=await h.create(db,h.settings(['bas'],'writing',1));assert.equal(new Set(s.item.options.map(o=>o.text)).size,4);
 }finally{await db.close();}
});

engine('multi-question session stores all options at create; read/switch/grade never runs candidates or reads corpus again',async()=>{
 const db=await h.fixture();try{
  for(const [expression,meaning] of [['system','系统'],['ocean','海洋'],['forest','森林'],['music','音乐']])
    await h.save(db,{expression,meaning,pos:'noun',source:'rap'});
  await h.install(db);await db.exec('revoke select on lexical_occurrences from service_role; set role service_role');
  const created=await h.create(db,h.settings(['rap'],'reading',4));assert.equal(created.session.total,4);
  await db.exec('reset role');
  const fixed=await rows(db,'select item_id,position,snapshot from student_wordbook_review_items where session_id=$1 order by position',[created.session.session_id]);
  assert.equal(fixed.length,4);for(const i of fixed){assert.equal(i.snapshot.options.length,4);assert.ok(i.snapshot.correctOptionId);}
  // Poison pool engine & remove all corpus permissions after creation. Existing
  // options/answers MUST remain usable, including future positions and resume.
  await db.exec("revoke execute on function wordbook_review_candidates(uuid,text,text[],timestamptz,timestamptz) from service_role; revoke select on lexical_entries,lexical_occurrences,lexical_source_blocks from service_role; set role service_role");
  for(const i of fixed){const read=await h.get(db,created.session.session_id,h.U,i.position);
    assert.deepEqual(read.item.options,i.snapshot.options.map(o=>({id:o.id,text:o.text})));
    assert.equal(read.item.answer,undefined);
    await h.submit(db,created.session.session_id,i.item_id,{optionId:i.snapshot.correctOptionId});}
  assert.equal((await h.get(db,created.session.session_id)).summary.choiceCorrect,4);
  await db.exec('reset role');
  assert.deepEqual(await rows(db,'select item_id,position,snapshot from student_wordbook_review_items where session_id=$1 order by position',[created.session.session_id]),fixed);
 }finally{await db.close();}
});

engine('minimal patch preserves historical items/source evidence/all other RPCs/ACL; missing index and drift rollback',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'system',meaning:'系统',pos:'noun'});const old=await h.create(db);
  const tables=['student_wordbook_entries','student_wordbook_senses','student_wordbook_source_evidence','student_wordbook_review_items','student_wordbook_review_sessions'];
  const capture=async()=>{const o={};for(const t of tables)o[t]=await rows(db,`select to_jsonb(t) v from ${t} t order by to_jsonb(t)::text`);return o;};
  const before=await capture();const others=await rows(db,"select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname not in ('wordbook_review_candidates','wordbook_review_meaning_conflict') order by oid");
  const changedMeta=await rows(db,"select oid,proowner,proacl,provolatile,prorettype,proretset from pg_proc where proname in ('wordbook_review_candidates','wordbook_review_meaning_conflict') order by oid");
  await assert.rejects(db.exec(h.read(h.files.migration)),/VALID_INDEX_REQUIRED/);await db.exec('rollback');
  await db.exec(h.read(h.files.index).replace('index concurrently','index'));
  const bodies=await rows(db,"select prosrc from pg_proc where proname in ('wordbook_review_candidates','wordbook_review_meaning_conflict') order by oid");
  await assert.rejects(db.exec(h.read(h.files.migration).replace('  update public.student_wordbook_review_installation','  perform 1/0;\n  update public.student_wordbook_review_installation')),/division by zero/);
  await db.exec('rollback');
  assert.deepEqual(await rows(db,"select prosrc from pg_proc where proname in ('wordbook_review_candidates','wordbook_review_meaning_conflict') order by oid"),bodies);
  await db.exec(h.read(h.files.migration));await db.exec(h.read(h.files.verify));assert.deepEqual(await capture(),before);
  assert.deepEqual(await rows(db,"select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname not in ('wordbook_review_candidates','wordbook_review_meaning_conflict') order by oid"),others);
  assert.deepEqual(await rows(db,"select oid,proowner,proacl,provolatile,prorettype,proretset from pg_proc where proname in ('wordbook_review_candidates','wordbook_review_meaning_conflict') order by oid"),changedMeta);
  assert.equal((await h.get(db,old.session.session_id)).item.prompt,'系统');
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(h.availability(db),/permission denied/);await db.exec('reset role');}
  await assert.rejects(db.exec(h.read(h.files.migration)),/BASELINE_DRIFT/);await db.exec('rollback');
 }finally{await db.close();}
});
