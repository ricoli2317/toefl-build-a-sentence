const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { fixture, client, source, read, sourcePath, U, V, T, A, X } = require('./helpers/ctwVocabularyFixture.cjs');
const model = require('../lib/ctw-vocabulary/model.ts');
const input = require('../lib/ctw-vocabulary/input.ts');
const importer = require('../lib/ctw-vocabulary/import.ts');
const store = require('../lib/ctw-vocabulary/store.server.ts');
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const submit = (entry, spelling = entry.word, attemptId = ID) =>
  input.parseAttemptSubmission({ attemptId, mode: 'base_form', answers: [{ entryId: entry.entry_id, spelling }] });
const appendRow = (word, example = "It's a future word.") => ({ word, list_id: 'List 01', cefr: 'B2',
  senses: [{ pos: 'noun', meaning_zh: '增量测试', example_en: example }], irregular_forms: [] });
async function append(db, rows) {
  const bytes = Buffer.from(JSON.stringify(rows));
  await db.exec(importer.buildVocabularyImportSql(rows, sha(bytes), 'append'));
}

test('authoritative input: exact SHA, reviewed CEFR, 1032 words/21 Lists/1152 senses/47 irregular words/91 groups', () => {
  const { rows, sha256 } = source();
  assert.equal(sha256, importer.REVIEWED_SOURCE_SHA256);
  assert.equal(rows.length, 1032);
  assert.equal(rows.reduce((n,r) => n+r.senses.length,0), 1152);
  assert.equal(rows.filter(r => r.irregular_forms.length).length, 47);
  assert.equal(rows.reduce((n,r) => n+r.irregular_forms.length,0), 91);
  assert.equal(new Set(rows.map(r=>r.list_id)).size,21);
  assert.equal(rows.find(r=>r.word==='leaf').cefr,'B1');
  assert.equal(rows.find(r=>r.word==='archaeologist').cefr,'C1');
  assert.ok(rows.some(r=>r.word==='European'));
  assert.ok(rows.some(r=>r.word==='per capita'));
  const before = JSON.stringify(rows); importer.validateReviewedRows(rows); assert.equal(JSON.stringify(rows),before);
  assert.throws(()=>importer.loadVocabularySource(Buffer.from(JSON.stringify(rows)),'initial'), /SHA-256/);
});

test('strict import validation rejects duplicate/unknown CEFR/POS/forms/empty content and never repairs data', () => {
  for (const mutate of [
    r=>r.push({ ...r[0], word:r[0].word.toUpperCase() }),
    r=>r[0].cefr='A0', r=>r[0].list_id='List 1', r=>r[0].word=' run ',
    r=>r[0].senses[0].meaning_zh='', r=>r[0].senses[0].pos='invalid',
    r=>r[0].irregular_forms[0].answers=[], r=>r[0].irregular_forms.push(r[0].irregular_forms[0]),
    r=>r[0].irregular_forms[0].form_type='future', r=>r[0].extra=true,
    r=>r[0].senses[0].example_en='\0'
  ]) {
    const rows=structuredClone(source().rows); mutate(rows);
    assert.throws(()=>importer.validateReviewedRows(rows));
  }
  assert.throws(()=>importer.validateReviewedRows([]));
});

test('browser grading reuses wordbook normalization, ignores POS and preserves hyphens/phrase spacing', () => {
  assert.equal(model.normalizeVocabularySpelling, require('../lib/lexical/wordbookReviewLocal.ts').normalizeReviewSpelling);
  for (const row of source().rows) {
    assert.equal(model.gradeVocabularySpelling(row,'base_form',`\t${row.word.toUpperCase()}\n`),true,row.word);
    assert.equal(model.gradeVocabularySpelling(row,'base_form',`${row.word}x`),false,row.word);
    for (const form of row.irregular_forms)
      for (const answer of form.answers)
        assert.equal(model.gradeVocabularySpelling(row,'irregular',answer.toUpperCase(),form.form_type),true);
  }
  assert.equal(model.gradeVocabularySpelling({word:'long-term',irregular_forms:[]},'base_form','long term'),false);
  assert.equal(model.gradeVocabularySpelling({word:'per capita',irregular_forms:[]},'base_form','per\tcapita'),true);
  assert.equal(model.gradeVocabularySpelling({word:'per capita',irregular_forms:[]},'base_form','percapita'),false);
  assert.throws(()=>model.gradeVocabularySpelling({word:'leaf',irregular_forms:[]},'irregular','leaves','plural'));
});

