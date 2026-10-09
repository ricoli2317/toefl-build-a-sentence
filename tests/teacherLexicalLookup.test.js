const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { createMockSupabase } = require('./fixtures/mockSupabase.js');
const { authorizeLexicalSource, lookupAuthorizedSelection, LexicalAccessError } = require('../lib/lexical/lookup.server.ts');
const { parseLookupRequest } = require('../lib/lexical/lookup.ts');
const { operateWordbook } = require('../lib/lexical/wordbook.server.ts');
const { canonicalSourceTextHash } = require('../lib/lexical/hash.ts');
const { WritingReviewWorkspaceServerError } = require('../lib/writingReviewWorkspaceServer.ts');
const { rapSentenceInsertionInstruction, rapSentenceSelectionStem } = require('../lib/reading/rapInteraction.ts');
const teacher = { userId:'teacher',role:'teacher' };
const student = '22222222-2222-4222-8222-222222222222';
const otherStudent = '33333333-3333-4333-8333-333333333333';
const attemptId = '11111111-1111-4111-8111-111111111111';
const sessionId = '44444444-4444-4444-8444-444444444444';
const readingId = type => `reading-${type}-${'a'.repeat(24)}`;
const read = p => fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const readers = {
  fullSetAttempt:async () => { throw new Error('Teacher must not call owned/reconciling RPC'); },
  writingAttempt:async () => { throw new Error('Teacher must not impersonate the student reader'); },
  writingQuestion:async () => { throw new Error('Teacher must use the authorized review source'); },
  basFinalVisible:() => true
};
function database(tables) {
  const base = createMockSupabase(tables);
  const calls = [];
  return { calls, rpc() { throw new Error('Read-only lookup must not invoke an RPC'); }, from(table) {
    const call = { table,filters:[] }; calls.push(call);
    const builder = base.from(table);
    const proxy = new Proxy(builder,{ get(target,key) {
      if (['insert','upsert','update','delete'].includes(key)) return () => { throw new Error('Read-only lookup attempted a write'); };
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (key === 'select') call.columns = args[0];
        if (['eq','in'].includes(key)) call.filters.push([key,...args]);
        const result = value(...args); return result === builder ? proxy : result;
      };
    }});
    return proxy;
  }};
}
function fixture(domains = ['reading','writing']) {
  const tables = {
    profiles:[{ id:student,role:'student',is_active:true }],
    teacher_student_bindings:domains.map(domain => ({ teacher_id:teacher.userId,student_id:student,domain,
      student:{ id:student,role:'student',is_active:true,full_name:'Fixture',email:'fixture@example.invalid' } })),
    reading_logical_items:['ctw','rdl','rap'].map(module => ({ logical_item_id:readingId(module),module })),
    reading_questions:[
      { question_id:'ctw-q',logical_item_id:readingId('ctw'),module:'ctw',question_type:'ctw' },
      { question_id:'rdl-q',logical_item_id:readingId('rdl'),module:'rdl',question_type:'rdl',material_id:'material',stem:'green energy' },
      { question_id:'rap-q',logical_item_id:readingId('rap'),module:'rap',question_type:'rap_multiple_choice',stem:'green energy' },
      { question_id:'insert-q',logical_item_id:readingId('rap'),module:'rap',question_type:'rap_sentence_insertion',insert_sentence:'green energy' },
      { question_id:'select-q',logical_item_id:readingId('rap'),module:'rap',question_type:'rap_sentence_selection',stem:'Click on the sentence that expresses green energy.' }
    ],
    reading_question_options:[{ question_id:'rdl-q',option_id:'a',option_text:'green energy' },{ question_id:'rap-q',option_id:'a',option_text:'green energy' }],
    reading_ctw_paragraphs:[{ paragraph_id:'p',question_id:'ctw-q' }],
    reading_ctw_segments:[{ paragraph_id:'p',segment_order:1,segment_type:'text',text_content:'A ' },
      { paragraph_id:'p',segment_order:2,segment_type:'blank',slot_id:'slot' },
      { paragraph_id:'p',segment_order:3,segment_type:'text',text_content:' energy' }],
    reading_ctw_slots:[{ paragraph_id:'p',slot_id:'slot',answer:'green' }],
    reading_materials:[{ material_id:'material',binding_status:'bound',image_asset_path:'r2/image.png',hitbox_data_path:'r2/selection.json' }],
    reading_passages:[{ passage_id:'passage',logical_item_id:readingId('rap'),title:'green energy' }],
    reading_passage_paragraphs:[{ passage_id:'passage',paragraph_id:'paragraph',paragraph_text:'green energy' }],
    practice_items:['bas','email','academic_discussion'].map(type => ({ item_id:type,task_type:type === 'bas' ? 'build_sentence' : type,
      display_number:'1',display_title:'Fixture',first_seen_date:'2026-01-01',is_active:true })),
    practice_item_sources:[{ source_id:'bas-source',item_id:'bas',task_type:'build_sentence',source_set_id:'set',source_question_id:null,is_canonical:true },
      ...['email','academic_discussion'].map(type => ({ source_id:`${type}-source`,item_id:type,task_type:type,source_set_id:null,source_question_id:`${type}-q`,is_canonical:true }))],
    questions:Array.from({ length:10 },(_,i) => ({ question_id:`bas-q${i+1}`,set_id:'set',question_order:i+1,prompt:'green energy',final_sentence:'green energy' })),
    practice_item_question_map:Array.from({ length:10 },(_,i) => ({ source_id:'bas-source',source_question_id:`bas-q${i+1}`,source_question_order:i+1,logical_question_order:i+1 })),
    email_questions:[{ question_id:'email-q',scenario:'green energy',task_instruction:'green energy',requirement_1:'green energy',requirement_2:'green energy',requirement_3:'green energy',subject:'green energy' }],
    academic_discussion_questions:[{ question_id:'academic_discussion-q',professor_prompt:'green energy',student_1_response:'green energy',student_2_response:'green energy' }]
  };
  return tables;
}
const request = (type = 'rap', block = 'question:rap-q:stem', extra = {}) => ({
  access:{ kind:'teacher_bank',itemId:readingId(type) },teacherReadonly:true,sourceType:type,sourceItemId:readingId(type),
  contentBlockId:block,blockText:'green energy',startOffset:0,endOffset:5,selectedText:'green',...extra
});
function corpus(tables,r,source = r.sourceItemId,block = r.contentBlockId,text = r.blockText,start = r.startOffset) {
  tables.lexical_source_blocks = [{ source_type:r.sourceType,source_item_id:source,content_block_id:block,generation_status:'generated',source_text_hash:canonicalSourceTextHash(text) }];
  tables.lexical_occurrences = [{ occurrence_id:'occ',entry_id:'entry',source_type:r.sourceType,source_item_id:source,content_block_id:block,
    start_offset:start,end_offset:start+r.selectedText.length,surface_text:r.selectedText,review_status:'generated',context_pos:'adjective',context_meaning_zh:'环保的',context_definition_en:'Environmentally friendly.',
    lexical_entries:{ entry_id:'entry',canonical_expression:r.selectedText,normalized_expression:r.selectedText,expression_type:'word',review_status:'generated',lemma:r.selectedText } }];
}
async function authorize(db,r,actor = teacher) {
  assert.ok(parseLookupRequest(r),'fixture must use the real request contract');
  return authorizeLexicalSource(db,db,actor.userId,r,readers,actor);
}
async function matched(tables,r,source,block,text,start) {
  corpus(tables,r,source,block,text,start);
  const db = database(tables);
  const authorized = await authorize(db,r);
  const result = await lookupAuthorizedSelection(db,r,authorized);
  assert.equal(result.status,'matched');
  assert.equal(result.occurrence.source_item_id,source ?? r.sourceItemId);
  assert.equal(result.occurrence.content_block_id,block ?? r.contentBlockId);
  assert.equal(result.occurrence.start_offset,start ?? r.startOffset);
  assert.equal(result.wordbook,undefined);
  assert.equal(db.calls.filter(c => c.table === 'lexical_occurrences').length,1);
  return { db,authorized };
}
test('teacher bank: CTW canonical slot/segment offsets and RDL material/stem/options use the original lookup',async () => {
  await matched(fixture(),request('ctw','paragraph:p',{ blockText:'green',endOffset:5,ctwAnchor:{ kind:'slot',slotId:'slot' } }),undefined,undefined,'A green energy',2);
  await matched(fixture(),request('ctw','paragraph:p',{ blockText:' energy',startOffset:1,endOffset:7,selectedText:'energy',ctwAnchor:{ kind:'text',segmentIndex:2 } }),undefined,undefined,'A green energy',8);
  for (const block of ['material:material','question:rdl-q:stem','question:rdl-q:option:a']) await matched(fixture(),request('rdl',block));
  const tables=fixture();tables.reading_materials[0].binding_status='unbound';
  await assert.rejects(authorize(database(tables),request('rdl','material:material')),LexicalAccessError);
});
test('teacher bank: RAP passage/title, options and special question blocks keep canonical identity',async () => {
  for (const block of ['passage:passage:title','passage:passage:paragraph:paragraph','question:rap-q:stem','question:rap-q:option:a','question:insert-q:insert-sentence']) {
    await matched(fixture(),request('rap',block));
  }
  for (const [block,text] of [['question:insert-q:instruction',rapSentenceInsertionInstruction()],
    ['question:select-q:stem',rapSentenceSelectionStem(fixture().reading_questions.at(-1).stem)]]) {
    const r=request('rap',block,{ blockText:text,startOffset:0,endOffset:1,selectedText:text.slice(0,1) });
    assert.equal((await authorize(database(fixture()),r)).text,text);
  }
});
test('teacher bank: BAS uses existing bas_prompt and canonical final-sentence, not template/chunks',async () => {
  const r=request('bas','prompt',{ access:{ kind:'bas_prompt',questionId:'bas-q2',setId:'set' },sourceItemId:'bas' });
  await matched(fixture(),r,'bas','question:q02:prompt');
  const answer={ ...r,access:{ kind:'teacher_bank',itemId:'bas',questionId:'bas-q2' },contentBlockId:'final-sentence' };
  await matched(fixture(),answer,'bas','question:q02:final-sentence');
  for (const changed of [{ access:{ ...answer.access,questionId:'outside' } },{ contentBlockId:'student-answer' },{ sourceItemId:'other' }]) {
    await assert.rejects(authorize(database(fixture()),{ ...answer,...changed }),LexicalAccessError);
  }
  await assert.rejects(authorize(database(fixture()),{ ...r,contentBlockId:'final-sentence' }),LexicalAccessError);
  for (const change of ['inactive','incomplete','duplicate']) {
    const tables=fixture();
    if(change==='inactive')tables.practice_items[0].is_active=false;
    if(change==='incomplete')tables.practice_item_question_map.pop();
    if(change==='duplicate')tables.practice_item_sources.push({ ...tables.practice_item_sources[0],source_id:'duplicate' });
    await assert.rejects(authorize(database(tables),r),LexicalAccessError);
  }
});
test('teacher bank: WE/AD fields share canonical source validation, scoped to one public item',async () => {
  for (const [type,item,blocks] of [['write_email','email',['scenario','task-instruction','requirement:1','requirement:2','requirement:3']],
    ['academic_discussion','academic_discussion',['professor-prompt','student-response:1','student-response:2']]]) {
    for(const block of blocks) {
      const r=request(type,block,{ access:{ kind:'teacher_bank',itemId:item },sourceItemId:item });
      const {db}=await matched(fixture(),r);
      assert.ok(db.calls.find(c=>c.table==='practice_items').filters.some(f=>f[1]==='item_id'&&f[2]===item));
    }
  }
});
test('ordinary Reading records require active bound students, the right domain, owner and submitted state',async () => {
  for(const type of ['ctw','rdl','rap']) {
    const tables=fixture(); tables.reading_attempts=[{ attempt_id:attemptId,student_id:student,logical_item_id:readingId(type),task_type:type,status:'submitted',submitted_at:'now' }];
    const r=request(type,type==='ctw'?'paragraph:p':`question:${type}-q:stem`,{ access:{ kind:'reading',attemptId,studentId:student },
      ...(type==='ctw'?{ blockText:'green',endOffset:5,ctwAnchor:{ kind:'slot',slotId:'slot' } }:{}) });
    await matched(tables,r,undefined,undefined,type==='ctw'?'A green energy':undefined,type==='ctw'?2:undefined);
  }
  for(const change of ['unbound','wrong-domain','inactive','different-owner','unsubmitted','wrong-source','wrong-block']) {
    const tables=fixture(change==='wrong-domain'?['writing']:['reading']);
    tables.reading_attempts=[{ attempt_id:attemptId,student_id:student,logical_item_id:readingId('rap'),task_type:'rap',status:'submitted',submitted_at:'now' }];
    const r=request('rap',undefined,{ access:{ kind:'reading',attemptId,studentId:student } });
    if(change==='unbound')tables.teacher_student_bindings=[];
    if(change==='inactive')tables.teacher_student_bindings[0].student.is_active=false;
    if(change==='different-owner')r.access.studentId=otherStudent;
    if(change==='unsubmitted')tables.reading_attempts[0].status='in_progress';
    if(change==='wrong-source')r.sourceItemId=readingId('rdl');
    if(change==='wrong-block')r.contentBlockId='question:outside:stem';
    const db=database(tables);await assert.rejects(authorize(db,r),LexicalAccessError);
    assert.equal(db.calls.some(c=>c.table.startsWith('lexical_')),false);
  }
});
test('BAS records retain submitted/question membership and Writing-domain authorization',async () => {
  const tables=fixture();tables.attempts=[{ attempt_id:attemptId,student_id:student,submitted_at:'now' }];
  tables.attempt_answers=[{ attempt_id:attemptId,question_id:'bas-q2',is_correct:false }];
  const r=request('bas','prompt',{ access:{ kind:'bas',attemptId,studentId:student,questionId:'bas-q2' },sourceItemId:undefined });
  for(const block of ['prompt','final-sentence'])await matched(tables,{ ...r,contentBlockId:block },'bas',`question:q02:${block}`);
  for(const change of ['owner','unsubmitted','nonmember']) {
    const broken=structuredClone(tables);
    if(change==='owner')broken.attempts[0].student_id=otherStudent;
    if(change==='unsubmitted')broken.attempts[0].submitted_at=null;
    if(change==='nonmember')broken.attempt_answers=[];
    await assert.rejects(authorize(database(broken),r),LexicalAccessError);
  }
  tables.teacher_student_bindings=tables.teacher_student_bindings.filter(b=>b.domain==='reading');
  await assert.rejects(authorize(database(tables),r),LexicalAccessError);
});
test('Full Set teacher Lookup is SELECT-only and verifies completed owner, both modules and answer membership',async () => {
  const tables=fixture();tables.reading_full_set_attempts=[{ attempt_id:attemptId,student_id:student,status:'completed',completed_at:'now' }];
  tables.reading_full_set_module_attempts=[1,2].map(module_number=>({ attempt_id:attemptId,module_attempt_id:`m${module_number}`,module_number,status:'submitted',submitted_at:'now' }));
  tables.reading_full_set_answers=[{ module_attempt_id:'m1',logical_item_id:readingId('rap'),question_id:'rap-q',answer_id:'a' }];
  const r=request('rap',undefined,{ access:{ kind:'full_set',attemptId,studentId:student } });
  await matched(tables,r);
  for(const type of ['ctw','rdl']) {
    const variant=structuredClone(tables);
    variant.reading_full_set_answers=[{ module_attempt_id:'m2',logical_item_id:readingId(type),question_id:`${type}-q`,answer_id:'member' }];
    const selected=request(type,type==='ctw'?'paragraph:p':'question:rdl-q:stem',{
      access:{kind:'full_set',attemptId,studentId:student},
      ...(type==='ctw'?{blockText:'green',ctwAnchor:{kind:'slot',slotId:'slot'}}:{})
    });
    await matched(variant,selected,undefined,undefined,type==='ctw'?'A green energy':undefined,type==='ctw'?2:undefined);
  }
  for(const change of ['active','module-active','missing-module','no-answer','owner']) {
    const broken=structuredClone(tables);
    if(change==='active')broken.reading_full_set_attempts[0].status='in_progress';
    if(change==='module-active')broken.reading_full_set_module_attempts[0].status='active';
    if(change==='missing-module')broken.reading_full_set_module_attempts.pop();
    if(change==='no-answer')broken.reading_full_set_answers=[];
    if(change==='owner')broken.reading_full_set_attempts[0].student_id=otherStudent;
    await assert.rejects(authorize(database(broken),r),LexicalAccessError);
  }
});
test('wrongbook single/session and RAP category retain distinct source/targets/progress semantics',async () => {
  const tables=fixture();const item=readingId('rap');const group={ logicalItemId:item,targets:[{ questionId:'rap-q' }] };
  tables.reading_wrongbook_attempts=[{ attempt_id:attemptId,student_id:student,logical_item_id:item,task_type:'rap',status:'submitted',submitted_at:'now',targets:group.targets }];
  tables.student_wrong_question_sessions=[{ session_id:sessionId,student_id:student,task_type:'rap',manifest:{ groups:[group] },progress:{ [item]:{ attemptId } } }];
  const r=request('rap',undefined,{ access:{ kind:'reading_wrongbook',attemptId,studentId:student } });
  await matched(tables,r);await matched(tables,{ ...r,access:{ ...r.access,sessionId } });
  const incomplete=structuredClone(tables);incomplete.student_wrong_question_sessions[0].manifest.groups.push({ logicalItemId:'unloaded',taskType:'rap',targets:[] });
  await assert.rejects(authorize(database(incomplete),{ ...r,access:{ ...r.access,sessionId } }),e=>e.status===409);
  await assert.rejects(authorize(database(incomplete),r),e=>e.status===409,'omitting sessionId cannot expose a partial session');
  const wrong=structuredClone(tables);wrong.student_wrong_question_sessions[0].progress[item].attemptId=sessionId;
  await assert.rejects(authorize(database(wrong),{ ...r,access:{ ...r.access,sessionId } }),LexicalAccessError);
  tables.reading_question_category_sessions=[{ session_id:sessionId,student_id:student,status:'completed',completed_at:'now',manifest:{ groups:[group] },progress:{ [item]:{ submittedAt:'now' } } }];
  const category={ ...r,access:{ kind:'reading_category',attemptId:sessionId,studentId:student } };
  await matched(tables,category);
  const missingProgress=structuredClone(tables);missingProgress.reading_question_category_sessions[0].progress={};
  await assert.rejects(authorize(database(missingProgress),category),LexicalAccessError);
  const emptyProgress=structuredClone(tables);emptyProgress.reading_question_category_sessions[0].progress[item]={};
  await assert.rejects(authorize(database(emptyProgress),category),LexicalAccessError);
  tables.reading_question_category_sessions[0].status='active';await assert.rejects(authorize(database(tables),category),e=>e.status===409);
  tables.reading_question_category_sessions[0].status='completed';tables.reading_question_category_sessions[0].manifest.groups[0].targets=[];
  await assert.rejects(authorize(database(tables),category),LexicalAccessError);
});
test('WE/AD workspaces reuse writing review permissions, preserve snapshots and reject custom/stale/unsubmitted/other teacher',async () => {
  for(const [task,type,block] of [['email','write_email','scenario'],['academic_discussion','academic_discussion','student-response:1']]) {
    const tables=fixture();tables.writing_attempts=[{ attempt_id:attemptId,user_id:student,task_type:task,question_id:`${task}-q`,assignment_id:null,status:'submitted',submitted_at:'now' }];
    const r=request(type,block,{ access:{ kind:'writing',attemptId,studentId:student },sourceItemId:undefined });
    await matched(tables,r,task);
    for(const change of ['reading-only','unbound','inactive','owner']) {
      const broken=structuredClone(tables);
      if(change==='reading-only')broken.teacher_student_bindings=broken.teacher_student_bindings.filter(b=>b.domain==='reading');
      if(change==='unbound')broken.teacher_student_bindings=[];
      if(change==='inactive')broken.profiles[0].is_active=false;
      if(change==='owner')broken.writing_attempts[0].user_id=otherStudent;
      await assert.rejects(authorize(database(broken),r),e=>e instanceof LexicalAccessError||e instanceof WritingReviewWorkspaceServerError);
    }
    const raw={ ...structuredClone(tables[task==='email'?'email_questions':'academic_discussion_questions'][0]),year_month:'202601',source_labels:'Fixture' };
    // Snapshot validator also requires the fields supplied by the normal assignment UI.
    const snapshot=task==='email'?{ ...raw,set_id:'set',set_title:'Fixture',scenario:'green energy',task_instruction:'green energy',requirement_1:'green energy',requirement_2:'green energy',requirement_3:'green energy',closing_instruction:'Write.',recipient:'Teacher',subject:'green energy' }
      :{ ...raw,set_id:'set',set_title:'Fixture',professor_name:'Professor',student_1_name:'One',student_2_name:'Two' };
    tables.writing_assignments=[{ assignment_id:'assignment',teacher_id:teacher.userId,task_type:task,question_source:'question_bank',question_snapshot:snapshot }];
    tables.writing_attempts[0].assignment_id='assignment';
    tables.teacher_student_bindings=[];await matched(tables,r,task); // own assignment, not domain-based
    const mismatch=structuredClone(tables);mismatch.writing_assignments[0].question_snapshot.question_id='outside';
    await assert.rejects(authorize(database(mismatch),r),LexicalAccessError);
    tables.writing_assignments[0].teacher_id='other-teacher';
    tables.teacher_student_bindings=fixture().teacher_student_bindings;
    await assert.rejects(authorize(database(tables),r),WritingReviewWorkspaceServerError);
    tables.writing_assignments[0].teacher_id=teacher.userId;
    tables.writing_assignments[0].question_source='custom';await assert.rejects(authorize(database(tables),r),LexicalAccessError);
    tables.writing_assignments[0].question_source='question_bank';
    tables.writing_assignments[0].question_snapshot[task==='email'?'scenario':'student_1_response']='changed snapshot';
    const db=database(tables);const source=await authorize(db,r);assert.equal((await lookupAuthorizedSelection(db,r,source)).status,'unavailable');
    tables.writing_attempts[0].status='draft';await assert.rejects(authorize(database(tables),r),e=>e.status===409);
  }
});
test('teaching proof cannot authorize Wordbook save/remove/status or be downgraded to student ownership',async () => {
  const requests=[request(),request('bas','prompt',{ access:{ kind:'bas_prompt',setId:'set',questionId:'bas-q2' },sourceItemId:'bas' }),
    request('rap',undefined,{ access:{ kind:'reading',attemptId,studentId:student } })];
  for(const r of requests) {
    const db=database(fixture());
    await assert.rejects(authorizeLexicalSource(db,db,teacher.userId,r,readers),LexicalAccessError);
    for(const action of ['save','remove','status'])await assert.rejects(operateWordbook(db,db,teacher.userId,r,'entry','occ',action,readers),LexicalAccessError);
    assert.equal(db.calls.length,0,'Wordbook must reject teaching context before even reading status/corpus');
    await assert.rejects(authorize(db,r,{ userId:student,role:'student' }),LexicalAccessError);
    if(r.access.kind==='teacher_bank'||r.access.studentId)assert.equal(parseLookupRequest({ ...r,teacherReadonly:false }),null);
  }
  const invalid=request();for(const change of [{ selectedText:'wrong' },{ startOffset:-1 },{ endOffset:999 },{ teacherReadonly:'true' }])assert.equal(parseLookupRequest({ ...invalid,...change }),null);
});

