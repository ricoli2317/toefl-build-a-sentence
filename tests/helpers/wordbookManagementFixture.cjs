// OFFLINE ONLY. Reuse installed DDL, no credentials/env config/production client.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const file=path.join(root,'tests/studentWordbookA3.test.js'),source=read('tests/studentWordbookA3.test.js');
const h=vm.runInNewContext(source.slice(0,source.indexOf("test('API"))+'\n({fixture,save,payload,list,dates,events,U,V,E,O});',{require:createRequire(file),__dirname:path.dirname(file),process,console});
const sentence='Additionally, AI-driven analytics tools offer insights by processing vast amounts of data in real time, helping organizations make informed decisions.';
async function fixture({populate=false}={}) {
  const db=await h.fixture();
  await db.exec(read('supabase/student_wordbook_v1_bugfix_20261008.sql'));
  await db.exec(read('supabase/student_wordbook_v1_batch_delete_preflight_20261008.sql'));
  await db.exec(read('supabase/student_wordbook_v1_batch_delete_20261008.sql'));
  await db.exec(read('supabase/student_wordbook_v1_batch_delete_verify_20261008.sql'));
  if(populate){
    for(let i=0;i<21;i++){
      const word=i===0?'informed':i===20?'insight':`sample${String(i).padStart(2,'0')}`;
      const eid=(await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,lemma) values(gen_random_uuid(),$1,$1,'word',$1) returning entry_id`,[word])).rows[0].entry_id;
      await add(db,h.U,'reading',word,eid,i);
      if(i<3)await add(db,h.U,'writing',word,eid,i);
      if(i===0)await add(db,h.V,'reading',word,eid,i);
    }
  }
  return db;
}
async function add(db,user,domain,word,eid,index){
  const date=index===20?'2026-09-30T12:00:00Z':new Date(Date.parse('2026-10-08T12:00:00Z')-index*1000).toISOString(),source=domain==='reading'?'ctw':'write_email';
  const id=(await db.query(`insert into student_wordbook_entries(student_id,domain,expression,normalized_expression,expression_type,identity_variant,first_saved_at,source_types) values($1,$2,$3,$3,'word','',$4,array[$5]::text[]) returning wordbook_entry_id`,[user,domain,word,date,source])).rows[0].wordbook_entry_id;
  await db.query(`insert into student_wordbook_canonical_links(wordbook_entry_id,student_id,domain,lexical_entry_id,canonical_normalized_expression,canonical_expression_type,canonical_identity_variant,association_kind) values($1,$2,$3,$4,$5,'word','','exact_identity')`,[id,user,domain,eid,word]);
  const x=(await db.query(`insert into student_wordbook_examples(wordbook_entry_id,student_id,domain,example_text,context_kind,source_block_kind,extraction_method,source_types) values($1,$2,$3,$4,'sentence',$5,'verified_sentence_span',array[$6]::text[]) returning example_id`,[id,user,domain,sentence,domain==='reading'?'ctw_paragraph':'email_scenario',source])).rows[0].example_id;
  for(let n=0;n<(index===0?2:1);n++){
    const s=(await db.query(`insert into student_wordbook_senses(wordbook_entry_id,student_id,domain,context_pos,context_meaning_zh,context_definition_en) values($1,$2,$3,$4,$5,$6) returning sense_id`,[id,user,domain,index===0?'adjective':'noun',n===0?'有充分依据的':'了解情况的',n===0?'Based on relevant knowledge and evidence.':'Having useful information.'])).rows[0].sense_id;
    await db.query(`insert into student_wordbook_example_senses values($1,$2,$3,$4,$5)`,[x,s,id,user,domain]);
  }
  await db.query(`insert into student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at) values($1,$2,$3,'first_save',$4)`,[id,user,domain,date]);
  return id;
}
const remove=async(db,ids,domain='reading',user=h.U)=>(await db.query('select delete_student_wordbook_entries_v1($1,$2,$3::uuid[]) result',[user,domain,ids])).rows[0].result;
module.exports={...h,fixture,remove,sentence,read};
