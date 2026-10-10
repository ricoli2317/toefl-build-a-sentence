// Supabase-shaped adapter, backed ONLY by the explicit isolated PGlite fixture.
const args={wordbook_review_availability:['p_student','p_settings'],wordbook_review_create:['p_student','p_settings','p_request','p_parent'],
  wordbook_review_flow_state:['p_student','p_session','p_action','p_item','p_answer'],wordbook_review_history:['p_student','p_page'],
  wordbook_review_submit:['p_student','p_session','p_item','p_answer']};
function client(db){return {
  rpc:async(name,input)=>{try{const values=args[name].map(k=>input[k]&&typeof input[k]==='object'?JSON.stringify(input[k]):input[k]);
    return {data:(await db.query(`select ${name}(${values.map((_,i)=>'$'+(i+1)).join(',')}) result`,values)).rows[0].result};}catch(error){return {error};}},
  from(table){const filters=[],values=[];let columns='*',order='',range='';
    const builder={select(c){columns=c;return builder;},eq(k,v){values.push(v);filters.push(`${k}=$${values.length}`);return builder;},
      in(k,vs){const list=vs.map(v=>{values.push(v);return '$'+values.length;});filters.push(`${k} in (${list.join(',')})`);return builder;},
      order(k){order=` order by ${k}`;return builder;},range(a,b){range=` limit ${b-a+1} offset ${a}`;return builder;},
      then(resolve,reject){return db.query(`select ${columns} from ${table}${filters.length?' where '+filters.join(' and '):''}${order}${range}`,values)
        .then(r=>({data:r.rows})).catch(error=>({error})).then(resolve,reject);}};return builder;}
};}
module.exports={client};