function compile(relative,mocks,source = read(relative)) {
  const filename=path.join(__dirname,'..',relative);
  const js=ts.transpileModule(source,{ compilerOptions:{ jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true },fileName:filename }).outputText;
  const original=Module._load;Module._load=function(name,parent,isMain){ return Object.hasOwn(mocks,name)?mocks[name]:original.call(this,name,parent,isMain); };
  try { const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.join(__dirname,'..'));loaded._compile(js,filename);return loaded.exports; }
  finally { Module._load=original; }
}
test('actual Lookup route authenticates teaching role and never reads student Wordbook status',async () => {
  let authenticated=false;let actor={ error:null,...teacher };let statusReads=0;let sourceReads=0;
  const route=compile('app/api/lexical/lookup/route.ts',{
    '@/lib/reading/attemptServer':{ requireReadingAttemptStudent:async()=>authenticated?{ error:null,client:{},userId:actor.userId }:{ error:new Response('{}',{status:401}) },readingAttemptJson:(v,init)=>new Response(JSON.stringify(v),init) },
    '@/lib/auth':{ bearerToken:()=>null,requireTeacherOnly:async()=>actor },
    '@/lib/supabase/server':{ createServiceSupabase:()=>({}) },'@/lib/lexical/lookup':{ parseLookupRequest },
    '@/lib/lexical/lookup.server':{ LexicalAccessError,authorizeLexicalSource:async(...args)=>{sourceReads++;assert.equal(args[5].role,'teacher');return {};},lookupAuthorizedSelection:async()=>({status:'unmatched'}) },
    '@/lib/lexical/wordbook.server':{ addWordbookStatus:async()=>{statusReads++;throw new Error('Teacher lookup must not read Wordbook status');} },
    '@/lib/writingReviewWorkspaceServer':{ WritingReviewWorkspaceServerError },'@/lib/reading/fullSetAttemptServer':{},'@/lib/writingServer':{}
  });
  const send=()=>route.POST(new Request('http://localhost/api/lexical/lookup',{ method:'POST',body:JSON.stringify(request()) }));
  assert.equal((await send()).status,401);assert.equal(sourceReads,0);
  authenticated=true;actor={error:'Forbidden',userId:student,role:'student'};assert.equal((await send()).status,403);assert.equal(sourceReads,0);
  actor={error:null,...teacher};const result=await send();assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:'unmatched'});assert.equal(statusReads,0);
});
test('actual Lookup and Wordbook routes keep teaching access read-only with real authorization',async () => {
  const tables=fixture();let db=database(tables);let actor={error:null,...teacher};let statusReads=0;
  const common={
    '@/lib/reading/attemptServer':{ requireReadingAttemptStudent:async()=>({ error:null,client:db,userId:actor.userId }),readingAttemptJson:(v,init)=>new Response(JSON.stringify(v),init) },
    '@/lib/auth':{ bearerToken:()=>null,requireTeacherOnly:async()=>actor },
    '@/lib/supabase/server':{ createServiceSupabase:()=>db },'@/lib/lexical/lookup':{ parseLookupRequest },
    '@/lib/lexical/lookup.server':require('../lib/lexical/lookup.server.ts'),
    '@/lib/lexical/wordbook.server':{ operateWordbook,addWordbookStatus:async()=>{statusReads++;throw new Error('No teacher status reads');} },
    '@/lib/lexical/wordbookContext':require('../lib/lexical/wordbookContext.ts'),
    '@/lib/writingReviewWorkspaceServer':{ WritingReviewWorkspaceServerError },
    '@/lib/reading/fullSetAttemptServer':{loadOwnedReadingFullSetAttempt:readers.fullSetAttempt},
    '@/lib/writingServer':{readOwnedWritingAttempt:readers.writingAttempt,readWritingQuestion:readers.writingQuestion}
  };
  const lookup=compile('app/api/lexical/lookup/route.ts',common);
  const wordbook=compile('app/api/lexical/wordbook/route.ts',common);
  const send=(route,body)=>route.POST(new Request('http://localhost/api/lexical/lookup',{method:'POST',body:JSON.stringify(body)}));
  const r=request();corpus(tables,r);
  assert.equal((await send(lookup,r)).status,200);assert.equal(statusReads,0);
  for(const action of ['save','remove','status']) {
    db=database(tables);const response=await send(wordbook,{action,selection:r,entryId:attemptId,occurrenceId:sessionId});
    assert.equal(response.status,403);assert.equal(db.calls.length,0);
  }
  assert.equal((await send(lookup,{...r,endOffset:999})).status,400);
  assert.equal((await send(lookup,{...r,contentBlockId:'question:outside:stem'})).status,403);
  tables.reading_attempts=[{attempt_id:attemptId,student_id:student,logical_item_id:readingId('rap'),task_type:'rap',status:'submitted',submitted_at:'now'}];
  const record={...r,access:{kind:'reading',attemptId,studentId:student}};
  db=database(tables);assert.equal((await send(lookup,record)).status,200);
  tables.teacher_student_bindings=[];db=database(tables);assert.equal((await send(lookup,record)).status,403);
  tables.teacher_student_bindings=fixture().teacher_student_bindings;tables.reading_attempts[0].status='in_progress';
  db=database(tables);assert.equal((await send(lookup,record)).status,409);
  actor={error:'Forbidden',userId:student,role:'student'};assert.equal((await send(lookup,r)).status,403);
});
test('entry wiring and compact WE/AD markup keep lookup physically inside QuestionColumn',() => {
  const workspace=read('components/teacher/TeacherWritingReviewWorkspace.tsx');
  assert.match(workspace,/<LexicalLookupProvider teacherReadonly enabled=\{data.question_source === "question_bank"\}[\s\S]*?<QuestionColumn[\s\S]*?<\/LexicalLookupProvider>\s*<section className="writing-review-column/);
  assert.match(workspace,/onMouseUp=\{captureArticleSelection\}/);
  const start=workspace.indexOf('function QuestionColumn');const end=workspace.indexOf('function AnnotatedText');
  const markup=compile('components/teacher/TeacherWritingReviewWorkspace.tsx',{
    '@/components/lexical/LexicalLookup':{ LexicalText:({blockId,text})=>React.createElement('span',{'data-lexical-block':blockId},text) }
  },'import { LexicalText } from "@/components/lexical/LexicalLookup";\n'+workspace.slice(start,end)+'\nexport { CompactEmailQuestion, AcademicQuestionContent };');
  const emailHtml=renderToStaticMarkup(React.createElement(markup.CompactEmailQuestion,{question:fixture().email_questions[0]}));
  const adHtml=renderToStaticMarkup(React.createElement(markup.AcademicQuestionContent,{question:{...fixture().academic_discussion_questions[0],professor_name:'Professor',student_1_name:'One',student_2_name:'Two'}}));
  for(const id of ['scenario','task-instruction','requirement:1','requirement:2','requirement:3'])assert.ok(emailHtml.includes(`data-lexical-block="${id}"`));
  for(const id of ['professor-prompt','student-response:1','student-response:2'])assert.ok(adHtml.includes(`data-lexical-block="${id}"`));
  assert.ok(start<end);
  for(const id of ['scenario','task-instruction','requirement:1','requirement:2','requirement:3','professor-prompt','student-response:1','student-response:2'])assert.ok(workspace.slice(start,end).includes(`"${id}"`));
  assert.match(read('components/teacher/TeacherReadingQuestionBank.tsx'),/lookupEnabled\s+teacherReadonly\s+lexicalAccess=\{\{ kind: "teacher_bank", itemId \}\}/);
  assert.match(read('app/api/teacher/question-bank/reading/route.ts'),/skipRdlAssetVerification: false/);
  assert.match(read('lib/assignmentCatalog.ts'),/taskType=\$\{entry.item_type\}&preview=1/);
  assert.match(read('components/teacher/TeacherStudentReadingAttemptDetail.tsx'),/kind === "category" \? \{ kind: "reading_category", attemptId, studentId \}/);
  assert.match(read('components/reading/ReadingPractice.tsx'),/sessionId: payload.attempt.attemptId/);
  assert.match(read('components/TeacherDashboard.tsx'),/teacherStudentId=\{detail.student.studentId\}/);
  assert.match(read('lib/teacherStudentPractice.ts'),/href: `\/teacher\/writing\/reviews\//);
  const lookup=read('components/lexical/LexicalLookup.tsx');
  // The context-save intent requires a no-argument toggle wrapper. Both
  // mutation callbacks must still be absent from Teacher read-only cards.
  assert.match(lookup,/onWordbookToggle=\{teacherReadonly \? undefined : \(\) => void toggleWordbook\(\)\}/);
  assert.match(lookup,/onWordbookSaveContext=\{teacherReadonly \? undefined : \(\) => void toggleWordbook\("save"\)\}/);
});
