const h=require('./wordbookLocalPosChoiceFixture.cjs');
const migration='supabase/student_wordbook_review_v1_fixed_pool_migration.sql';
async function baseline(){const db=await h.fixture();await h.install(db);
  await db.exec(h.read('supabase/student_wordbook_review_v1_ascii_distractor_migration.sql'));return db;}
async function fixture(){const db=await baseline();await db.exec(h.read(migration));return db;}
// Synthetic fixture rows explicitly NOT the approval seed or invented production senses.
async function add(db,{english,meaning,pos='noun',approved=true}={}){
 await db.query(`insert into wordbook_review_fixed_distractors(pos,english,normalized_expression,meaning,raw_pos,
   canonical_entry_id,occurrence_id,source_type,source_item_id,content_block_id,revision,approved)
   values($1,$2,lower($2),$3,$1,gen_random_uuid(),gen_random_uuid(),'rap','isolated-fixture','fixture','TEST_ONLY',$4)`,
  [pos,english,meaning,approved]);}
async function pool(db,pos='noun'){for(const [english,meaning] of [['ocean','海洋'],['forest','森林'],['music','音乐'],
 ['stone','岩石'],['fire','火焰'],['river','河流'],['leaf','树叶'],['bird','鸟类'],['soil','土壤']])await add(db,{english,meaning,pos});}
module.exports={...h,migration,baseline,fixture,add,pool};
