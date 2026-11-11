// Opt-in localhost browser test. Normal Admin UI authentication; every
// notification/image mutation is intercepted. NO production notification/R2 writes.
const fs=require('node:fs'),assert=require('node:assert/strict');
const origin=process.env.TPS_NOTIFICATION_BROWSER_ORIGIN;
if(!origin||new URL(origin).hostname!=='localhost'||!process.env.TPS_PLAYWRIGHT_RUNTIME||!process.env.TPS_TEST_ACCOUNTS_FILE)throw Error('Explicit Ready localhost, existing Playwright and private account file required');
const {chromium}=require(process.env.TPS_PLAYWRIGHT_RUNTIME);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ+8AAAAASUVORK5CYII=','base64');
const imageId='40000000-0000-4000-8000-000000000001',version='2026-11-11T00:00:00Z';
let browser;
(async()=>{
 browser=await chromium.launch({headless:true,channel:'chrome'});const context=await browser.newContext({viewport:{width:1440,height:1100}}),page=await context.newPage();
 const calls=[],checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const rows=['draft','published','withdrawn'].map((status,i)=>({id:`20000000-0000-4000-8000-00000000000${i+1}`,title:`Admin ${status}`,content:'Original content',content_document:null,type:'announcement',target_role:'all',status,created_at:version,updated_at:version,published_at:status==='draft'?null:version}));
 await context.route(origin+'/api/**',async route=>{
  const r=route.request(),u=new URL(r.url());
  if(!u.pathname.includes('/notifications')){if(r.method()!=='GET'&&!u.pathname.startsWith('/api/supabase/auth/'))return route.abort();return route.continue();}
  const body=r.method()!=='GET'&&!u.pathname.endsWith('/images')?r.postDataJSON():null;calls.push({path:u.pathname,method:r.method(),body});
  if(u.pathname.endsWith('/images'))return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({image:{id:imageId,expires_at:new Date(Date.now()+30*86400000).toISOString()}})});
  if(u.pathname.includes('/images/'))return route.fulfill({status:200,contentType:'image/png',headers:{'X-Notification-Image-Expires-At':new Date(Date.now()+30*86400000).toISOString()},body:png});
  let data={};
  if(r.method()==='GET')data={notifications:rows,hasMore:false};
  else if(r.method()==='POST'){const id='30000000-0000-4000-8000-000000000001';rows.unshift({...body,id,status:body.action==='publish'?'published':'draft',created_at:version,updated_at:version,published_at:version});data={id};}
  else if(r.method()==='DELETE'){const i=rows.findIndex(row=>u.pathname.endsWith(row.id));if(i>=0)rows.splice(i,1);data={id:'deleted'};}
  else data={id:'updated'};
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const a=Object.fromEntries(fs.readFileSync(process.env.TPS_TEST_ACCOUNTS_FILE,'utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
 await page.goto(origin+'/login');await page.locator('#account').fill(a.ADMIN_EMAIL);await page.locator('#password').fill(a.ADMIN_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(origin+'/teacher/dashboard',{timeout:60000});
 await page.goto(origin+'/admin/notifications');await page.getByRole('button',{name:'创建通知',exact:true}).waitFor({timeout:60000});
 await page.getByRole('button',{name:'创建通知',exact:true}).click();let dialog=page.getByRole('dialog',{name:'创建通知',exact:true});
 for(const name of ['取消','保存草稿','发布'])assert.equal(await dialog.getByRole('button',{name,exact:true}).count(),1);
 await dialog.locator('input[maxlength="160"]').fill('Direct rich publish');
 const text=dialog.getByRole('textbox',{name:'通知正文',exact:true});await text.fill('通知第一段');await text.press('Enter');await text.press('Shift+Enter');await text.pressSequentially('通知第二段');
 await dialog.getByRole('button',{name:'粗体',exact:true}).click();await text.pressSequentially('加粗文字');
 await dialog.getByLabel('上传通知图片',{exact:true}).setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});
 await dialog.getByRole('img',{name:'通知图片',exact:true}).waitFor();await dialog.getByRole('button',{name:'发布',exact:true}).waitFor({state:'visible'});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='发布'&&b.closest('[role="dialog"]'))?.disabled===false);
 await dialog.getByRole('button',{name:'发布',exact:true}).click();await dialog.waitFor({state:'hidden'});
 const creates=calls.filter(c=>c.method==='POST'&&c.path==='/api/admin/notifications');assert.equal(creates.length,1);assert.equal(creates[0].body.action,'publish');
 const body=creates[0].body;assert.ok(body.content_document);assert.ok(JSON.stringify(body.content_document).includes(imageId));assert.ok(JSON.stringify(body.content_document).includes('bold'));assert.equal(JSON.stringify(body).includes('base64'),false);assert.equal(calls.some(c=>c.method==='PATCH'),false);
 checks.push('create dialog exposes Cancel/Save draft/Publish; mixed Tiptap text, paragraphs, bold and uploaded image; one direct publish POST');
 const item=page.locator('li').filter({has:page.getByRole('button',{name:'Admin published',exact:true})});await item.getByRole('button',{name:'删除',exact:true}).click();
 dialog=page.getByRole('dialog').filter({hasText:'确认删除通知？'});await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(calls.filter(c=>c.method==='DELETE').length,0);
 await item.getByRole('button',{name:'删除',exact:true}).click();dialog=page.getByRole('dialog').filter({hasText:'确认删除通知？'});await dialog.getByRole('button',{name:'确认删除',exact:true}).click();await dialog.waitFor({state:'hidden'});
 assert.equal(calls.filter(c=>c.method==='DELETE').length,1);assert.equal(calls.some(c=>c.method==='PATCH'),false);await page.getByRole('button',{name:'Admin withdrawn',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Admin published',exact:true}).count(),0);
 checks.push('delete requires confirmation, cancel is no-op; delete does not call withdrawal API; published row disappears only from Admin list');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({scope:'local real Admin React/editor; notification/image APIs intercepted only',checks,errors,mutations:calls.filter(c=>c.method!=='GET').map(c=>({method:c.method,path:c.path}))},null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{await browser?.close();});
