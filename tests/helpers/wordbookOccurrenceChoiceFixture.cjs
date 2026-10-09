// Local isolated DB only. Native benchmark uses the shipped concurrent DDL;
// PGlite tests use an ordinary build of exactly the same index definition.
const h=require('./wordbookReviewFixture.cjs');
const files={index:'supabase/student_wordbook_review_v1_occurrence_choice_index.sql',
  migration:'supabase/student_wordbook_review_v1_occurrence_choice_migration.sql',
  verify:'supabase/student_wordbook_review_v1_occurrence_choice_verify.sql'};
async function fixture(){const db=await h.fixture();await db.exec(h.read('supabase/student_wordbook_review_v1_pos7_migration.sql'));return db;}
async function install(db,{native=false}={}){
  await db.exec(native?h.read(files.index):h.read(files.index).replace('index concurrently','index'));
  await db.exec(h.read(files.migration));await db.exec(h.read(files.verify));}
async function occurrence(db,{expression,meaning,status='generated',entryStatus='generated',variant='',id}={}){
  let e=(await db.query('select entry_id from lexical_entries where normalized_expression=$1 and identity_variant=$2',[expression,variant])).rows[0];
  if(!e)e=(await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant,review_status)
    values($1,$2,$2,'word',$3,$4) returning entry_id`,[id??h.uuid(),expression,variant,entryStatus])).rows[0];
  await db.query(`insert into lexical_occurrences(occurrence_id,entry_id,source_type,source_item_id,content_block_id,
    context_text,context_meaning_zh,review_status) values(gen_random_uuid(),$1,'rap','isolated-occurrence-pool',gen_random_uuid()::text,$2,$3,$4)`,
  [e.entry_id,'Local real-shaped occurrence for '+expression+'.',meaning,status]);return e.entry_id;
}
async function pool(db){for(const [expression,meaning] of [['ocean','海洋'],['forest','森林'],['music','音乐'],['stone','岩石']])
  await occurrence(db,{expression,meaning});}
module.exports={...h,files,fixture,install,occurrence,pool};
