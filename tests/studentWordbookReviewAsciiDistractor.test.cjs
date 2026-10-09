// Isolated SQL only. No env loading, Supabase/production SQL, browser or auth.
const test=require('node:test'),assert=require('node:assert/strict');
const h=require('./helpers/wordbookLocalPosChoiceFixture.cjs');
const migration='supabase/student_wordbook_review_v1_ascii_distractor_migration.sql';
const verify='supabase/student_wordbook_review_v1_ascii_distractor_verify.sql';
const engine=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const rows=async(db,sql,p=[])=>(await db.query(sql,p)).rows;
async function fixture(){const db=await h.fixture();await h.install(db);return db;}
async function install(db){await db.exec(h.read(migration));await db.exec(h.read(verify));}
const candidates=db=>rows(db,'select * from wordbook_review_candidates($1,$2,$3,null,null)',[h.U,'reading',['rap']]);

engine('shared gate excludes uppercase/lowercase ASCII locally; correct answer with ASCII survives; enough local never reads global',async()=>{
 const db=await fixture();try{
  await h.save(db,{expression:'system',source:'rap',meaning:'CMS系统',pos:'noun'});
  for(const [expression,meaning] of [['hall','B 会议厅'],['company','BrightPath 分析公司'],['agency','CMS机构'],['lowercase','abc办公室'],
    ['ocean','海洋'],['forest','森林'],['entrance','2号入口']])await h.save(db,{expression,meaning,pos:'noun'});
  await install(db);await db.exec('revoke select on lexical_occurrences from service_role; set role service_role');
  const c=(await candidates(db))[0];assert.equal(c.reason,null);assert.equal(c.snapshot.meaning,'CMS系统');
  assert.deepEqual(new Set(c.snapshot.distractors.map(d=>d.text)),new Set(['海洋','森林','2号入口']));
  assert.ok(c.snapshot.distractors.every(d=>d.wordbookEntryId&&!/[A-Za-z]/.test(d.text)));
  assert.equal((await h.availability(db,h.settings(['rap']))).meaningChoice,1);
  const s=await h.create(db,h.settings(['rap']));assert.equal(s.item.options.length,4);
  const right=s.item.options.find(o=>o.text==='CMS系统');assert.ok(right);
  assert.equal((await h.submit(db,s.session.session_id,s.item.itemId,{optionId:right.id})).summary.choiceCorrect,1);
  await db.exec('reset role');
 }finally{await db.close();}
});

engine('global supplementation applies identical ASCII rule and retains local priority, POS7, duplicate and semantic conflict exclusions',async()=>{
 const db=await fixture();try{
  await h.save(db,{expression:'run',source:'rap',meaning:'使用',pos:'verb'});
  await h.save(db,{expression:'find',meaning:'发现',pos:'auxiliary'});
  await h.save(db,{expression:'bad-local',meaning:'a跑道',pos:'verb'});
  for(const p of [
    {expression:'agency',meaning:'CMS机构',pos:'verb'}, {expression:'lowercase',meaning:'abc运行',pos:'verb'},
    {expression:'bad-pos',meaning:'光芒',pos:'noun'}, {expression:'synonym',meaning:'利用',pos:'verb'},
    {expression:'duplicate',meaning:'发现',pos:'verb'}, {expression:'unknown',meaning:'火山',pos:'unknown'},
    {expression:'keep',meaning:'保留',pos:'modal'}, {expression:'build',meaning:'建立',pos:'phrasal verb'}
  ])await h.occurrence(db,p);
  await install(db);const c=(await candidates(db))[0];assert.equal(c.reason,null);
  assert.deepEqual(c.snapshot.distractors.map(d=>d.text),['发现','保留','建立']);
  assert.ok(c.snapshot.distractors[0].wordbookEntryId);assert.ok(c.snapshot.distractors.slice(1).every(d=>d.lexicalEntryId));
  assert.ok(c.snapshot.distractors.every(d=>!/[A-Za-z]/.test(d.text)));
  assert.equal(c.snapshot.pos,'verb');
 }finally{await db.close();}
});

