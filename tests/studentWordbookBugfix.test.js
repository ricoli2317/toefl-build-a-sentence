const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { extractWordbookContext } = require('../lib/lexical/wordbookContext.ts');
const { canonicalSourceTextHash } = require('../lib/lexical/hash.ts');
const context = (text,word,kind) => extractWordbookContext(text,kind,{context_text:text,surface_text:word,start_offset:text.indexOf(word),end_offset:text.indexOf(word)+word.length,sentence_id:null});
test('production WE informative and RDL adhere reproduce exact sentences without auxiliary/imperative whitelist',()=>{
  const we='You recently attended a photography workshop and found it very informative and enjoyable. You want to reach out to the instructor, Mr. Carter, to ask for additional tips on portrait photography, which you are particularly interested in. You also want to express your gratitude for the workshop.';
  assert.equal(canonicalSourceTextHash(we),'00ec88861a5433bc97ecd1bc1c6332b033113d47dec3d2e7d49d898625dcaef3');assert.equal(we.indexOf('informative'),63);
  assert.deepEqual(context(we,'informative','email_scenario'),{example_text:we.split('. ')[0]+'.',context_kind:'sentence',extraction_method:'verified_sentence_span'});
  const rdl='Park Regulations & Guidelines\n\nWelcome to Greenfield Park. Please adhere to the following guidelines for the safety and enjoyment of all visitors.\n\nPark Hours:\n\nMonday to Friday: 6:00 A.M. - 9:00 P.M.\n\nSaturday: 7:00 A.M. - 10:00 P.M. | Sunday: 8:00 A.M. - 8:00 P.M.\n\nGeneral Rules:\n\n1. Pets: Pets must be kept on a leash at all times. Owners must clean up after their pets.\n\n2. Trash Disposal: Put trash, cans, and bottles into designated trash and recycling bins located throughout the park.\n\n3. Picnics: Use picnic tables in designated areas only. Campfires are prohibited.\n\n4. Activities: Cycling is allowed on marked trails only. Swimming is permitted in the North Pond only; the South Pond is too deep.\n\n5. Safety: Report any suspicious activity to park rangers.\n\nEmergency contact: Call 555-9110 for immediate assistance.\n\nFacilities: Restrooms are located near the entrance and picnic areas.\n\nPlayground and sports fields are open during park hours.\n\nContact Information:\n\nFor questions or assistance, visit the park office or call 555-1234.\n\nEnjoy your visit to Greenfield Park!';
  const c=context(rdl,'adhere','rdl_material');
  assert.equal(canonicalSourceTextHash(rdl),'3c4046c19e6ba3745f6e073f6647b7114117d8ef7f30997d0cfc634cfd316714');assert.equal(rdl.indexOf('adhere'),66);
  assert.equal(c.example_text.trim(),'Please adhere to the following guidelines for the safety and enjoyment of all visitors.');assert.equal(c.context_kind,'sentence');
});
test('CTW/AD finite-verb sentences, quotes, abbreviations and UTF-16 remain exact; titles stay fragments',()=>{
  for(const [text,word,kind] of [['Birds migrate each winter. They return in spring.','migrate','ctw_paragraph'],['Students learn through collaboration. Others prefer independent study.','collaboration','academic_professor_prompt'],['😀 “Dr. Smith supports the proposal!” They disagree.','supports','academic_student_response']]) {
    const c=context(text,word,kind);assert.equal(c.context_kind,'sentence');assert.ok(text.includes(c.example_text));assert.ok(c.example_text.includes(word));
  }
  assert.equal(context('Portrait Photography Tips','Portrait','email_subject').context_kind,'fragment');
});
test('real RDL International Mixer: terminal P.M. in previous paragraph cannot downgrade the next complete sentence',()=>{
  const text='Join us for the International Mixer, a fun evening at the Berghold Student Center on March 20 at 6:00 P.M.\n\nMeet fellow students from around the globe, enjoy international refreshments, and participate in cultural activities.\n\nFor questions, contact International Student Services.\n\nWe look forward to seeing you there!';
  const c=context(text,'refreshments','rdl_material');
  assert.equal(c.context_kind,'sentence');assert.equal(c.example_text,'Meet fellow students from around the globe, enjoy international refreshments, and participate in cultural activities.');assert.equal(c.extraction_method,'verified_sentence_span');
  // Natural fragment and uncertain abbreviation within the SAME paragraph
  // retain conservative classification; no offset/identity check is relaxed.
  assert.equal(context('Hours: 6:00 P.M.\n\n😀 Growing opportunities','Growing','rdl_material').context_kind,'fragment');
  assert.equal(context('They are living in the U.S. It is growing.','growing','rdl_material').example_text,null);
});
const file=path.join(__dirname,'studentWordbookA3.test.js');
const source=fs.readFileSync(file,'utf8');
const h=vm.runInNewContext(source.slice(0,source.indexOf("test('API"))+'\n({fixture,payload,events,list,dates,U,O,E,read});',{require:createRequire(file),__dirname,process,console});
const engineTest=(name,fn)=>test(name,{skip:!process.env.WORDBOOK_SQL_TEST_PGLITE},fn);
async function upgraded() {const db=await h.fixture();await db.exec(h.read('supabase/student_wordbook_v1_bugfix_preflight_20261008.sql'));await db.exec(h.read('supabase/student_wordbook_v1_bugfix_20261008.sql'));await db.exec(h.read('supabase/student_wordbook_v1_bugfix_verify_20261008.sql'));return db;}
const call=async(db,payload,action='save',user=h.U)=>(await db.query('select operate_student_wordbook_v1($1,$2,$3,$4::jsonb) result',[user,h.O,action,JSON.stringify(payload)])).rows[0].result;
const noExample=p=>({...p,example_text:null,context_kind:null,extraction_method:'verified_no_example_boundary'});
engineTest('incremental RPC: no-example first/new sense/source saves, inert repeats, later examples/M:N, cascade and domains',async()=>{
  const db=await upgraded();try {
    let p=noExample(await h.payload(db));await call(db,p);await call(db,p);
    let item=(await h.list(db)).items[0];assert.equal(item.examples.length,0);assert.equal(item.senses.length,1);assert.deepEqual(item.sourceTypes,['ctw']);assert.equal((await h.events(db)).length,1);
    await db.exec(`update lexical_occurrences set context_meaning_zh='新义项'`);p=noExample(await h.payload(db));await call(db,p);await call(db,p);
    assert.equal((await h.list(db)).items[0].senses.length,2);assert.equal((await h.events(db)).length,2);
    await db.exec(`update lexical_occurrences set source_type='rdl';update lexical_source_blocks set source_type='rdl',block_kind='rdl_material'`);await call(db,noExample(await h.payload(db)));
    assert.deepEqual((await h.list(db)).items[0].sourceTypes,['ctw','rdl']);assert.equal((await h.events(db)).length,3);
    await call(db,await h.payload(db));await call(db,await h.payload(db));item=(await h.list(db)).items[0];assert.equal(item.examples.length,1);assert.equal((await h.events(db)).length,4);
    await db.exec(`update lexical_occurrences set context_meaning_zh='运行'`);await call(db,await h.payload(db));assert.equal((await db.query('select count(*)::int n from student_wordbook_example_senses')).rows[0].n,2);
    await db.exec(`update lexical_occurrences set source_type='bas';update lexical_source_blocks set source_type='bas',block_kind='bas_prompt'`);await call(db,noExample(await h.payload(db)));assert.equal((await h.list(db,{domain:'writing'})).total,1);
    await db.exec(`update lexical_occurrences set source_type='rdl';update lexical_source_blocks set source_type='rdl',block_kind='rdl_material'`);await call(db,await h.payload(db),'remove');
    for(const table of ['entries','senses','examples','example_senses','canonical_links','activities']) assert.equal((await db.query(`select count(*)::int n from student_wordbook_${table} where domain='reading'`)).rows[0].n,0);
    assert.equal((await h.list(db,{domain:'writing'})).total,1);
  }finally{await db.close();}
});
engineTest('incremental RPC: missing/invalid context, stale identity, browser privileges and transaction rollback remain strict',async()=>{
  const db=await upgraded();try {
    const p=await h.payload(db);
    for(const bad of [{...p,example_text:null},{...noExample(p),extraction_method:'unknown'},{...noExample(p),entry_id:h.U},{...p,example_text:'invented'},{...p,extraction_method:'verified_no_example_boundary'}]) await assert.rejects(call(db,bad));
    for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(call(db,noExample(p)),/permission denied/i);await db.exec('reset role');}
    await db.exec(`create function fail_bugfix() returns trigger language plpgsql as $$ begin raise exception 'OFFLINE_ROLLBACK'; end; $$; create trigger fail_bugfix before insert on student_wordbook_activities for each row execute function fail_bugfix();`);
    await assert.rejects(call(db,noExample(p)),/OFFLINE_ROLLBACK/);
    for(const table of ['entries','senses','examples','example_senses','canonical_links','activities']) assert.equal((await db.query(`select count(*)::int n from student_wordbook_${table}`)).rows[0].n,0);
    await db.exec('drop trigger fail_bugfix on student_wordbook_activities');await call(db,p);
    await assert.rejects(db.exec(`update student_wordbook_entries set source_types='{}'`),/IMMUTABLE/);
    await assert.rejects(db.exec(h.read('supabase/student_wordbook_v1_bugfix_20261008.sql')),/DRIFT/);await db.exec('rollback');
    assert.equal((await h.list(db)).total,1);
  }finally{await db.close();}
});
engineTest('incremental installation preserves historical snapshots/activity timestamps and saved source provenance',async()=>{
  const db=await h.fixture();try {
    await call(db,await h.payload(db));
    const before=(await h.list(db)).items[0];const times=(await h.events(db)).map(e=>e.activity_at);
    await db.exec(h.read('supabase/student_wordbook_v1_bugfix_20261008.sql'));
    assert.deepEqual((await h.list(db)).items[0],before);assert.deepEqual((await h.events(db)).map(e=>e.activity_at),times);
  }finally{await db.close();}
});