test('existing one-letter-per-blank input removes editable whitespace and restores fixed phrase spaces before grading', () => {
  const { spellingInputValue, formatReviewSpelling, spellingLetterLimit, insertReviewSpelling } = require('../lib/lexical/wordbookReviewInput.ts');
  const { spellingShape } = require('../lib/lexical/wordbookReviewPresentation.ts');
  const entry = source().rows.find(r=>r.word==='per capita'), shape = spellingShape(entry.word);
  assert.equal(shape,'___ ______');
  assert.equal(spellingInputValue(entry.word),'percapita');
  assert.equal(spellingLetterLimit(shape),9);
  assert.equal(formatReviewSpelling(shape,'percapita'),'per capita');
  const edit = insertReviewSpelling(shape,'',0,0,'per capita extra');
  assert.equal(edit.value,'per capita');
  assert.equal(model.gradeVocabularySpelling(entry,'base_form',edit.value),true);
});

test('owner-free, score-free strict requests; duplicate items and oversized answers rejected', () => {
  const base={attemptId:ID, mode:'base_form', answers:[{entryId:ID2, spelling:''}]};
  assert.equal(input.parseAttemptSubmission(base).answers[0].spelling,'');
  for (const bad of [{...base,student_id:V},{...base,correctCount:1},{...base,mode:'spelling_pos'},
    {...base,answers:[]},{...base,answers:[...base.answers,...base.answers]},
    {...base,answers:[{entryId:ID2,spelling:'ok',pos:'noun'}]},
    {...base,answers:[{entryId:ID2,spelling:'ok',correct:true}]},
    {...base,answers:[{entryId:ID2,spelling:'ok',formType:'plural'}]},
    {...base,answers:[{entryId:ID2,spelling:'a'.repeat(201)}]},
    {...base,answers:[{entryId:ID2,spelling:'\0'}]},
    {...base,mode:'irregular'}]) assert.throws(()=>input.parseAttemptSubmission(bad));
  assert.throws(()=>input.parseAttemptSubmission({...base,answers:Array.from({length:201},()=>base.answers[0])}));
  assert.deepEqual(input.parseWordQuery(new URLSearchParams('list=21&cefr=C1&page=2&pageSize=10')),
    {list:21,cefr:'C1',page:2,pageSize:10});
  for (const q of ['student_id=x','list=0','cefr=c1','page=1.2','pageSize=51','list=1&list=2','page=','sort=bad'])
    assert.throws(()=>input.parseWordQuery(new URLSearchParams(q)));
  for (const q of ['student_id=x','page=0','pageSize=51','page=1&page=2'])
    assert.throws(()=>input.parseHistoryQuery(new URLSearchParams(q)));
});

test('manual SQL installs and imports exactly, verifies all fields/order and leaves legacy sentinels unchanged', async () => {
  const db=await fixture(); try {
    await db.exec(read('supabase/ctw_vocabulary_v1_verify.sql'));
    const actual=(await db.query(`select word,'List '||lpad(list_number::text,2,'0') list_id,cefr,senses,irregular_forms
      from ctw_vocabulary_entries order by list_number,list_position`)).rows;
    assert.deepEqual(actual,source().rows);
    for (const [table,value] of [['lexical_entries','lexical'],['reading_ctw_canonical','ctw'],['student_wordbook_entries','wordbook']])
      assert.deepEqual((await db.query(`select content from ${table}`)).rows,[{content:{unchanged:value}}]);
    await assert.rejects(db.exec(read('supabase/ctw_vocabulary_v1_preflight.sql')),/ALREADY_INSTALLED/);
    await assert.rejects(db.exec(read('supabase/ctw_vocabulary_v1_migration.sql')),/already exists/);
    await db.exec('rollback');
    const {rows,sha256}=source();
    await assert.rejects(db.exec(importer.buildVocabularyImportSql(rows,sha256,'initial')),/REQUIRES_EMPTY/);
    await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from ctw_vocabulary_entries')).rows[0].n,1032);
  } finally { await db.close(); }
});

