const test=require('node:test'),assert=require('node:assert/strict');
const h=require('./helpers/wordbookFixedPoolFixture.cjs');
const engine=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const rows=async(db,sql,p=[])=>(await db.query(sql,p)).rows;
const cands=(db,sources=['rap'],domain='reading',user=h.U)=>rows(db,'select * from wordbook_review_candidates($1,$2,$3,null,null)',[user,domain,sources]);

engine('current student/domain local words win; enough local does not read fixed table or occurrence corpus; sources/answer/POS7 unchanged',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'system',meaning:'系统',pos:'noun',source:'rap'});
  for(const [expression,meaning] of [['ocean','海洋'],['forest','森林'],['music','音乐']])await h.save(db,{expression,meaning,pos:'noun'});
  await h.pool(db);await db.exec('revoke select on lexical_occurrences,wordbook_review_fixed_distractors from service_role; set role service_role');
  assert.equal((await h.availability(db,h.settings(['rap']))).meaningChoice,1);
  assert.equal((await h.availability(db,h.settings(['ctw']))).spellingPos,3);
  const c=(await cands(db))[0];assert.ok(c.snapshot.distractors.every(d=>d.wordbookEntryId&&!d.fixedPoolId));
  const s=await h.create(db,h.settings(['rap']));assert.equal(s.item.options.length,4);
  assert.equal((await h.submit(db,s.session.session_id,s.item.itemId,{optionId:s.item.options.find(o=>o.text==='系统').id})).summary.choiceCorrect,1);
  await db.exec('reset role');
 }finally{await db.close();}
});

engine('local first then approved fixed pool by POS7; no global occurrence query even when its permission is revoked',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'class',meaning:'班级',pos:'proper noun',source:'bas'});
  await h.save(db,{expression:'class',meaning:'课程',pos:'noun',source:'write_email'});
  await h.save(db,{expression:'music',meaning:'音乐',pos:'noun',source:'write_email'});
  await h.save(db,{expression:'other-domain',meaning:'读取',pos:'noun',source:'rap'});
  await h.save(db,{expression:'other-student',meaning:'隐私',pos:'noun',source:'bas',user:h.V});
  await h.add(db,{english:'ocean',meaning:'海洋'});await h.add(db,{english:'forest',meaning:'森林'});
  await h.add(db,{english:'pending',meaning:'岩石',approved:false});await h.add(db,{english:'wrongpos',meaning:'行动',pos:'verb'});
  await db.exec('revoke select on lexical_occurrences from service_role; set role service_role');
  const c=(await cands(db,['bas'],'writing')).find(c=>c.snapshot?.expression==='class');
  assert.equal(c.snapshot.meaning,'班级');assert.equal(c.snapshot.pos,'noun');
  assert.deepEqual(c.snapshot.distractors.map(d=>d.text),['音乐','森林','海洋']);assert.ok(c.snapshot.distractors[0].wordbookEntryId);
  assert.ok(c.snapshot.distractors.slice(1).every(d=>d.fixedPoolId&&d.lexicalEntryId));
  assert.equal((await h.availability(db,h.settings(['bas'],'writing'))).meaningChoice,1);
  await db.exec('reset role');
 }finally{await db.close();}
});

engine('POS matching, ASCII, synonyms, duplicates, target variants/other saved answers stay excluded; insufficient approved pool fails closed',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'use',meaning:'使用',pos:'modal',source:'rap'});
  await h.save(db,{expression:'use',meaning:'采用',pos:'verb',source:'ctw'});
  await h.save(db,{expression:'use',meaning:'行动',pos:'verb',source:'ctw',variant:'other'});
  await h.save(db,{expression:'unknown',meaning:'未知',pos:'unclassified',source:'rap'});
  await h.save(db,{expression:'mixed',meaning:'CMS机构',pos:'verb'});
  for(const p of [{english:'utilize',meaning:'利用',pos:'verb'}, {english:'apply',meaning:'应用',pos:'verb'},
    {english:'ocean',meaning:'海洋',pos:'noun'}, {english:'act',meaning:'行动',pos:'verb',approved:false}])await h.add(db,p);
  let a=await h.availability(db,h.settings(['rap']));assert.equal(a.total,0);assert.equal(a.reasons.insufficient_distractors,1);assert.equal(a.reasons.missing_reliable_pos,1);
  await h.add(db,{english:'find',meaning:'发现',pos:'verb'});await h.add(db,{english:'run',meaning:'运行',pos:'verb'});await h.add(db,{english:'repair',meaning:'修理',pos:'verb'});
  const c=(await cands(db)).find(c=>c.snapshot?.expression==='use');assert.ok(c);assert.equal(c.snapshot.pos,'verb');
  assert.deepEqual(new Set(c.snapshot.distractors.map(d=>d.text)),new Set(['发现','运行','修理']));
  await assert.rejects(h.add(db,{english:'anotherfind',meaning:'发现',pos:'verb'}),/duplicate key/);
  await assert.rejects(h.add(db,{english:'ascii',meaning:'CMS机构'}),/check constraint/);
 }finally{await db.close();}
});

