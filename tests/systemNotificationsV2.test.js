const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { normalizeNotificationDocument, notificationDocumentText, notificationImageIds } = require('../lib/notificationDocument.ts');
const { inspectNotificationImage, isNotificationImageKey, notificationImageExpired, NOTIFICATION_IMAGE_MAX_BYTES } = require('../lib/notificationImages.ts');
const { startVisiblePolling, createLatestRequestGate } = require('../lib/clientRefreshPolicy.ts');
const admin='10000000-0000-4000-8000-000000000001', student='10000000-0000-4000-8000-000000000002';
const image='20000000-0000-4000-8000-000000000001';
const doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Before',marks:[{type:'bold',attrs:{onclick:'bad'}},{type:'script'}]}]},
  {type:'image',attrs:{imageId:image,src:'data:image/png;base64,BAD',onerror:'BAD'}},{type:'paragraph',content:[{type:'text',text:'After'}]}]};

test('rich document filters every executable attribute, preserves mixed paragraph/image order and rejects unknown nodes',()=>{
  const safe=normalizeNotificationDocument(doc);assert.ok(safe);
  assert.equal(JSON.stringify(safe).includes('base64'),false);assert.equal(JSON.stringify(safe).includes('onclick'),false);
  assert.deepEqual(safe.content[0].content[0].marks,[{type:'bold'}]);
  assert.equal(notificationDocumentText(safe),'Before\n[图片]After');assert.deepEqual(notificationImageIds(safe),[image]);
  for(const value of [{type:'doc',content:[{type:'script',text:'bad'}]}, {type:'doc',content:[{type:'image',attrs:{src:'https://evil.test'}}]},
    {type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'x'.repeat(20001)}]}]}]) assert.equal(normalizeNotificationDocument(value),null);
});

test('image validation enforces MIME, signatures, size, notifications-only path and exact 30-day expiry boundary',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ+8AAAAASUVORK5CYII=','base64');
  assert.equal(inspectNotificationImage(png,'image/png').extension,'png');
  for(const [bytes,type] of [[png,'image/svg+xml'],[png,'image/jpeg'],[Buffer.from('<svg/>'),'image/png'],[new Uint8Array(NOTIFICATION_IMAGE_MAX_BYTES+1),'image/png']]) assert.equal(inspectNotificationImage(bytes,type),null);
  assert.equal(isNotificationImageKey(`notifications/${image}.png`),true);
  for(const key of [`reading/${image}.png`,`notifications/../rdl/${image}.png`,`notifications/${image}.svg`,`/notifications/${image}.png`]) assert.equal(isNotificationImageKey(key),false);
  assert.equal(notificationImageExpired('2026-11-11T00:00:00Z',Date.parse('2026-11-11T00:00:00Z')),true);
});

test('shared refresh scheduler has no focus/visibility subscription, polls visible state only; generations reject stale completion',()=>{
  let callback,visible=false,runs=0,stopped=false;
  const stop=startVisiblePolling(()=>runs++,60000,{visible:()=>visible,setInterval:fn=>{callback=fn;return 1;},clearInterval:()=>{stopped=true;}});
  callback();assert.equal(runs,0);visible=true;assert.equal(runs,0,'restoring visibility itself does nothing');callback();assert.equal(runs,1);stop();assert.equal(stopped,true);
  const gate=createLatestRequestGate(),old=gate.begin(),current=gate.begin();assert.equal(gate.isCurrent(old),false);assert.equal(gate.isCurrent(current),true);gate.invalidate();assert.equal(gate.isCurrent(current),false);
});