engine('fewer than three after ASCII exclusion stays insufficient; bounded 128-key pool is not expanded past rejected labels',async()=>{
 const db=await fixture();try{
  await h.save(db,{expression:'system',source:'rap',meaning:'系统',pos:'noun'});
  await h.save(db,{expression:'local-english',meaning:'B 会议厅',pos:'noun'});
  await h.save(db,{expression:'ocean',meaning:'海洋',pos:'noun'});
  await db.exec(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type)
    select md5('ascii-cap:'||g)::uuid,'cap'||g,'cap'||g,'word' from generate_series(1,140) g;
    insert into lexical_occurrences(occurrence_id,entry_id,content_block_id,context_text,context_meaning_zh,context_pos)
    select gen_random_uuid(),md5('ascii-cap:'||g)::uuid,'ascii'||g,'Local isolated span.','A机构','noun' from generate_series(1,140) g;`);
  await h.occurrence(db,{expression:'global-forest',meaning:'森林',pos:'noun'});
  await h.occurrence(db,{expression:'global-music',meaning:'音乐',pos:'noun'});
  await install(db);const a=await h.availability(db,h.settings(['rap']));assert.equal(a.total,0);
  assert.equal(a.reasons.insufficient_distractors,1);
  await assert.rejects(h.create(db,h.settings(['rap'])),/REVIEW_INSUFFICIENT:0/);
  assert.equal((await rows(db,'select count(*)::int n from student_wordbook_review_sessions'))[0].n,0);
 }finally{await db.close();}
});

engine('minimal replacement leaves corpus, collections, history, all other RPCs and access contracts unchanged; existing mixed-ASCII snapshots remain usable',async()=>{
 const db=await fixture();try{
  await h.save(db,{expression:'system',source:'rap',meaning:'系统',pos:'noun'});
  for(const [expression,meaning] of [['hall','B 会议厅'],['agency','CMS机构'],['company','BrightPath 分析公司']])
    await h.save(db,{expression,meaning,pos:'noun'});
  const historical=await h.create(db,h.settings(['rap']));assert.ok(historical.item.options.some(o=>/[A-Za-z]/.test(o.text)));
  const tables=['lexical_entries','lexical_occurrences','student_wordbook_entries','student_wordbook_senses','student_wordbook_source_evidence','student_wordbook_review_sessions','student_wordbook_review_items','student_wordbook_review_answers'];
  const capture=async()=>{const o={};for(const name of tables)o[name]=await rows(db,`select to_jsonb(t) v from ${name} t order by to_jsonb(t)::text`);return o;};
  const before=await capture();const others=await rows(db,"select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname<>'wordbook_review_candidates' order by oid");
  const contract=await rows(db,"select oid,proowner,proacl,provolatile,prorettype,proretset from pg_proc where proname='wordbook_review_candidates'");
  await install(db);assert.deepEqual(await capture(),before);
  assert.deepEqual(await rows(db,"select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname<>'wordbook_review_candidates' order by oid"),others);
  assert.deepEqual(await rows(db,"select oid,proowner,proacl,provolatile,prorettype,proretset from pg_proc where proname='wordbook_review_candidates'"),contract);
  assert.deepEqual((await h.get(db,historical.session.session_id)).item.options,historical.item.options);
  const right=historical.item.options.find(o=>o.text==='系统');
  assert.equal((await h.submit(db,historical.session.session_id,historical.item.itemId,{optionId:right.id})).summary.choiceCorrect,1);
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(h.availability(db),/permission denied/);await db.exec('reset role');}
  await assert.rejects(db.exec(h.read(migration)),/BASELINE_DRIFT/);await db.exec('rollback');
 }finally{await db.close();}
});