test('append: skip existing words case-insensitively, fill List 21, create List 22, preserve IDs/content/order and rerun safely', async () => {
  const db=await fixture(); try {
    const before=(await db.query('select * from ctw_vocabulary_entries order by list_number,list_position')).rows;
    const old=source().rows[0];
    const rows=[{...old,word:old.word.toUpperCase(),cefr:'C2',senses:[{...old.senses[0],meaning_zh:'不可覆盖'}]},
      ...Array.from({length:20},(_,i)=>appendRow(`future${String.fromCharCode(97+i)}`))];
    await append(db,rows);
    const after=(await db.query('select * from ctw_vocabulary_entries order by list_number,list_position')).rows;
    assert.deepEqual(after.slice(0,1032),before);
    assert.deepEqual(after.slice(1032).map(r=>[r.list_number,r.list_position]),
      [...Array.from({length:18},(_,i)=>[21,33+i]),[22,1],[22,2]]);
    await append(db,rows);
    assert.deepEqual((await db.query('select * from ctw_vocabulary_entries order by list_number,list_position')).rows,after);
    await append(db,[appendRow('safetest',"It's $ctw_import$ safe; \\ literal text.")]);
    assert.equal((await db.query("select senses->0->>'example_en' example from ctw_vocabulary_entries where word='safetest'")).rows[0].example,
      "It's $ctw_import$ safe; \\ literal text.");
  } finally { await db.close(); }
});

test('append atomic failure rejects invalid content, empty baseline and damaged List layouts without partial writes', async () => {
  const db=await fixture(); try {
    const valid=appendRow('firstappend'), invalid=appendRow('secondappend');
    const sql=importer.buildVocabularyImportSql([valid,invalid],sha(Buffer.from('synthetic')),'append')
      .replace('"word":"secondappend"','"word":"invalid  word"');
    await assert.rejects(db.exec(sql),/check constraint/); await db.exec('rollback');
    assert.equal((await db.query('select count(*)::int n from ctw_vocabulary_entries')).rows[0].n,1032);
    await db.exec('delete from ctw_vocabulary_entries where list_number=1 and list_position=1');
    await assert.rejects(append(db,[valid]),/REVIEWED_BASELINE_REQUIRED|LAYOUT_INVALID/);await db.exec('rollback');
  } finally { await db.close(); }
  const empty=await fixture({seed:false});try {
    await assert.rejects(append(empty,[appendRow('word')]),/INITIAL_IMPORT_REQUIRED/); await empty.exec('rollback');
  } finally { await empty.close(); }
});

test('catalog and word pages use RLS, stable List ordering and intersection filters; never load practice history', async () => {
  const db=await fixture();try {
    const calls=[], student=client(db,'authenticated',U,calls);
    const catalog=await store.readVocabularyCatalog(student);
    assert.equal(catalog.total,1032);assert.equal(catalog.lists[20].count,32);
    const result=await store.readVocabularyWords(student,{list:21,cefr:null,page:1,pageSize:10});
    assert.equal(result.items.length,10);assert.equal(result.hasMore,true);
    assert.deepEqual(result.items.map(r=>r.list_position),[1,2,3,4,5,6,7,8,9,10]);
    const filtered=await store.readVocabularyWords(student,{list:1,cefr:'C1',page:1,pageSize:50});
    assert.ok(filtered.items.length>0);assert.ok(filtered.items.every(r=>r.list_number===1&&r.cefr==='C1'));
    assert.equal(calls.some(c=>c.sql.includes('student_ctw_vocabulary_attempts')),false);
    const anon=client(db,'anon',U);await assert.rejects(store.readVocabularyWords(anon,{list:null,cefr:null,page:1,pageSize:50}));
    assert.equal((await store.readVocabularyCatalog(client(db,'authenticated',X))).total,0);
  } finally { await db.close(); }
});