test('additive V2 SQL preserves legacy rows and receipts, soft-deletes without withdrawing, and atomically validates publication',async t=>{
  const db=new PGlite();
  const actor=async id=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');};
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
      create table profiles(id uuid primary key,role text,is_active boolean default true);alter table profiles enable row level security;
      create policy self on profiles for select to authenticated using(id=(select auth.uid()));grant select on profiles to authenticated;`);
    await db.query("insert into profiles values($1,'admin',true),($2,'student',true)",[admin,student]);
    await db.exec(fs.readFileSync('supabase/system_notifications_20261110.sql','utf8'));
    await actor(admin);
    const old=(await db.query("insert into system_notifications(title,content) values('Legacy','<b>literal old text</b>') returning id")).rows[0].id;
    await db.query("update system_notifications set status='published' where id=$1",[old]);
    await actor(student);await db.query('insert into user_notification_reads(notification_id) values($1)',[old]);
    await db.exec('reset role');
    const before=(await db.query('select * from system_notifications')).rows[0];
    const readBefore=(await db.query('select * from user_notification_reads')).rows[0];
    await db.exec(fs.readFileSync('supabase/system_notifications_v2_20261111.sql','utf8'));
    const after=(await db.query('select * from system_notifications')).rows[0];
    assert.equal(after.content_document,null);assert.equal(after.admin_deleted_at,null);
    for(const key of Object.keys(before)) assert.deepEqual(after[key],before[key],key);
    assert.deepEqual((await db.query('select * from user_notification_reads')).rows[0],readBefore);

    await t.test('soft delete of published item leaves status, payload, timestamp, recipient visibility and read receipt intact',async()=>{
      await actor(admin);await db.query('update system_notifications set admin_deleted_at=now() where id=$1',[old]);
      const deleted=(await db.query('select * from system_notifications where id=$1',[old])).rows[0];
      for(const key of ['content','title','published_at','status']) assert.deepEqual(deleted[key],before[key]);
      assert.equal((await db.query('select * from system_notifications where admin_deleted_at is null')).rows.length,0);
      await actor(student);assert.equal((await db.query('select * from notification_inbox_titles()')).rows[0].id,old);
      assert.equal((await db.query('select * from notification_inbox()')).rows[0].content,before.content);
      assert.deepEqual((await db.query('select * from user_notification_reads')).rows[0],readBefore);
      await assert.rejects(db.query('delete from system_notifications where id=$1',[old]),/permission denied/);
    });
    await t.test('draft deletion is safe; direct publish is atomic and title-only RPC contains no body',async()=>{
      await actor(admin);
      const id=(await db.query("select admin_create_system_notification('Direct','Text','update','all',null,true) id")).rows[0].id;
      assert.equal((await db.query('select status from system_notifications where id=$1',[id])).rows[0].status,'published');
      const draft=(await db.query("select admin_create_system_notification('Draft','Text','update','all') id")).rows[0].id;
      await db.query('update system_notifications set admin_deleted_at=now() where id=$1',[draft]);
      await assert.rejects(db.query("update system_notifications set status='published' where id=$1",[draft]),/NOTIFICATION_ADMIN_DELETED/);
      await actor(student);const rows=(await db.query('select * from notification_inbox_titles()')).rows;
      assert.equal(rows.some(row=>row.id===draft),false);assert.equal(Object.hasOwn(rows[0],'content'),false);
      await assert.rejects(db.query("select admin_create_system_notification('Hack','Text','update','all',null,true)"),/ADMIN_REQUIRED/);
    });
    await t.test('metadata lifetime is server stamped; expired/missing images cannot publish, failure leaves no new draft',async()=>{
      await actor(admin);
      const asset=(await db.query("insert into notification_image_assets(id,object_key,content_type,size_bytes,expires_at) values($1,$2,'image/png',68,'2099-01-01') returning *",[image,`notifications/${image}.png`])).rows[0];
      assert.equal(asset.expires_at-asset.uploaded_at,30*86400000);
      await db.query("select admin_create_system_notification('Valid image','Body','update','all',$1,true)",[doc]);
      const imageNotice=(await db.query("select id from system_notifications where title='Valid image'")).rows[0].id;
      await db.query('update system_notifications set admin_deleted_at=now() where id=$1',[imageNotice]);
      await actor(student);
      assert.deepEqual((await db.query('select content_document from system_notifications where id=$1',[imageNotice])).rows[0].content_document,doc);
      await actor(admin);
      assert.equal((await db.query('select count(*)::int n from notification_image_assets')).rows[0].n,1,'Admin soft delete preserves image metadata');
      const n=(await db.query('select count(*)::int n from system_notifications')).rows[0].n;
      await db.exec('reset role');await db.query("update notification_image_assets set expires_at=now()-interval '1 second' where id=$1",[image]);await actor(admin);
      await assert.rejects(db.query("select admin_create_system_notification('Expired image','Body','update','all',$1,true)",[doc]),/NOTIFICATION_IMAGE_EXPIRED/);
      assert.equal((await db.query('select count(*)::int n from system_notifications')).rows[0].n,n);
      const draft=(await db.query("select admin_create_system_notification('Expired draft','Body','update','all',$1,false) id",[doc])).rows[0].id;
      await assert.rejects(db.query("update system_notifications set status='published' where id=$1",[draft]),/NOTIFICATION_IMAGE_EXPIRED/);
      await actor(student);assert.equal((await db.query('select * from notification_image_assets')).rows.length,0);
    });
  }finally{await db.close();}
});
