// Opt-in real localhost UI. Normal login only; all notification/image APIs and
// all non-auth writes are intercepted. No production notification/reading writes.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {png,geometry}=require('./helpers/notificationBrowserLayout.cjs');
const origin=process.env.TPS_NOTIFICATION_BROWSER_ORIGIN,role=process.env.TPS_NOTIFICATION_BROWSER_ROLE??'student';
if(!origin||new URL(origin).hostname!=='localhost'||!process.env.TPS_PLAYWRIGHT_RUNTIME||!process.env.TPS_TEST_ACCOUNTS_FILE||!['student','teacher'].includes(role))throw Error('Ready localhost, existing Playwright, private accounts and Student/Teacher role required');
const {chromium}=require(process.env.TPS_PLAYWRIGHT_RUNTIME);
const image='40000000-0000-4000-8000-000000000001',expired='40000000-0000-4000-8000-000000000002';
const notices=[4,3,2,1].map(n=>({id:`20000000-0000-4000-8000-00000000000${n}`,title:`通知测试 ${n}`,content:`完整正文 ${n}`,type:'announcement',target_role:'all',published_at:`2026-11-0${n}T00:00:00Z`,read_at:null,content_document:null}));
notices[0].content_document={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'完整正文 4',marks:[{type:'bold'}]}]},
 {type:'image',attrs:{imageId:image}},{type:'paragraph',content:[{type:'text',text:('长通知与长链接测试 https://example.test/'+'x'.repeat(200)+'\n').repeat(35)}]},
 {type:'image',attrs:{imageId:image}},{type:'image',attrs:{imageId:expired}},{type:'paragraph',content:[{type:'text',text:'图片之后正文继续显示'}]}]};
