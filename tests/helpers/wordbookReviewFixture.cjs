// Isolated local SQL only. The production cleanup assertion is tested with exact
// approved IDs/counts in a synthetic database, never skipped in the migration.
const h=require('./wordbookManagementFixture.cjs');
const approved=[['bdd0bd35-e23d-4b59-934f-cbc9de875a93','like@bas.com',34,20],
  ['523be430-1f13-4660-8f11-1d263fc1438e','jiangzhuocheng2@bas.com',9,17],
  ['c05d7082-ae31-46a0-918c-ae3de880017a','zhangciwei0@bas.com',1,0]];
async function beforeMigration(existingDb){
  const db=existingDb??await h.fixture();
  await db.exec('alter table auth.users add column email text');
  for(const [id,email,r,w] of approved){
    await db.query('insert into auth.users(id,email) values($1,$2)',[id,email]);
    await db.query("insert into profiles values($1,'student',true)",[id]);
    for(const [domain,n] of [['reading',r],['writing',w]])await db.query(`insert into student_wordbook_entries
      (student_id,domain,expression,normalized_expression,expression_type,identity_variant,source_types)
      select $1,$2,'cleanup'||g,'cleanup'||g,'word','',array[$4]::text[] from generate_series(1,$3) g`,[id,domain,n,domain==='reading'?'ctw':'bas']);
  }
  return db;
}
async function fixture(){const db=await beforeMigration();try{
  await db.exec(h.read('supabase/student_wordbook_review_v1_preflight.sql'));
  await db.exec(h.read('supabase/student_wordbook_review_v1_migration.sql'));
  return db;
}catch(e){await db.close();throw e;}}
async function save(db,{user=h.U,source='ctw',expression='run',pos='verb',meaning='运行',variant='',example=true}={}){
  let e=(await db.query('select entry_id from lexical_entries where normalized_expression=$1 and identity_variant=$2',[expression,variant])).rows[0];
  if(!e)e=(await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant)
    values(gen_random_uuid(),$1,$1,'word',$2) returning entry_id`,[expression,variant])).rows[0];
  await db.query(`update lexical_occurrences set entry_id=$1,source_type=$2,context_pos=$3,context_meaning_zh=$4,
    context_text=$5,surface_text=$6,start_offset=3,end_offset=$7 where occurrence_id=$8`,[e.entry_id,source,pos,meaning,`We ${expression} daily.`,expression,3+expression.length,h.O]);
  await db.query('update lexical_source_blocks set source_type=$1',[source]);
  const p=await h.payload(db);
  if(!example)Object.assign(p,{example_text:null,context_kind:null,extraction_method:'verified_no_example_boundary'});
  return (await db.query('select operate_student_wordbook_v1($1,$2,$3,$4::jsonb) result',[user,h.O,'save',JSON.stringify(p)])).rows[0].result;
}
async function pool(db){
  for(const [word,meaning,pos] of [['ocean','海洋','noun'],['forest','森林','noun'],['music','音乐','noun'],['stone','岩石','noun'],['quick','迅速的','adjective'],['calm','安静的','adjective'],['often','经常','adverb'],['under','在下面','preposition'],['action','行动','verb']]){
    await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,common_senses)
      values(gen_random_uuid(),$1,$1,'word',$2::jsonb) on conflict(normalized_expression,expression_type,identity_variant) do update set common_senses=excluded.common_senses`,[word,JSON.stringify([{pos,meaning_zh:meaning,definition_en:'Offline fixture.'}])]);
  }
}
const settings=(sources=['ctw'],domain='reading',count=1)=>({domain,sources,mode:'random',timeZone:'Asia/Shanghai',count});
const uuid=()=>require('node:crypto').randomUUID();
const create=async(db,q=settings(),user=h.U,parent=null,request=uuid())=>(await db.query('select wordbook_review_create($1,$2::jsonb,$3,$4) result',[user,JSON.stringify(q),request,parent])).rows[0].result;
const availability=async(db,q=settings(),user=h.U)=>(await db.query('select wordbook_review_availability($1,$2::jsonb) result',[user,JSON.stringify(q)])).rows[0].result;
const get=async(db,id,user=h.U,position=null)=>(await db.query('select wordbook_review_read($1,$2,$3) result',[user,id,position])).rows[0].result;
const submit=async(db,session,item,answer,user=h.U)=>(await db.query('select wordbook_review_submit($1,$2,$3,$4::jsonb) result',[user,session,item,JSON.stringify(answer)])).rows[0].result;
module.exports={...h,approved,beforeMigration,fixture,save,pool,settings,uuid,create,availability,get,submit};