engine('one-call reuse spreads nine fixed meanings across three same-POS questions; smaller pools permit repeat rather than false unavailability',async()=>{
 const db=await h.fixture();try{
  for(const expression of ['systemone','systemtwo','systemthree'])await h.save(db,{expression,meaning:'系统',pos:'noun',source:'rap'});
  await h.pool(db);let c=await cands(db);assert.equal(c.length,3);
  assert.equal(new Set(c.flatMap(c=>c.snapshot.distractors.map(d=>d.text))).size,9);
  await db.exec("update wordbook_review_fixed_distractors set approved=false where meaning not in('海洋','森林','音乐')");
  c=await cands(db);assert.ok(c.every(c=>c.reason===null));assert.equal(new Set(c.flatMap(c=>c.snapshot.distractors.map(d=>d.text))).size,3);
  const s=await h.create(db,h.settings(['rap'],'reading',3));assert.equal(s.session.total,3);
 }finally{await db.close();}
});

engine('all session options stored at create; switch/resume/grade/retry never reads fixed table, occurrence or candidates again',async()=>{
 const db=await h.fixture();try{
  for(const expression of ['systemone','systemtwo','systemthree'])await h.save(db,{expression,meaning:'系统',pos:'noun',source:'rap'});
  await h.pool(db);const s=await h.create(db,h.settings(['rap'],'reading',3));
  const fixed=await rows(db,'select item_id,position,snapshot from student_wordbook_review_items where session_id=$1 order by position',[s.session.session_id]);assert.equal(fixed.length,3);
  await db.exec('revoke select on lexical_entries,lexical_occurrences,lexical_source_blocks,wordbook_review_fixed_distractors from service_role; revoke execute on function wordbook_review_candidates(uuid,text,text[],timestamptz,timestamptz) from service_role; set role service_role');
  for(const i of fixed){const r=await h.get(db,s.session.session_id,h.U,i.position);assert.deepEqual(r.item.options,i.snapshot.options.map(o=>({id:o.id,text:o.text})));assert.equal(r.item.answer,undefined);
    await h.submit(db,s.session.session_id,i.item_id,{optionId:i.position===1?i.snapshot.options.find(o=>o.id!==i.snapshot.correctOptionId).id:i.snapshot.correctOptionId});}
  assert.equal((await h.get(db,s.session.session_id)).summary.choiceCorrect,2);
  const retry=await h.create(db,{},h.U,s.session.session_id);assert.equal(retry.session.total,1);
  assert.deepEqual(retry.item.options.map(o=>o.text).sort(),fixed[0].snapshot.options.map(o=>o.text).sort());
  await db.exec('reset role');assert.deepEqual(await rows(db,'select item_id,position,snapshot from student_wordbook_review_items where session_id=$1 order by position',[s.session.session_id]),fixed);
 }finally{await db.close();}
});

engine('fixed-schema stage preserves other RPCs/corpus/history/ACL; new pool starts empty and is not writable by application/browser',async()=>{
 const db=await h.baseline();try{
  await h.save(db,{expression:'system',meaning:'系统',pos:'noun'});const old=await h.create(db);
  const tables=['lexical_entries','lexical_occurrences','student_wordbook_entries','student_wordbook_senses','student_wordbook_source_evidence','student_wordbook_review_items','student_wordbook_review_sessions'];
  const capture=async()=>{const x={};for(const t of tables)x[t]=await rows(db,`select to_jsonb(t) v from ${t} t order by to_jsonb(t)::text`);return x;};
  const before=await capture(),other=await rows(db,"select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname<>'wordbook_review_candidates' order by oid");
  const metadata=await rows(db,"select oid,proowner,proacl,provolatile,prorettype,proretset from pg_proc where proname='wordbook_review_candidates'");
  await assert.rejects(db.exec(h.read(h.migration).replace('  update public.student_wordbook_review_installation','  perform 1/0;\n  update public.student_wordbook_review_installation')),/division by zero/);await db.exec('rollback');
  assert.equal((await rows(db,"select to_regclass('wordbook_review_fixed_distractors') r"))[0].r,null);
  await db.exec(h.read(h.migration));await db.exec(h.read('supabase/student_wordbook_review_v1_fixed_pool_verify.sql'));
  assert.deepEqual(await capture(),before);assert.deepEqual(await rows(db,"select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname<>'wordbook_review_candidates' order by oid"),other);
  assert.deepEqual(await rows(db,"select oid,proowner,proacl,provolatile,prorettype,proretset from pg_proc where proname='wordbook_review_candidates'"),metadata);
  assert.equal((await h.get(db,old.session.session_id)).item.prompt,'系统');
  assert.equal((await rows(db,'select count(*)::int n from wordbook_review_fixed_distractors'))[0].n,0);
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(rows(db,'select * from wordbook_review_fixed_distractors'),/permission denied/);await assert.rejects(h.availability(db),/permission denied/);await db.exec('reset role');}
  await db.exec('set role service_role');await assert.rejects(db.exec('delete from wordbook_review_fixed_distractors'),/permission denied/);await db.exec('reset role');
 }finally{await db.close();}
});
