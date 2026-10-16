// Entirely synthetic canonical/content, in-memory PostgreSQL only. No reviewed corpus files or network.
const { randomUUID } = require('node:crypto');
const { fixture, read, client, U } = require('./ctwVocabularyFixture.cjs');
const core = require('../../lib/ctw-vocabulary/incremental.ts');
const { CTW_SNAPSHOT_SQL } = require('../../lib/ctw-vocabulary/incrementalSql.ts');
const sense = (pos='noun', meaning_zh='合成测试义项', example_en='A synthetic example for an isolated test.') => ({pos,meaning_zh,example_en});
const alpha = i => String.fromCharCode(97 + Math.floor(i/26)) + String.fromCharCode(97+i%26);
function canonical(id, answers) {
  return {sourceItemId:id,paragraphs:[{paragraphId:'p',paragraphOrder:1}],slots:answers.map((answer,i)=>({slotId:`s${i}`,paragraphId:'p',answer})),
    segments:answers.flatMap((_,i)=>[{paragraphId:'p',segmentOrder:i*2+1,segmentType:'text',textContent:' ordinaryword ',slotId:null},
      {paragraphId:'p',segmentOrder:i*2+2,segmentType:'blank',textContent:null,slotId:`s${i}`}])};
}
function snapshot(count=49) {
  const entries=Array.from({length:count},(_,i)=>{const word=i===0?'bank':`fixture${alpha(i)}`;return{
    entry_id:randomUUID(),word,normalized_word:word,list_number:Math.floor(i/50)+1,list_position:i%50+1,cefr:'A1',
    senses:[sense()],irregular_forms:[],source_sha256:'a'.repeat(64)};});
  return {canonical:[canonical('historical',['bank']),canonical('new',['bank','bank','novelword','novelword'])],entries,
    memberships:entries.map(e=>({entry_id:e.entry_id,cefr_group:'A1',list_number:e.list_number,list_position:e.list_position}))};
}
function checkpoint(s) {return {version:'ctw-incremental-checkpoint-v1',sources:core.canonicalSources(s.canonical.filter(c=>c.sourceItemId==='historical'))};}
const word = (name='novelword',cefr='B2',senses=[sense()]) => ({word:name,cefr,senses,irregular_forms:[],
  cefr_review:{reference:'Oxford 3000/5000',locator:'SYNTHETIC reference; no real rating claimed',pos_sense_rationale:'Synthetic POS/sense rationale.'},forms_review:'Synthetic regular form reviewed; no additional irregular items.'});
function review(plan) {return {version:'ctw-incremental-review-v1',plan_sha256:core.digest(plan),reviewer:'synthetic-reviewer',
  decisions:plan.candidates.map((c,i)=>({candidate_id:c.id,base_form:c.normalized_answer,action:c.normalized_answer==='bank'?(i===0?'reuse':'sense'):'new',
    reason:'Synthetic context decision',...(c.normalized_answer==='bank'&&i!==0?{sense:sense('verb','使倾斜')}:{sense_index:0})})),new_words:[word()]};}
async function database(s) {
  const db=await fixture({seed:false});
  try {
    for(const e of s.entries) await db.query(`insert into ctw_vocabulary_entries(entry_id,word,list_number,list_position,cefr,senses,irregular_forms,source_sha256)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,[e.entry_id,e.word,e.list_number,e.list_position,e.cefr,JSON.stringify(e.senses),JSON.stringify(e.irregular_forms),e.source_sha256]);
    const mapping=s.memberships.map(m=>({...m,word:s.entries.find(e=>e.entry_id===m.entry_id).word.toLowerCase()}));
    const install=read('supabase/ctw_vocabulary_phase3_lists.sql.template').replace('__CTW_CEFR_MAPPING__',JSON.stringify(mapping).replace(/'/g,"''"))
      .replace('<> 1032',`<> ${s.entries.length}`);
    await db.exec(install); await db.exec(read('supabase/ctw_vocabulary_phase3_start_owner_fix.sql'));
    await db.exec(read('supabase/ctw_vocabulary_review_sync.sql'));
    await db.exec(`create table reading_logical_items(logical_item_id text primary key,module text);
      create table reading_questions(question_id text primary key,logical_item_id text);
      create table reading_ctw_paragraphs(question_id text,paragraph_id text,paragraph_order int);
      create table reading_ctw_segments(question_id text,paragraph_id text,segment_order int,segment_type text,text_content text,slot_id text);
      create table reading_ctw_slots(question_id text,slot_id text,paragraph_id text,answer text);`);
    for(const c of s.canonical){
      await db.query("insert into reading_logical_items values($1,'ctw')",[c.sourceItemId]);
      await db.query('insert into reading_questions values($1,$1)',[c.sourceItemId]);
      for(const p of c.paragraphs)await db.query('insert into reading_ctw_paragraphs values($1,$2,$3)',[c.sourceItemId,p.paragraphId,p.paragraphOrder]);
      for(const t of c.segments)await db.query('insert into reading_ctw_segments values($1,$2,$3,$4,$5,$6)',[c.sourceItemId,t.paragraphId,t.segmentOrder,t.segmentType,t.textContent,t.slotId]);
      for(const t of c.slots)await db.query('insert into reading_ctw_slots values($1,$2,$3,$4)',[c.sourceItemId,t.slotId,t.paragraphId,t.answer]);
    }
    return db;
  }catch(e){await db.close();throw e;}
}
async function capture(db){return(await db.query(CTW_SNAPSHOT_SQL)).rows[0].jsonb_build_object;}
module.exports={sense,alpha,canonical,snapshot,checkpoint,word,review,database,capture,client,U,core};