test('round submit grades in shared JS once, inserts once, stores immutable snapshots and retries idempotently', async () => {
  const db=await fixture();try {
    const entries=(await db.query("select * from ctw_vocabulary_entries where word in ('get','long-term','per capita') order by word")).rows;
    const submission=input.parseAttemptSubmission({attemptId:ID,mode:'base_form',answers:entries.map((e,i)=>
      ({entryId:e.entry_id,spelling:i===1?'wrong':e.word.toUpperCase()}))});
    const calls=[], service=client(db,'service_role',U,calls);
    const result=await store.saveVocabularyAttempt(service,U,submission);
    assert.equal(result.answer_count,3);assert.equal(result.correct_count,2);
    assert.equal(calls.filter(c=>c.operation==='insert').length,1);
    assert.equal(calls.filter(c=>c.operation==='select'&&c.sql.includes('ctw_vocabulary_entries')).length,1);
    assert.equal(calls.some(c=>c.operation==='rpc'),false);
    assert.equal(result.answers[0].senses.length>0,true);
    const again=await store.saveVocabularyAttempt(service,U,submission);assert.deepEqual(again,result);
    assert.equal(calls.filter(c=>c.operation==='insert').length,1);
    await assert.rejects(store.saveVocabularyAttempt(service,U,{...submission,answers:[{...submission.answers[0],spelling:'changed'}]}),/CONFLICT/);
    await assert.rejects(store.saveVocabularyAttempt(service,U,submit({...entries[0],entry_id:ID2},'fake',ID2)),/ENTRY_NOT_FOUND/);
    await db.query("update ctw_vocabulary_entries set senses=$1::jsonb where entry_id=$2",[JSON.stringify([{pos:'verb',meaning_zh:'管理员修改测试',example_en:'Changed.'}]),entries[0].entry_id]);
    assert.deepEqual(await store.readVocabularyResult(client(db,'authenticated',U),U,ID),result);
  } finally { await db.close(); }
});

test('all 91 irregular groups accept reviewed alternatives, base forms not automatically accepted and no POS grading', async () => {
  const db=await fixture();try {
    const entries=(await db.query('select * from ctw_vocabulary_entries where jsonb_array_length(irregular_forms)>0 order by list_number,list_position')).rows;
    const raw={attemptId:ID,mode:'irregular',answers:entries.flatMap(e=>e.irregular_forms.map(f=>
      ({entryId:e.entry_id,formType:f.form_type,spelling:f.answers.at(-1).toUpperCase()})))};
    const result=await store.saveVocabularyAttempt(client(db,'service_role'),U,input.parseAttemptSubmission(raw));
    assert.equal(result.answer_count,91);assert.equal(result.correct_count,91);
    const leaf=entries.find(e=>e.word==='leaf');
    const wrong=input.parseAttemptSubmission({attemptId:ID2,mode:'irregular',answers:[{entryId:leaf.entry_id,formType:'plural',spelling:'leaf'}]});
    assert.equal((await store.saveVocabularyAttempt(client(db,'service_role'),U,wrong)).correct_count,0);
    await assert.rejects(store.saveVocabularyAttempt(client(db,'service_role'),V,{...wrong,answers:[{...wrong.answers[0],formType:'past'}]}),/INVALID_FORM_TYPE/);
  } finally { await db.close(); }
});

test('concurrent retry insert conflict returns existing matching result; reused id with other answers is 409 conflict', async () => {
  const entry={entry_id:ID2,word:'get',list_number:1,list_position:1,cefr:'A1',senses:[],irregular_forms:[],source_sha256:importer.REVIEWED_SOURCE_SHA256};
  const submission=submit(entry);
  const stored={attempt_id:ID,mode:'base_form',answer_count:1,correct_count:1,submitted_at:'2026-10-14T00:00:00Z',
    list_numbers:[1],cefr_levels:['A1'],request_answers:submission.answers,answers:store.gradeVocabularyBatch([entry],submission)};
  function raced(result) {
    let reads=0;
    return {from:table=>{
      const b={select:()=>b,eq:()=>b,in:()=>b,insert:()=>b,
        maybeSingle:async()=>({data:++reads===1?null:result,error:null}),
        single:async()=>({data:null,error:{code:'23505'}}),
        then:(resolve,reject)=>Promise.resolve({data:table==='ctw_vocabulary_entries'?[entry]:null,error:null}).then(resolve,reject)};
      return b;
    }};
  }
  const result=await store.saveVocabularyAttempt(raced(stored),U,submission);
  assert.equal(result.correct_count,1);assert.equal(Object.hasOwn(result,'request_answers'),false);
  await assert.rejects(store.saveVocabularyAttempt(raced({...stored,request_answers:[{entryId:ID2,spelling:'other'}]}),U,submission),/CONFLICT/);
});

