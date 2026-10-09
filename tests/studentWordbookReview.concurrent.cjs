// Opt-in native PostgreSQL multi-connection verification, NEVER Supabase.
// Only creates a new cluster under an explicitly supplied local test directory.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),net=require('node:net');
const h=require('./helpers/wordbookReviewFixture.cjs');
const runtime=process.env.TPS_REVIEW_NATIVE_RUNTIME,root=process.env.TPS_REVIEW_NATIVE_DIR;
if(!runtime||!root||!path.isAbsolute(root))throw Error('Explicit isolated native PostgreSQL runtime/directory required');
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
(async()=>{
  const {default:EmbeddedPostgres}=await import(path.join(runtime,'embedded-postgres/dist/index.js'));
  const {Client}=require(path.join(runtime,'pg'));
  const port=await freePort(),password=require('node:crypto').randomBytes(24).toString('hex');
  const pg=new EmbeddedPostgres({databaseDir:root,user:'postgres',password,port,persistent:true,
    postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog:()=>{},onError:()=>{}});
  const clients=[];let db;
  try{
    await pg.initialise();await pg.start();
    const connect=async()=>{const c=new Client({host:'127.0.0.1',port,user:'postgres',password,database:'postgres'});await c.connect();clients.push(c);return c;};
    const admin=await connect(),first=await connect(),second=await connect();
    db={query:(...args)=>admin.query(...args),exec:async sql=>{const r=await admin.query(sql);return Array.isArray(r)?r:[r];}};
    const source=h.read('tests/studentWordbookSql.test.js');
    const dependencies=vm.runInNewContext(source.slice(source.indexOf('const U1 ='),source.indexOf('async function fixture()'))+'\ndependencies;');
    await db.exec(dependencies);
    for(const file of ['student_wordbook_v1_20261008.sql','student_wordbook_v1_phase_a2_20261008.sql','student_wordbook_v1_phase_a3_20261008.sql',
      'student_wordbook_v1_bugfix_20261008.sql','student_wordbook_v1_batch_delete_20261008.sql'])await db.exec(h.read('supabase/'+file));
    await db.exec('grant select on profiles to service_role');
    await db.exec(`insert into lexical_source_blocks values('00000000-0000-4000-8000-000000000014','ctw','fixture','paragraph:p','ctw_paragraph','hash','generated')`);
    await h.beforeMigration(db);await db.exec(h.read('supabase/student_wordbook_review_v1_preflight.sql'));
    await db.exec(h.read('supabase/student_wordbook_review_v1_migration.sql'));await db.exec(h.read('supabase/student_wordbook_review_v1_verify.sql'));
    for(let i=0;i<50;i++)await h.save(db,{expression:'entry'+i});
    const create=async(c,request)=> (await c.query('select wordbook_review_create($1,$2::jsonb,$3,null) result',[h.U,JSON.stringify(h.settings(['ctw'],'reading',20)),request])).rows[0].result;
    await first.query('begin');const a=await create(first,h.uuid());
    let settled=false;const pending=create(second,h.uuid()).then(v=>{settled=true;return v;});
    // Confirm actual PostgreSQL advisory wait, not a JS single-connection queue.
    let locked=false;
    for(let n=0;n<100&&!locked;n++){
      locked=(await admin.query("select exists(select 1 from pg_stat_activity where pid=$1 and wait_event='advisory') b",[second.processID])).rows[0].b;
      if(!locked)await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(locked,true);assert.equal(settled,false);await first.query('commit');const b=await pending;
    const ids=async id=>(await admin.query('select wordbook_entry_id from student_wordbook_review_items where session_id=$1',[id])).rows.map(r=>r.wordbook_entry_id);
    const aIds=await ids(a.session.session_id),bIds=await ids(b.session.session_id);
    assert.equal(aIds.filter(id=>bIds.includes(id)).length,0);
    const c=await create(admin,h.uuid()),cIds=await ids(c.session.session_id);
    assert.equal(cIds.filter(id=>!aIds.includes(id)&&!bIds.includes(id)).length,10);
    const sameRequest=h.uuid();const [d,e]=await Promise.all([create(first,sameRequest),create(second,sameRequest)]);
    assert.equal(d.session.session_id,e.session.session_id);
    const spelling=(await admin.query('select snapshot->>\'expression\' expression from student_wordbook_review_items where item_id=$1',[d.item.itemId])).rows[0].expression;
    const answer=async client=>(await client.query('select wordbook_review_submit($1,$2,$3,$4::jsonb) result',
      [h.U,d.session.session_id,d.item.itemId,JSON.stringify({spelling,pos:'verb'})])).rows[0].result;
    const [x,y]=await Promise.all([answer(first),answer(second)]);assert.deepEqual(x,y);
    assert.equal((await admin.query('select count(*)::int n from student_wordbook_review_answers where item_id=$1',[d.item.itemId])).rows[0].n,1);
    console.log(JSON.stringify({status:'PASS',engine:(await admin.query('select version() v')).rows[0].v,
      checks:['real advisory wait','concurrent rounds do not overlap before exhaustion','third round 10 new + 10 least-used',
        'concurrent duplicate request creates one session','concurrent duplicate answer creates one answer'],scope:'LOCAL ISOLATED PostgreSQL, no production access'},null,2));
  }finally{
    for(const c of clients)await c.end().catch(()=>{});
    await pg.stop();
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
