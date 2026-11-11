const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const imageId='20000000-0000-4000-8000-000000000001',notificationId='30000000-0000-4000-8000-000000000001';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ+8AAAAASUVORK5CYII=','base64');
function fixture({role='admin',results=[],headError=null,getError=null,putError=null,expired=false,configured=true,envChanges={}}={}){
 const calls=[];
 const diagnostics=[];
 const asset={id:imageId,object_key:`notifications/${imageId}.png`,uploaded_at:new Date().toISOString(),expires_at:new Date(Date.now()+(expired?-1000:86400000)).toISOString(),content_type:'image/png',size_bytes:bytes.length};
 const chain=new Proxy({},{get:(_,property)=>property==='then'?(resolve,reject)=>Promise.resolve(results.shift()??{data:asset,error:null}).then(resolve,reject):(...args)=>{calls.push([property,...args]);return chain;}});
 const db={from:(table)=>{calls.push(['from',table]);return chain;}};
 class Command{constructor(input){this.input=input;}}
 class PutObjectCommand extends Command{}class GetObjectCommand extends Command{}class HeadObjectCommand extends Command{}
 class S3Client{async send(command){calls.push([command.constructor.name,command.input]);if(command instanceof HeadObjectCommand){if(headError)throw headError;return{ContentLength:bytes.length,ContentType:'image/png'};}if(command instanceof GetObjectCommand){if(getError)throw getError;return{ContentLength:bytes.length,ContentType:'image/png',Body:{transformToByteArray:async()=>bytes}};}if(command instanceof PutObjectCommand&&putError)throw putError;return{};}}
 const account={userId:'10000000-0000-4000-8000-000000000001',role,error:null};
 const modules={
  'node:crypto':{randomUUID:()=>imageId},'@aws-sdk/client-s3':{S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand},
  '@/lib/auth':{bearerToken:()=> 'user-jwt',requireAdmin:async()=>role==='admin'?account:{error:'Forbidden'},requireAuthenticatedAccount:async()=>account},
  '@/lib/supabase/server':{createAnonSupabase:()=>db,createServiceSupabase:()=>db},
  './notificationDocument.ts':require('../lib/notificationDocument.ts'),'./notifications.ts':require('../lib/notifications.ts'),'./notificationImages.ts':require('../lib/notificationImages.ts')
 };
 const compiled=ts.transpileModule(fs.readFileSync('lib/notificationImages.server.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 // Isolated env prevents tests from touching real R2 credentials.
 const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),R2_ACCESS_KEY_ID:'offline-access',R2_SECRET_ACCESS_KEY:'offline-secret',R2_BUCKET_NAME:'offline',NOTIFICATION_IMAGES_LIFECYCLE_CONFIRMED:String(configured),...envChanges};
 new Function('require','module','exports','process','console',compiled)(name=>{assert.ok(modules[name],name);return modules[name];},module,module.exports,{env},{error:(...args)=>diagnostics.push(args)});
 return{api:module.exports,calls,db,asset,diagnostics};
}
function upload(type='image/png',content=bytes){const form=new FormData();form.set('image',new Blob([content],{type}),'fixture.png');return new Request('https://local.test/upload',{method:'POST',body:form});}

test('only Admin uploads, invalid MIME/magic/oversize are rejected before metadata/R2 writes',async()=>{
 const teacher=fixture({role:'teacher'});assert.equal((await teacher.api.uploadNotificationImage(upload())).status,403);assert.equal(teacher.calls.length,0);
 for(const req of [upload('image/svg+xml',Buffer.from('<svg/>')),upload('image/png',Buffer.from('not an image')),upload('image/png',Buffer.alloc(3*1024*1024+1))]){
  const h=fixture();assert.ok([400,413].includes((await h.api.uploadNotificationImage(req)).status));assert.equal(h.calls.length,0);
 }
 const pending=fixture({configured:false});assert.equal((await pending.api.uploadNotificationImage(upload())).status,503);assert.equal(pending.calls.length,0);
});
test('upload writes bounded bytes only to notifications/new-uuid with no overwrite; DB receives metadata only',async()=>{
 const h=fixture();const r=await h.api.uploadNotificationImage(upload());assert.equal(r.status,201);
 const row=h.calls.find(c=>c[0]==='insert')[1];assert.deepEqual(Object.keys(row).sort(),['content_type','id','object_key','size_bytes','uploaded_by']);
 const object=h.calls.find(c=>c[0]==='PutObjectCommand')[1];assert.equal(object.Key,`notifications/${imageId}.png`);assert.equal(object.IfNoneMatch,'*');assert.equal(object.CacheControl,'private, no-store');
 assert.equal(h.calls.some(c=>/Delete|Lifecycle|Cors/.test(c[0])),false);
});
test('publish checks authoritative expiry AND R2 object existence; no fake image reference can publish',async()=>{
 const document={type:'doc',content:[{type:'image',attrs:{imageId}}]};
 const good=fixture({results:[{data:[fixture().asset],error:null}]});await good.api.assertNotificationImagesPublishable(document,good.db);assert.ok(good.calls.some(c=>c[0]==='HeadObjectCommand'));
 const expired=fixture();expired.asset.expires_at='2020-01-01';const bad=fixture({results:[{data:[expired.asset],error:null}]});await assert.rejects(bad.api.assertNotificationImagesPublishable(document,bad.db),/过期/);
 const missing=fixture({results:[{data:[fixture().asset],error:null}],headError:Error('missing')});await assert.rejects(missing.api.assertNotificationImagesPublishable(document,missing.db),/失效/);
});
test('recipient image requires parent RLS and exact membership; expired images never call R2',async()=>{
 const document={type:'doc',content:[{type:'image',attrs:{imageId}}]};
 const denied=fixture({role:'student',results:[{data:null,error:null}]});assert.equal((await denied.api.serveNotificationImage(new Request('https://local.test'),imageId,notificationId)).status,404);assert.equal(denied.calls.some(c=>c[0]==='GetObjectCommand'),false);
 const h=fixture({role:'student',expired:true,results:[{data:{content_document:document},error:null}]});const response=await h.api.serveNotificationImage(new Request('https://local.test'),imageId,notificationId);
 assert.equal(response.status,410);assert.equal(h.calls.some(c=>c[0]==='GetObjectCommand'),false);
});
test('live images use authenticated no-store responses; missing R2 object becomes explicit expired placeholder status',async()=>{
 const h=fixture();const response=await h.api.serveNotificationImage(new Request('https://local.test'),imageId);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.ok(response.headers.get('x-notification-image-expires-at'));assert.equal((await response.arrayBuffer()).byteLength,bytes.length);
 const gone=fixture({getError:{$metadata:{httpStatusCode:404}}});assert.equal((await gone.api.serveNotificationImage(new Request('https://local.test'),imageId)).status,410);
});