test('student isolation: self-only reads, cross-student 404, no direct forged inserts/updates/deletes, disabled users denied', async () => {
  const db=await fixture();try {
    const entry=(await db.query('select * from ctw_vocabulary_entries limit 1')).rows[0];
    const service=client(db,'service_role');
    await store.saveVocabularyAttempt(service,U,submit(entry));
    await store.saveVocabularyAttempt(service,V,submit(entry)); // same UUID, different owners
    for (const user of [T,A]) await store.saveVocabularyAttempt(service,user,submit(entry));
    for (const user of [U,V,T,A]) {
      const c=client(db,'authenticated',user);
      const result=await store.readVocabularyHistory(c,user,{page:1,pageSize:1});
      assert.equal(result.items.length,1);assert.equal(result.hasMore,false);
      assert.equal(Object.hasOwn(result.items[0],'answers'),false);
      await assert.rejects(store.readVocabularyResult(c,user===U?V:U,ID),/RESULT_NOT_FOUND/);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');
      assert.equal((await db.query('select student_id from student_ctw_vocabulary_attempts')).rows[0].student_id,user);
      for (const sql of ["insert into student_ctw_vocabulary_attempts(student_id,attempt_id) values('"+user+"','"+ID2+"')",
        'update student_ctw_vocabulary_attempts set correct_count=0','delete from student_ctw_vocabulary_attempts',
        "update ctw_vocabulary_entries set cefr='C2'"]) await assert.rejects(db.exec(sql),/permission denied/);
      await db.exec('reset role');
    }
    assert.equal((await store.readVocabularyHistory(client(db,'authenticated',X),X,{page:1,pageSize:20})).items.length,0);
    await db.query('update profiles set is_active=false where id=$1',[U]);
    await assert.rejects(store.readVocabularyResult(client(db,'authenticated',U),U,ID),/RESULT_NOT_FOUND/);
  } finally { await db.close(); }
});

test('history only fetches bounded summaries; details fetched separately and missing schema is not faked as empty', async () => {
  const db=await fixture();try {
    const entry=(await db.query('select * from ctw_vocabulary_entries limit 1')).rows[0];
    await store.saveVocabularyAttempt(client(db,'service_role'),U,submit(entry));
    await store.saveVocabularyAttempt(client(db,'service_role'),U,submit(entry,'',ID2));
    const calls=[], c=client(db,'authenticated',U,calls);
    const first=await store.readVocabularyHistory(c,U,{page:1,pageSize:1});
    const second=await store.readVocabularyHistory(c,U,{page:2,pageSize:1});
    assert.equal(first.hasMore,true);assert.equal(second.hasMore,false);
    assert.notEqual(first.items[0].attempt_id,second.items[0].attempt_id);
    assert.ok(calls.every(r=>!r.sql.includes('answers')&&r.sql.includes('limit 2')));
    await store.readVocabularyResult(c,U,ID);assert.ok(calls.at(-1).sql.includes(',answers'));
    await assert.rejects(store.readVocabularyCatalog({rpc:async()=>({data:null,error:{code:'PGRST202'}})}),/UNAVAILABLE/);
  } finally { await db.close(); }
});

