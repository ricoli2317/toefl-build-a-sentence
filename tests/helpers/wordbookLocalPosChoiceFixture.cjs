// Isolated fixture only; never loads production env/client or source artifacts.
const h=require('./wordbookOccurrenceChoiceFixture.cjs');
const files={index:'supabase/student_wordbook_review_v1_local_pos_choice_index.sql',
  migration:'supabase/student_wordbook_review_v1_local_pos_choice_migration.sql',
  verify:'supabase/student_wordbook_review_v1_local_pos_choice_verify.sql'};
async function fixture(){const db=await h.fixture();await h.install(db);return db;}
async function install(db,{native=false}={}){
  await db.exec(native?h.read(files.index):h.read(files.index).replace('index concurrently','index'));
  await db.exec(h.read(files.migration));
  await db.exec(h.read(files.verify));
}
async function occurrence(db,p){const id=await h.occurrence(db,p);
  await db.query('update lexical_occurrences set context_pos=$1 where entry_id=$2',[p.pos??null,id]);return id;}
const pool=async db=>{for(const [expression,meaning] of [['ocean','海洋'],['forest','森林'],['music','音乐'],['stone','岩石']])
  await occurrence(db,{expression,meaning,pos:'noun'});};
module.exports={...h,files,fixture,install,occurrence,pool};