const report={scope:'localhost real React; notification APIs intercepted only',role,checks:[],geometry:[]},calls=[],picture=png();
const accounts=Object.fromEntries(fs.readFileSync(process.env.TPS_TEST_ACCOUNTS_FILE,'utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
let browser;
let confirmOnDetail=null;
(async()=>{
 browser=await chromium.launch({headless:true,channel:'chrome'});
 async function context(){
  const c=await browser.newContext({viewport:{width:1440,height:1000}});
  await c.route(origin+'/api/**',async route=>{
   const r=route.request(),url=new URL(r.url());
   if(!url.pathname.includes('/notifications')){if(r.method()!=='GET'&&!url.pathname.startsWith('/api/supabase/auth/'))return route.abort();return route.continue();}
   calls.push({path:url.pathname+url.search,method:r.method()});let data;
   if(url.pathname.includes('/images/'))return url.pathname.endsWith(expired)?route.fulfill({status:410,contentType:'application/json',body:'{"message":"图片已过期"}'}):route.fulfill({status:200,contentType:'image/png',headers:{'X-Notification-Image-Expires-At':new Date(Date.now()+86400000).toISOString()},body:picture});
   if(url.pathname.endsWith('/read')){const row=notices.find(n=>url.pathname.includes(n.id));row.read_at=new Date().toISOString();data={id:row.id,read_at:row.read_at};}
   else if(url.searchParams.get('view')==='summary')data={unreadCount:notices.filter(n=>!n.read_at).length};
   else if(/\/notifications\/[0-9a-f-]+$/.test(url.pathname)){
    const row=notices.find(n=>url.pathname.endsWith(n.id));
    if(row.id===confirmOnDetail){row.read_at=new Date().toISOString();confirmOnDetail=null;}
    data={notification:row};
   }
   else{
    let rows=notices.filter(n=>url.searchParams.get('unread')!=='true'||!n.read_at);
    if(url.searchParams.get('beforeId')){const cursor=notices.findIndex(n=>n.id===url.searchParams.get('beforeId'));rows=rows.filter(n=>notices.indexOf(n)>cursor);}
    const visible=rows.slice(0,2),last=visible.at(-1);data={notifications:visible.map(({content,content_document,...title})=>title),nextCursor:rows.length>2?{before:last.published_at,beforeId:last.id}:null};
   }
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  return c;
 }
 const c=await context(),page=await c.newPage();
 async function login(p){await p.goto(origin+'/login');await p.locator('#account').fill(accounts[role==='teacher'?'TEACHER_EMAIL':'STUDENT_EMAIL']);await p.locator('#password').fill(accounts[role==='teacher'?'TEACHER_PASSWORD':'STUDENT_PASSWORD']);await p.getByRole('button',{name:'登录',exact:true}).click();await p.waitForURL(origin+(role==='teacher'?'/teacher/dashboard':'/student/sets'),{timeout:60000});}
 await page.addInitScript(()=>{window.__notificationProbe={documentId:Math.random(),articleRemovals:0};new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes)if(n.nodeType===1&&(n.matches?.('article[aria-label="通知详情"]')||n.querySelector?.('article[aria-label="通知详情"]')))window.__notificationProbe.articleRemovals++;}).observe(document,{childList:true,subtree:true});});
 await login(page);
 const dialog=page.getByRole('dialog',{name:'通知中心',exact:true});await dialog.waitFor({timeout:60000});await dialog.getByRole('article',{name:'通知详情'}).waitFor();await dialog.getByText('完整正文 4',{exact:true}).waitFor();
 assert.equal(await dialog.getByRole('list',{name:'通知列表'}).count(),0);
 assert.equal(calls.filter(r=>r.path.match(/\/notifications\/[0-9a-f-]+$/)).length,1);
 report.checks.push('first login directly opens latest unread full detail, never a title list');
 report.geometry.push(await geometry(page,dialog,role+' desktop detail'));
 await dialog.getByText('图片已过期',{exact:true}).waitFor();await dialog.getByText('图片之后正文继续显示',{exact:true}).waitFor();
 const img=dialog.getByRole('button',{name:'放大通知图片',exact:true}).first().locator('img');await img.waitFor();await img.evaluate(e=>e.decode());
 const ratio=await img.evaluate(e=>({natural:e.naturalWidth/e.naturalHeight,rendered:e.width/e.height}));assert.ok(Math.abs(ratio.natural-ratio.rendered)<.01);
 const scroll=dialog.locator('[data-notification-scroll]');assert.equal(await scroll.evaluate(e=>e.scrollHeight>e.clientHeight),true);
 const footerBefore=await dialog.locator('footer').boundingBox();await scroll.evaluate(e=>{e.scrollTop=e.scrollHeight;});const footerAfter=await dialog.locator('footer').boundingBox();assert.equal(footerBefore.y,footerAfter.y);
 report.checks.push('long text/multiple proportional images scroll inside body, footer stays fixed; expired image remains placeholder');
 await dialog.getByRole('button',{name:'放大通知图片',exact:true}).first().click();const preview=page.getByRole('dialog',{name:'通知图片预览',exact:true});await preview.waitFor();
 assert.ok((await preview.boundingBox()).width>(await dialog.boundingBox()).width);
 await page.keyboard.press('Tab');assert.equal(await preview.evaluate(e=>e.contains(document.activeElement)),true);
 await page.keyboard.press('Escape');await preview.waitFor({state:'hidden'});assert.equal(await dialog.isVisible(),true);
 await dialog.getByRole('button',{name:'放大通知图片',exact:true}).first().click();await preview.getByRole('button',{name:'点击图片关闭预览',exact:true}).click();await preview.waitFor({state:'hidden'});assert.equal(await dialog.isVisible(),true);
 await dialog.getByRole('button',{name:'放大通知图片',exact:true}).first().click();await preview.getByRole('button',{name:'关闭图片预览',exact:true}).click();await preview.waitFor({state:'hidden'});
 assert.equal(calls.filter(r=>r.method==='POST').length,0);report.checks.push('image enlarges; click/close button/Escape dismiss preview only; focus remains in top dialog');
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});report.geometry.push(await geometry(page,dialog,role+' mobile detail'));
  await dialog.getByRole('button',{name:'放大通知图片',exact:true}).first().click();await preview.waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.ok((await preview.boundingBox()).width<=width);assert.ok((await preview.boundingBox()).height<=844*.9+1);
  await preview.getByRole('button',{name:'关闭图片预览',exact:true}).click();await preview.waitFor({state:'hidden'});assert.equal(await dialog.isVisible(),true);
 }
 await page.setViewportSize({width:1440,height:1000});
 const before=calls.length;await page.evaluate(()=>{window.__notificationProbe.articleRemovals=0;window.__notificationHeader=document.querySelector('header');window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForTimeout(250);assert.equal(calls.length,before);assert.equal(await page.evaluate(()=>window.__notificationProbe.articleRemovals),0);assert.equal(await page.evaluate(()=>window.__notificationHeader===document.querySelector('header')),true);report.checks.push('focus/visibility do not refresh or unmount detail');
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(calls.filter(r=>r.method==='POST').length,0);assert.equal(await page.evaluate(()=>document.body.style.position),'');
 const detailReads=()=>calls.filter(r=>r.path.match(/\/notifications\/[0-9a-f-]+$/)).length;
 const initial=detailReads();await page.getByRole('button',{name:/通知中心/}).click();await dialog.getByRole('list',{name:'通知列表'}).waitFor();
 assert.equal(await dialog.locator('article').count(),0);assert.equal(detailReads(),initial);report.geometry.push(await geometry(page,dialog,role+' desktop list'));
 await dialog.getByRole('button',{name:/通知测试 4/}).click();await dialog.getByText('完整正文 4',{exact:true}).waitFor();await dialog.getByRole('button',{name:'确认已读',exact:true}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('[role="dialog"] button')).some(b=>b.textContent==='确认已读'));
 assert.equal(notices[0].read_at!==null,true);assert.equal(notices.slice(1).every(n=>n.read_at===null),true);report.checks.push('bell opens list without selecting; title opens detail; only explicit confirmation marks that item');
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.reload();await dialog.getByText('完整正文 3',{exact:true}).waitFor({timeout:60000});assert.equal(await dialog.getByText('完整正文 4',{exact:true}).count(),0);
 await dialog.getByRole('button',{name:'确认已读',exact:true}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('[role="dialog"] button')).some(b=>b.textContent==='确认已读'));
 await dialog.getByRole('button',{name:'下一条未读通知',exact:true}).click();await dialog.getByText('完整正文 2',{exact:true}).waitFor();assert.equal(notices[3].read_at,null);
 await dialog.getByRole('button',{name:'确认已读',exact:true}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('[role="dialog"] button')).some(b=>b.textContent==='确认已读'));
 await dialog.getByRole('button',{name:'下一条未读通知',exact:true}).click();await dialog.getByText('完整正文 1',{exact:true}).waitFor();await dialog.getByRole('button',{name:'确认已读',exact:true}).click();
 await page.waitForFunction(()=>!Array.from(document.querySelectorAll('[role="dialog"] button')).some(b=>b.textContent==='确认已读'));assert.equal(notices.every(n=>n.read_at),true);assert.equal(calls.filter(r=>r.method==='POST').length,4);
 report.checks.push('refresh skips confirmed notice; remaining unreads confirm independently across pagination');
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.reload();await page.getByRole('button',{name:'通知中心，0 条未读',exact:true}).waitFor();assert.equal(await dialog.count(),0);
 const fresh=await context(),freshPage=await fresh.newPage();await login(freshPage);await freshPage.getByRole('button',{name:'通知中心，0 条未读',exact:true}).waitFor({timeout:60000});assert.equal(await freshPage.getByRole('dialog',{name:'通知中心',exact:true}).count(),0);await fresh.close();
 await page.getByRole('button',{name:/通知中心/}).click();await dialog.getByRole('button',{name:/通知测试 4/}).click();await dialog.getByText('完整正文 4',{exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:'确认已读',exact:true}).count(),0);
 report.checks.push('confirmed reads survive page reload/fresh login fixture; manual history remains readable');
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 notices[1].read_at=null;notices[2].read_at=null;confirmOnDetail=notices[1].id;
 await page.reload();await dialog.getByText('完整正文 2',{exact:true}).waitFor({timeout:60000});assert.equal(await dialog.getByText('完整正文 3',{exact:true}).count(),0);assert.equal(calls.filter(r=>r.method==='POST').length,4);
 report.checks.push('automatic detail skips a notice freshly confirmed by another device between title and detail requests');
 if(role==='student'){
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();notices[3].read_at=null;
  const prev=calls.length;await page.goto(origin+'/student/reading/practice/notification-ui-only');await page.waitForTimeout(400);assert.equal(calls.length,prev);assert.equal(await page.getByRole('dialog',{name:'通知中心',exact:true}).count(),0);report.checks.push('practice route does not query/open notifications; unrelated writes are blocked');
 }
 console.log(JSON.stringify({...report,notificationWriteCount:calls.filter(r=>r.method==='POST').length},null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{await browser?.close();});