// Execute the actual Next route exports with dependency injection, offline.
function route(file, dependencies) {
  const exported={}, ts=require('typescript');
  vm.runInNewContext(ts.transpileModule(read(file),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,
    {exports:exported,URL,Request,Error,JSON,require:name=> {
      const value=dependencies[Object.keys(dependencies).find(key=>name.endsWith(key))];
      if (!value) throw Error('Unexpected import '+name);return value;
    }});
  return exported;
}
test('actual routes authenticate first, reject forged owner/score fields before service key and separate catalog/history/detail', async () => {
  let allowed=false, serviceCalls=0;const calls=[];
  const deps={
    'http.server':{vocabularyRoute:async(req,fn)=>{
      if(!allowed)return {status:401};
      try {return {status:200,data:await fn({ownToken:true},U)};}
      catch(e){return {status:e instanceof input.VocabularyInputError||e instanceof SyntaxError?400:500};}
    }},
    'input':input,
    'supabase/server':{createServiceSupabase:()=>{serviceCalls++;return {trustedService:true};}},
    'store.server':Object.fromEntries(['readVocabularyCatalog','readVocabularyWords','readVocabularyHistory','readVocabularyResult','saveVocabularyAttempt']
      .map(name=>[name,async(...args)=>{calls.push({name,args});return {};}]))
  };
  const base='app/api/student/ctw-vocabulary/';
  const handlers=[route(base+'route.ts',deps),route(base+'words/route.ts',deps),route(base+'attempts/route.ts',deps),route(base+'attempts/[attemptId]/route.ts',deps)];
  for(const h of handlers)assert.equal((await h.GET(new Request('https://offline.invalid/api'),{params:{attemptId:ID}})).status,401);
  assert.equal((await handlers[2].POST(new Request('https://offline.invalid/api',{method:'POST',body:'bad json'}))).status,401);
  assert.equal(serviceCalls,0);assert.equal(calls.length,0);allowed=true;
  for(const h of handlers)assert.equal((await h.GET(new Request('https://offline.invalid/api?student_id='+V),{params:{attemptId:ID}})).status,400);
  for(const body of ['bad json',JSON.stringify({attemptId:ID,mode:'base_form',student_id:V,answers:[]}),
    JSON.stringify({attemptId:ID,mode:'base_form',answers:[{entryId:ID2,spelling:'x',correct:true}]})])
    assert.equal((await handlers[2].POST(new Request('https://offline.invalid/api',{method:'POST',body}))).status,400);
  assert.equal(serviceCalls,0);
  const valid={attemptId:ID,mode:'base_form',answers:[{entryId:ID2,spelling:'x'}]};
  assert.equal((await handlers[2].POST(new Request('https://offline.invalid/api',{method:'POST',body:JSON.stringify(valid)}))).status,200);
  assert.equal(serviceCalls,1);assert.equal(calls.at(-1).args[1],U);
  for(const h of handlers)assert.equal((await h.GET(new Request('https://offline.invalid/api'),{params:{attemptId:ID}})).status,200);
  assert.deepEqual(calls.slice(-4).map(c=>c.name),['readVocabularyCatalog','readVocabularyWords','readVocabularyHistory','readVocabularyResult']);
  assert.equal(serviceCalls,1);
});

test('HTTP auth uses account/token, disabled 403, no-store responses and intentional error statuses', async () => {
  let account={error:null,userId:U,role:'student',errorCode:null}, token=null, anonCalls=0, workCalls=0;
  const h=route('lib/ctw-vocabulary/http.server.ts',{
    'next/server':{NextResponse:{json:(data,opts)=>({data,...opts})}},
    '/lib/auth':{bearerToken:()=>token,requireAuthenticatedAccount:async()=>account,canUseStudentExperience:()=>true},
    'supabase/server':{createAnonSupabase:()=>{anonCalls++;return {}; }},
    'input.ts':input,'store.server.ts':store
  });
  const request=new Request('https://offline.invalid/api'), work=async()=>{workCalls++;return {};};
  assert.equal((await h.vocabularyRoute(request,work)).status,401);assert.equal(anonCalls,0);
  token='offline';account={...account,error:'Account disabled',errorCode:'ACCOUNT_DISABLED'};
  assert.equal((await h.vocabularyRoute(request,work)).status,403);assert.equal(workCalls,0);
  account={...account,error:null,errorCode:null};
  const ok=await h.vocabularyRoute(request,work);assert.equal(ok.status,200);assert.equal(ok.headers['Cache-Control'],'no-store');
  for(const [code,status] of [['CTW_VOCAB_UNAVAILABLE',503],['CTW_VOCAB_ATTEMPT_CONFLICT',409],['CTW_VOCAB_RESULT_NOT_FOUND',404],['CTW_VOCAB_INVALID_FORM_TYPE',400]])
    assert.equal((await h.vocabularyRoute(request,async()=>{throw new store.VocabularyStoreError(code);})).status,status);
});

test('import CLI rejects wrong source without writing SQL or contacting a database', () => {
  const result=spawnSync(process.execPath,['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','--experimental-strip-types',
    'scripts/import-ctw-vocabulary.ts','--mode','initial','--input','package.json','--output',sourcePath],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/SHA-256/);
  assert.equal(sha(fs.readFileSync(sourcePath)),importer.REVIEWED_SOURCE_SHA256);
  const cli=read('scripts/import-ctw-vocabulary.ts');assert.doesNotMatch(cli,/createClient|createServiceSupabase|fetch\(/);
});
