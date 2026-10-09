const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const h=require('./helpers/wordbookFixedPoolFixture.cjs');
const migration='supabase/student_wordbook_review_v1_choice_preference_migration.sql';
async function fixture(){const db=await h.fixture();await db.exec(h.read(migration));return db;}
const engine=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
const cand=async db=>(await db.query("select * from wordbook_review_candidates($1,'reading',array['rap']::text[],null,null)",[h.U])).rows;
async function tag(db,english,meaning,pos,category,subject,kind){
 await h.add(db,{english,meaning,pos});await db.query(`update wordbook_review_fixed_distractors set
 lexical_category=$1,subject=$2,noun_kind=$3 where english=$4 and meaning=$5`,[category,subject,kind,english,meaning]);
}
async function linkTarget(db,english,meaning,pos,category,subject,kind){
 await h.save(db,{expression:english,meaning,pos,source:'rap'});
 const e=(await db.query('select entry_id from lexical_entries where normalized_expression=$1',[english])).rows[0];
 await tag(db,english,meaning,pos,category,subject,kind);
 await db.query('update wordbook_review_fixed_distractors set canonical_entry_id=$1 where english=$2',[e.entry_id,english]);
}
engine('stable target-dependent ordering, round unused-first then limited reuse, no alphabetical cutoff',async()=>{
 const db=await fixture();try{
  for(const english of ['targetone','targettwo','targetthree'])await h.save(db,{expression:english,meaning:'系统',pos:'noun',source:'rap'});
  await h.pool(db);await db.exec('revoke select on lexical_occurrences from service_role; set role service_role');
  const a=await cand(db),b=await cand(db);assert.deepEqual(a,b);assert.equal(a.length,3);
  assert.equal(new Set(a.flatMap(q=>q.snapshot.distractors.map(d=>d.text))).size,9);
  assert.ok(new Set(a.map(q=>q.snapshot.distractors.map(d=>d.text).join('|'))).size>1);
  await db.exec('reset role');await db.exec("update wordbook_review_fixed_distractors set approved=false where meaning not in('海洋','森林','音乐')");
  assert.ok((await cand(db)).every(q=>q.reason===null));
 }finally{await db.close();}
});
engine('限制/抑制 and longer variants rejected for target AND distractor pairs; unknown tags remain eligible',async()=>{
 const db=await fixture();try{
  await h.save(db,{expression:'constrain',meaning:'限制',pos:'verb',source:'rap'});
  await h.save(db,{expression:'inhibit',meaning:'抑制',pos:'verb',source:'rap'});
  await h.save(db,{expression:'emit',meaning:'发射',pos:'verb',source:'rap'});
  await h.add(db,{english:'control',meaning:'制约',pos:'verb'});
  for(const [english,meaning] of [['analyze','分析'],['observe','观察'],['quantify','量化'],['evaporate','蒸发']])await h.add(db,{english,meaning,pos:'verb'});
  const a=await cand(db);assert.ok(a.every(q=>q.reason===null));
  for(const q of a){const text=q.snapshot.distractors.map(d=>d.text);
   if(q.snapshot.expression!=='emit')assert.ok(text.every(d=>!['限制','抑制','制约'].includes(d)));
   else assert.ok(text.filter(d=>['限制','抑制','制约'].includes(d)).length<=1);}
  for(const [a,b] of [['限制','抑制'],['受限制','抑制生长'],['约束','制约']])assert.equal((await db.query('select wordbook_review_meaning_conflict($1,$2) c',[a,b])).rows[0].c,true);
 }finally{await db.close();}
});
test('supplemental labels leave all 493 word/source fields untouched, ambiguous/missing labels never invented',()=>{
 const pool=JSON.parse(h.read('data/wordbook-review/fixed-pool-v2.full-review.json'));
 const tags=JSON.parse(h.read('data/wordbook-review/fixed-pool-v2.preference-tags.json'));
 assert.equal(tags.length,493);assert.equal(new Set(tags.map(t=>t.pool_id)).size,493);
 assert.equal(crypto.createHash('sha256').update(h.read('data/wordbook-review/fixed-pool-v2.full-review.json')).digest('hex'),
  'b94b9fd17d02d8a7b91125eba803a1f3181b9d86b26401f512ca09f4aa14b352');
 for(const t of tags){const r=pool.find(r=>r.pool_id===t.pool_id);for(const k of ['canonical_entry_id','normalized_expression','pos','meaning'])assert.equal(t[k],r[k]);
  assert.equal(t.lexical_category,['通用学术','学科专业'].includes(r.lexical_category)?r.lexical_category:null);
  assert.equal(t.subject,t.lexical_category?r.subject:null);
  if(t.pos==='noun')assert.ok(['abstract','concrete','other'].includes(t.noun_kind));else assert.equal(t.noun_kind,null);}
 const count=k=>tags.filter(t=>t.noun_kind===k).length;
 assert.deepEqual([count('abstract'),count('concrete'),count('other')],[113,29,8]);
});
engine('noun kind/category/subject soft preference and related field; correct tags require canonical+POS+meaning; gradual relaxation',async()=>{
 const db=await fixture();try{
  await linkTarget(db,'asteroid','小行星','noun','学科专业','天文','concrete');
  for(const [e,m,c,s,k] of [['comet','彗星','学科专业','天文','concrete'],['nebula','星云','学科专业','天文','concrete'],
   ['galaxy','星系','学科专业','天文','concrete'],['theory','理论','通用学术','跨学科学术','abstract'],
   ['sensor','传感器','学科专业','科技','concrete']])await tag(db,e,m,'noun',c,s,k);
  let q=(await cand(db))[0];assert.deepEqual(new Set(q.snapshot.distractors.map(d=>d.text)),new Set(['彗星','星云','星系']));
  // 行星 is contained by 小行星, so it is correctly excluded by the existing
  // conflict rule. Synthetic 星云 above isolates the soft-ordering test.
  await db.exec("update wordbook_review_fixed_distractors set approved=false where english in('comet','nebula')");
  q=(await cand(db))[0];assert.equal(q.reason,null);assert.deepEqual(new Set(q.snapshot.distractors.map(d=>d.text)),new Set(['星系','传感器','理论']));
  assert.equal((await db.query("select wordbook_review_preference_rank('{}'::jsonb,to_jsonb(f),'noun') n from wordbook_review_fixed_distractors f where english='theory'")).rows[0].n,0);
  // Verify canonical identity alone cannot label a different saved meaning.
  await db.query("update wordbook_review_fixed_distractors set meaning='另一义' where english='asteroid'");
  const neutral=(await cand(db))[0].snapshot.distractors;
  await db.exec("update wordbook_review_fixed_distractors set lexical_category=null,subject=null,noun_kind=null");
  assert.deepEqual((await cand(db))[0].snapshot.distractors,neutral);
  // Likewise, matching spelling/POS/meaning without a canonical link is neutral.
  await db.exec("update wordbook_review_fixed_distractors set meaning='小行星',canonical_entry_id=gen_random_uuid(),lexical_category='学科专业',subject='天文',noun_kind='concrete' where english='asteroid'");
  assert.deepEqual((await cand(db))[0].snapshot.distractors,neutral);
  const body=(await db.query("select prosrc from pg_proc where proname='wordbook_review_candidates'")).rows[0].prosrc;
  assert.match(body,/l::text\|\|'\|'\|\|pos_id\|\|'\|'\|\|public.wordbook_review_meaning\(s.context_meaning_zh\)/);
  assert.equal((await db.query(`select wordbook_review_preference_rank('{"lexical_category":"学科专业","subject":"天文"}',
   '{"lexical_category":"学科专业","subject":"科技"}','noun') n`)).rows[0].n,1);
 }finally{await db.close();}
});
engine('local first even when fixed semantic matches are stronger; snapshot/grading survives pool and candidate revoke; migration preserves other RPCs and rollback',async()=>{
 const db=await h.fixture();try{
  await h.save(db,{expression:'system',meaning:'系统',pos:'noun',source:'rap'});await h.pool(db);
  const old=await h.create(db,h.settings(['rap']));
  const other=(await db.query("select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname not in('wordbook_review_candidates','wordbook_review_meaning_conflict') order by oid")).rows;
  await assert.rejects(db.exec(h.read(migration).replace(' update public.student_wordbook_review_installation',' perform 1/0;\n update public.student_wordbook_review_installation')),/division by zero/);await db.exec('rollback');
  assert.equal((await db.query("select to_regprocedure('wordbook_review_preference_rank(jsonb,jsonb,text)') r")).rows[0].r,null);
  await db.exec(h.read(migration));await db.exec(h.read('supabase/student_wordbook_review_v1_choice_preference_verify.sql'));
  await assert.rejects(db.exec(h.read(migration)),/REVIEW_PREFERENCE_ALREADY_PRESENT/);await db.exec('rollback');
  await assert.rejects(db.exec(h.read('supabase/student_wordbook_review_v1_choice_preference_tags.sql')),/REVIEW_PREFERENCE_EXACT_V2_POOL_REQUIRED/);await db.exec('rollback');
  assert.equal((await db.query("select count(*)::int n from wordbook_review_fixed_distractors where noun_kind is not null")).rows[0].n,0);
  assert.deepEqual((await db.query("select oid,prosrc,proacl from pg_proc where proname like 'wordbook_review_%' and proname not in('wordbook_review_candidates','wordbook_review_meaning_conflict','wordbook_review_preference_rank') order by oid")).rows,other);
  for(const [e,m] of [['ocean','海洋'],['forest','森林'],['music','音乐']])await h.save(db,{expression:e,meaning:m,pos:'noun'});
  const q=(await cand(db))[0];assert.ok(q.snapshot.distractors.every(d=>d.wordbookEntryId));
  const s=await h.create(db,h.settings(['rap'])),before=s.item.options;
  await db.exec('revoke select on lexical_entries,lexical_occurrences,wordbook_review_fixed_distractors from service_role; revoke execute on function wordbook_review_candidates(uuid,text,text[],timestamptz,timestamptz) from service_role; set role service_role');
  assert.deepEqual((await h.get(db,s.session.session_id)).item.options,before);
  assert.deepEqual((await h.get(db,old.session.session_id)).item.options,old.item.options);
  assert.equal((await h.submit(db,s.session.session_id,s.item.itemId,{optionId:before.find(o=>o.text==='系统').id})).summary.choiceCorrect,1);
  await db.exec('reset role');
 }finally{await db.close();}
});