test('missing runtime R2 variables are named safely, before database insertion or object writes',async()=>{
 for(const name of ['CLOUDFLARE_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME']){
  const h=fixture({envChanges:{[name]:undefined}});const response=await h.api.uploadNotificationImage(upload());const body=await response.json();
  assert.equal(response.status,503);assert.equal(body.code,'NOTIFICATION_R2_ENV_MISSING');assert.ok(body.message.includes(name));
  assert.equal(h.calls.length,0);assert.equal(h.diagnostics[0][1].stage,'r2_config');
  assert.equal(JSON.stringify(body).includes('offline-secret'),false);assert.equal(JSON.stringify(h.diagnostics).includes('offline-secret'),false);
 }
});
test('invalid account URL and bucket path fail as configuration, not as R2 permission errors',async()=>{
 for(const envChanges of [{CLOUDFLARE_ACCOUNT_ID:'https://wrong.example'},{R2_BUCKET_NAME:'bucket/notifications/'},{R2_ACCESS_KEY_ID:'"quoted-key"'}]){
  const h=fixture({envChanges});const response=await h.api.uploadNotificationImage(upload());assert.equal((await response.json()).code,'NOTIFICATION_R2_ENV_INVALID');assert.equal(h.calls.length,0);
 }
});
test('malformed multipart is a 400 request error and never blamed on R2',async()=>{
 const h=fixture();const response=await h.api.uploadNotificationImage(new Request('https://local.test/upload',{method:'POST',headers:{'content-type':'multipart/form-data'},body:'invalid'}));
 assert.equal(response.status,400);assert.equal((await response.json()).code,'NOTIFICATION_UPLOAD_BODY_INVALID');assert.equal(h.calls.length,0);
});
test('upstream authentication, permissions, bucket and network errors have distinct sanitized diagnostics',async()=>{
 for(const [name,status,expected] of [['SignatureDoesNotMatch',403,'NOTIFICATION_R2_AUTH_FAILED'],['AccessDenied',403,'NOTIFICATION_R2_ACCESS_DENIED'],['NoSuchBucket',404,'NOTIFICATION_R2_BUCKET_NOT_FOUND'],['TimeoutError',undefined,'NOTIFICATION_IMAGE_UPLOAD_FAILED']]){
  const putError=Object.assign(Error('DO_NOT_LEAK_SECRET_OR_SIGNED_URL'),{name,$metadata:{httpStatusCode:status}});
  const h=fixture({putError});const response=await h.api.uploadNotificationImage(upload());const body=await response.json();
  assert.equal(response.status,503);assert.equal(body.code,expected);assert.equal(h.diagnostics[0][1].stage,'r2_put');
  assert.equal(JSON.stringify(body).includes('DO_NOT_LEAK'),false);assert.equal(JSON.stringify(h.diagnostics).includes('DO_NOT_LEAK'),false);
  assert.equal(h.calls.some(c=>/Delete|Lifecycle|Cors/.test(c[0])),false);
 }
});
test('metadata failure has a database diagnostic and never attempts PutObject',async()=>{
 const h=fixture({results:[{error:{code:'42501'},data:null}]});const r=await h.api.uploadNotificationImage(upload());assert.equal((await r.json()).code,'NOTIFICATION_IMAGE_METADATA_FAILED');assert.equal(h.calls.some(c=>c[0]==='PutObjectCommand'),false);
});
