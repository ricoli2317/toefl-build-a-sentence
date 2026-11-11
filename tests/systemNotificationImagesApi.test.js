const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript');
const imageId='20000000-0000-4000-8000-000000000001',notificationId='30000000-0000-4000-8000-000000000001';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ+8AAAAASUVORK5CYII=','base64');
function fixture({role='admin',results=[],headError=null,getError=null,expired=false,configured=true}={}){
 const calls=[];
 const asset={id:imageId,object_key:`notifications/${imageId}.png`,uploaded_at:new Date().toISOString(),expires_at:new Date(Date.now()+(expired?-1000:86400000)).toISOString(),content_type:'image/png',size_bytes:bytes.length};
 const chain=new Proxy({},{get:(_,property)=>property==='then'?(resolve,reject)=>Promise.resolve(results.shift()??{data:asset,error:null}).then(resolve,reject):(...args)=>{calls.push([property,...args]);return chain;}});
 const db={from:(table)=>{calls.push(['from',table]);return chain;}};
 class Command{constructor(input){this.input=input;}}
 class PutObjectCommand extends Command{}class GetObjectCommand extends Command{}class HeadObjectCommand extends Command{}
 class S3Client{async send(command){calls.push([command.constructor.name,command.input]);if(command instanceof HeadObjectCommand){if(headError)throw headError;return{ContentLength:bytes.length,ContentType:'image/png'};}if(command instanceof GetObjectCommand){if(getError)throw getError;return{ContentLength:bytes.length,ContentType:'image/png',Body:{transformToByteArray:async()=>bytes}};}return{};}}
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
 const env={CLOUDFLARE_ACCOUNT_ID:'offline',R2_ACCESS_KEY_ID:'offline',R2_SECRET_ACCESS_KEY:'offline',R2_BUCKET_NAME:'offline',NOTIFICATION_IMAGES_LIFECYCLE_CONFIRMED:String(configured)};
 new Function('require','module','exports','process',compiled)(name=>{assert.ok(modules[name],name);return modules[name];},module,module.exports,{env});
 return{api:module.exports,calls,db,asset};
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
