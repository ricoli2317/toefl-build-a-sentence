// USER-approved delivery recipe exercised ONLY in an isolated local DB.
// Reconstructed source snapshots are not proof of current production state.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const h=require('./helpers/wordbookFixedPoolFixture.cjs');
const prefix='supabase/student_wordbook_review_v1_',pool=JSON.parse(h.read('data/wordbook-review/fixed-pool-v2.full-review.json'));
const manifest=JSON.parse(h.read('data/wordbook-review/fixed-pool-v2.install-manifest.json'));
const seed=prefix+'fixed_pool_v2_seed_APPROVED.sql',bundle=prefix+'fixed_pool_v2_install.sql',verify=prefix+'fixed_pool_v2_production_verify.sql';
const engine=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
async function reconstruct(db){
 for(const [n,r] of pool.entries()){
  await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant,review_status)
   values($1,$2,$3,'word','','generated') on conflict(entry_id) do nothing`,[r.canonical_entry_id,r.english,r.normalized_expression]);
  await db.query(`insert into lexical_occurrences(occurrence_id,entry_id,source_type,source_item_id,content_block_id,context_pos,
   context_meaning_zh,context_definition_en,context_text,start_offset,end_offset,review_status)
   values($1,$2,$3,$4,$5,$6,$7,$8,'LOCAL approved-source snapshot reconstruction',$9,$10,'generated')`,
   [r.occurrence_id,r.canonical_entry_id,r.source_type,r.source_item_id,r.content_block_id,r.raw_pos,r.meaning,r.definition_en,n*2,n*2+1]);
 }
}
const hashBody=async db=>(await db.query("select md5(btrim(replace(prosrc,E'\\r\\n',E'\\n'),E' \\t\\r\\n')) hash from pg_proc where oid=to_regprocedure('wordbook_review_candidates(uuid,text,text[],timestamptz,timestamptz)')")).rows[0].hash;
async function capture(db){const result={};
 for(const name of ['lexical_entries','lexical_occurrences','lexical_source_blocks','student_wordbook_entries','student_wordbook_senses',
  'student_wordbook_source_evidence','student_wordbook_review_sessions','student_wordbook_review_items','student_wordbook_review_answers'])
  result[name]=(await db.query(`select to_jsonb(t) v from ${name} t order by to_jsonb(t)::text`)).rows;
 return result;
}
test('approved production delivery is exact/hash-linked, single-transaction and excludes rejected seed and original cleanup',()=>{
  assert.equal(manifest.total,493);
  assert.equal(manifest.approvedDatasetSha256,'b94b9fd17d02d8a7b91125eba803a1f3181b9d86b26401f512ca09f4aa14b352');
  assert.equal(crypto.createHash('sha256').update(h.read(manifest.dataset)).digest('hex'),manifest.approvedDatasetSha256);
 for(const [file,spec] of Object.entries(manifest.files)){assert.equal(crypto.createHash('sha256').update(h.read(file)).digest('hex'),spec.sha256,file);assert.equal(fs.statSync(file).size,spec.bytes);}
 const sql=h.read(bundle);assert.equal((sql.match(/^begin;$/gm)||[]).length,1);assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
 assert.doesNotMatch(sql,/fixed-v1-draft|fixed_pool_seed_DRAFT|student_wordbook_review_v1_migration\.sql|delete from|truncate |on conflict/i);
 assert.match(sql,/set transaction isolation level repeatable read;/i);assert.match(sql,/for share of o,e;/i);
  // The empty-pool/ASCII preflight is embedded in stage 1, not an external file.
  const stages=manifest.standaloneDependencyOrder.map((file,n)=>sql.indexOf('-- DEPENDENCY STAGE '+(n+2)+': '+file));
 assert.ok(stages.every((index,n)=>index>=0&&(n===0||index>stages[n-1])));
 assert.equal((h.read(seed).match(/'fixed-v2-approved-493-20261009',true\)/g)||[]).length,493);
 const expected=JSON.parse(h.read(verify).split('$approved_v2_expected$')[1]);assert.equal(expected.length,493);
 for(const r of pool){const e=expected.find(e=>e.pool_id===r.pool_id);assert.ok(e);
  for(const k of ['english','pos','meaning','raw_pos','canonical_entry_id','occurrence_id','normalized_expression','source_type','source_item_id','content_block_id','definition_en'])assert.equal(e[k],r[k]);
  assert.equal(e.approved,true);assert.equal(e.revision,manifest.revision);}
});
engine('atomic ASCII -> approved493 -> preferences: changed source rolls back all schema/runtime; success preserves corpus/collections/history and snapshot grading',async()=>{
 const db=await h.baseline();try{
  await reconstruct(db);await h.save(db,{expression:'system',meaning:'系统',pos:'noun',source:'rap'});
  const historical=await h.create(db,h.settings(['rap']));
  await db.query("update lexical_occurrences set context_meaning_zh='原义已变化' where occurrence_id=$1",[pool[0].occurrence_id]);
  const bad=await capture(db);await assert.rejects(db.exec(h.read(bundle)),/REVIEW_V2_SEED_SOURCE_CHANGED_OR_MISSING/);await db.exec('rollback');
  assert.equal((await db.query("select to_regclass('wordbook_review_fixed_distractors') r")).rows[0].r,null);
  assert.equal(await hashBody(db),'61214848add269f4ac535f8e9fd89682');assert.deepEqual(await capture(db),bad);
  await db.query('update lexical_occurrences set context_meaning_zh=$1 where occurrence_id=$2',[pool[0].meaning,pool[0].occurrence_id]);
  const before=await capture(db);await db.exec(h.read(bundle));await db.exec(h.read(verify));
  assert.equal(await hashBody(db),'5c1eef05c08c227b7b2b1fcccba9a0cc');assert.deepEqual(await capture(db),before);
  const rows=(await db.query('select * from wordbook_review_fixed_distractors order by pool_id')).rows;
  assert.equal(rows.length,493);assert.ok(rows.every(r=>r.approved&&r.revision===manifest.revision));
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.byPos).map(pos=>[pos,rows.filter(r=>r.pos===pos).length])),manifest.byPos);
  await assert.rejects(db.exec(h.read(bundle)),/REVIEW_V2_PREFLIGHT_FIXED_POOL_ALREADY_PRESENT/);await db.exec('rollback');
  await assert.rejects(db.exec(h.read(seed)),/REVIEW_V2_SEED_REQUIRES_EMPTY_POOL/);await db.exec('rollback');
  assert.deepEqual((await db.query('select * from wordbook_review_fixed_distractors order by pool_id')).rows,rows);
  await db.exec('revoke select on lexical_occurrences from service_role; set role service_role');
  assert.equal((await h.availability(db,h.settings(['rap']))).meaningChoice,1);
  const created=await h.create(db,h.settings(['rap']));
  await db.exec('reset role; revoke select on lexical_entries,lexical_occurrences,wordbook_review_fixed_distractors from service_role; revoke execute on function wordbook_review_candidates(uuid,text,text[],timestamptz,timestamptz) from service_role; set role service_role');
  assert.deepEqual((await h.get(db,historical.session.session_id)).item.options,historical.item.options);
  assert.deepEqual((await h.get(db,created.session.session_id)).item.options,created.item.options);
  assert.equal((await h.submit(db,created.session.session_id,created.item.itemId,{optionId:created.item.options.find(o=>o.text==='系统').id})).summary.choiceCorrect,1);
  await db.exec('reset role');
 }finally{await db.close();}
});
engine('standalone dependency recipe installs the same approved493; exact final verification detects data and label drift, nonempty pool never overwritten',async()=>{
 const db=await h.fixture();try{
  await reconstruct(db);await db.exec(h.read(seed));
  assert.equal((await db.query('select count(*)::int n from wordbook_review_fixed_distractors')).rows[0].n,493);
  await db.exec(h.read(prefix+'choice_preference_migration.sql'));await db.exec(h.read(prefix+'choice_preference_tags.sql'));await db.exec(h.read(verify));
  await db.query("update wordbook_review_fixed_distractors set noun_kind='other' where pool_id=$1",[pool[0].pool_id]);
  await assert.rejects(db.exec(h.read(verify)),/REVIEW_V2_FINAL_APPROVED_DATA_OR_LABEL_DRIFT/);await db.exec('rollback');
  await db.exec(h.read(prefix+'choice_preference_tags.sql'));await db.exec(h.read(verify));
  await db.query("update wordbook_review_fixed_distractors set definition_en='Changed local fixture definition' where pool_id=$1",[pool[0].pool_id]);
  await assert.rejects(db.exec(h.read(verify)),/REVIEW_V2_FINAL_APPROVED_DATA_OR_LABEL_DRIFT/);await db.exec('rollback');
  await assert.rejects(db.exec(h.read(seed)),/REVIEW_V2_SEED_REQUIRES_EMPTY_POOL/);await db.exec('rollback');
 }finally{await db.close();}
});
