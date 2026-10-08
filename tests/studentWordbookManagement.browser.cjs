// Opt-in localhost UI verification with explicitly OFFLINE PGlite reads/deletes.
// Start normal pnpm dev and wait for Ready FIRST. No production wordbook writes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const h=require('./helpers/wordbookManagementFixture.cjs');
const {parseWordbookQuery}=require('../lib/lexical/wordbookList.ts');
const {parseWordbookBatchDelete}=require('../lib/lexical/wordbookManagement.ts');
const {deleteWordbookBatch}=require('../lib/lexical/wordbookManagement.server.ts');
const origin=process.env.TPS_WORDBOOK_BROWSER_ORIGIN,output=process.env.TPS_WORDBOOK_BROWSER_OUTPUT;
if(!origin||new URL(origin).hostname!=='localhost'||!output||!process.env.TPS_TEST_ACCOUNTS_FILE||!process.env.TPS_PLAYWRIGHT_RUNTIME||!process.env.WORDBOOK_SQL_TEST_PGLITE)throw Error('Explicit Ready localhost, output, private account file and offline runtime required');
const {chromium}=require(process.env.TPS_PLAYWRIGHT_RUNTIME);
const report={scope:'LOCAL UI + OFFLINE PGlite. Normal login only. No production wordbook reads/deletes or new bookmarks.',checks:[],errors:[],requests:[],screenshots:[]};
const check=(name,data={})=>{report.checks.push({name,pass:true,...data});};
let db,browser,page,failNext=false;
const sqlClient={from(){const filter={};const q={select:()=>q,eq:(key,value)=>{filter[key]=value;return q;},in:async(key,ids)=>({data:(await db.query('select wordbook_entry_id,student_id,domain from student_wordbook_entries where student_id=$1 and domain=$2 and wordbook_entry_id=any($3::uuid[])',[filter.student_id,filter.domain,ids])).rows,error:null})};return q;},rpc:async(name,args)=>{
  try{return {data:(await db.query('select delete_student_wordbook_entries_v1($1,$2,$3::uuid[]) result',[args.p_student_id,args.p_domain,args.p_entry_ids])).rows[0].result,error:null};}catch(e){return{data:null,error:{message:e.message}};}
}};
const ready=async()=>{await page.waitForFunction(()=>document.querySelector('[role="tabpanel"]')?.getAttribute('aria-busy')==='false');await page.waitForTimeout(50);};
const readAction=async fn=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/student/wordbook');response.catch(()=>{});await fn();await response;await ready();};
const table=()=>page.getByRole('tabpanel').locator('table');
const entries=()=>table().locator('tbody[data-wordbook-entry]');
const all=()=>page.getByRole('checkbox',{name:'全选当前页',exact:true});
const choices=()=>entries().locator('input[type="checkbox"]');
const selected=()=>choices().evaluateAll(es=>es.filter(e=>e.checked).length);
const deleteButton=()=>page.getByRole('button',{name:/^删除/});
const dialog=()=>page.getByRole('dialog').filter({hasText:'确认删除选中的'});
async function switchTab(domain){await readAction(()=>page.getByRole('tab',{name:domain==='reading'?'Reading':'Writing',exact:true}).click());}
async function applyDate(start,end=''){await page.getByRole('button',{name:'选择日期',exact:true}).click();const d=page.getByRole('dialog');await d.getByLabel('开始日期',{exact:true}).fill(start);await d.getByLabel('结束日期',{exact:true}).fill(end);await readAction(()=>d.getByRole('button',{name:end&&start!==end?'查看日期范围':'查看当天',exact:true}).click());}
async function layout(width){await page.setViewportSize({width,height:900});await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(120);const boxes=await table().locator('td[data-label="例句"] p').evaluateAll(es=>es.filter(e=>!e.querySelector('button[aria-expanded="true"]')).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e),b=e.querySelector('button')?.getBoundingClientRect();return {height:r.height,lineHeight:parseFloat(s.lineHeight),width:r.width,ellipsisBottom:b?b.bottom-r.top:null,text:e.textContent};}));assert.ok(boxes.length);for(const b of boxes){assert.ok(b.height<=b.lineHeight*2,JSON.stringify(b));if(b.ellipsisBottom!==null)assert.ok(b.ellipsisBottom<=b.lineHeight*2,JSON.stringify(b));}assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);check('all collapsed examples including clickable ellipses <= two lines',{width,count:boxes.length,first:boxes[0]});}
(async()=>{
  fs.mkdirSync(output,{recursive:true});db=await h.fixture({populate:true});browser=await chromium.launch({headless:true,channel:'chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.route(origin+'/api/lexical/wordbook',route=>{report.errors.push('Unexpected production collection write attempted');return route.abort();});
  await page.route(origin+'/api/student/wordbook**',async route=>{
    const request=route.request(),url=new URL(request.url());let body,status=200;
    try{
      if(url.pathname.endsWith('/batch-delete')){
        const input=parseWordbookBatchDelete(request.postDataJSON());report.requests.push({action:'delete',domain:input.domain,count:input.entryIds.length});
        if(failNext){failNext=false;throw Error('OFFLINE_TEST_RETRY');}
        body=await deleteWordbookBatch(sqlClient,h.U,input);
      }else{
        const q=parseWordbookQuery(url.searchParams);report.requests.push({action:'read',path:url.pathname,query:url.search});
        body=url.pathname.endsWith('/activity-dates')?{dates:await h.dates(db,q.domain,q.timeZone,q.month+'-01'),domain:q.domain,month:q.month,timeZone:q.timeZone}:await h.list(db,{domain:q.domain,page:q.page,size:q.pageSize,sort:q.sort,start:q.startAt,end:q.endAt});
      }
    }catch(e){status=e.status??503;body={error:e.message,code:e.code??'OFFLINE_TEST_FAILURE'};}
    await route.fulfill({status,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(body)});
  });
  // Credentials remain private and are used only in the normal localhost UI.
  const accounts=Object.fromEntries(fs.readFileSync(process.env.TPS_TEST_ACCOUNTS_FILE,'utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
  await page.goto(origin+'/login?returnTo=%2Fstudent%2Fwordbook');await page.locator('#account').fill(accounts.STUDENT_EMAIL);await page.locator('#password').fill(accounts.STUDENT_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(origin+'/student/wordbook',{timeout:45000});await ready();
  assert.equal(await entries().count(),20);assert.equal(await page.getByRole('checkbox').count(),0);
  assert.deepEqual(await table().locator('th').allTextContents(),['序号','词条','词性','语境义','例句','派生']);
  assert.deepEqual(await entries().locator('td[data-label="序号"]').allTextContents(),Array.from({length:20},(_,i)=>String(i+1)));
  assert.equal(await entries().first().locator('td[data-label="序号"]').count(),1);assert.equal(await entries().first().locator('td[data-label="序号"]').getAttribute('rowspan'),'2');
  check('normal mode headers, 1–20 serials and one serial for multi-sense entry');
  const nav=page.getByRole('navigation',{name:'页面路径'});const color=async()=>nav.getByRole('link',{name:'学生首页',exact:true}).evaluate(e=>getComputedStyle(e).color);
  const readingColor=await color();await switchTab('writing');const writingColor=await color();assert.equal(readingColor,writingColor);assert.equal(readingColor,'rgb(107, 92, 246)');assert.deepEqual(await table().locator('th').allTextContents(),['序号','词条','词性','语境义','例句','常见搭配']);check('Learning Breadcrumb stays existing purple in both domains',{readingColor,writingColor});await switchTab('reading');
  // Reproduce the previous integer-width/span probe mismatch using this exact
  // real screenshot sentence and the old DOM structure, entirely off-layout.
  const mismatch=await entries().first().locator('td[data-label="例句"] p').first().evaluate((visible,text)=>{
    const host=document.createElement('div');Object.assign(host.style,{position:'absolute',visibility:'hidden',pointerEvents:'none',top:'0',left:'0'});visible.parentElement.appendChild(host);
    const probe=visible.cloneNode(false),actual=visible.cloneNode(false);host.append(probe,actual);
    const buttonClass=visible.querySelector('button').className;const graphemes=[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)];const line=parseFloat(getComputedStyle(visible).lineHeight);let result=null;
    try{for(let width=300;width<=500&&!result;width+=.125){probe.style.width=Math.round(width)+'px';actual.style.width=width+'px';const suffix=document.createElement('span');suffix.className=buttonClass;suffix.style.display='inline';suffix.textContent='...';let lo=0,hi=graphemes.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2),value=text.slice(0,mid<graphemes.length?graphemes[mid].index:text.length).trimEnd();probe.replaceChildren(document.createTextNode(value),suffix);if(probe.getBoundingClientRect().height<=line*2+.5)lo=mid;else hi=mid-1;}const value=text.slice(0,lo<graphemes.length?graphemes[lo].index:text.length).trimEnd(),button=document.createElement('button');button.className=buttonClass;button.style.display='inline';button.textContent='...';actual.replaceChildren(document.createTextNode(value),button);if(actual.getBoundingClientRect().height>line*2)result={actualWidth:width,oldProbeWidth:Math.round(width),actualHeight:actual.getBoundingClientRect().height,lineHeight:line,prefix:value};}}finally{host.remove();}return result;
  },h.sentence);assert.ok(mismatch,'Old screenshot sentence mismatch not reproduced');check('screenshot sentence reproduces old span/integer-width mismatch',{mismatch});
  for(const width of [1440,390,320])await layout(width);
  const first=entries().first(),toggle=first.getByRole('button',{name:'展开完整例句',exact:true}).first();await toggle.focus();await page.keyboard.press('Enter');assert.ok((await first.locator('td[data-label="例句"] p').first().innerText()).startsWith(h.sentence));assert.equal(await first.getByRole('button',{name:'展开完整例句',exact:true}).count(),1);await first.getByRole('button',{name:'收起例句',exact:true}).focus();await page.keyboard.press('Space');await layout(320);check('original full screenshot sentence, keyboard expansion/collapse and independent examples');
  // Font metrics change is real CSS measurement, not a fixed-character fallback.
  const fontStyle=await page.addStyleTag({content:'td[data-label="例句"] p { font-family: Georgia, serif; font-size: 17px; letter-spacing: .25px; }'});await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await layout(320);check('font/letter-spacing change remeasures with no ResizeObserver loop');
  await fontStyle.evaluate(e=>e.remove());await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'管理',exact:true}).click();assert.equal(await choices().count(),20);assert.ok(await deleteButton().isDisabled());await choices().first().check();assert.equal(await selected(),1);assert.ok(await all().evaluate(e=>e.indeterminate));await all().check();assert.equal(await selected(),20);await choices().first().uncheck();assert.equal(await selected(),19);assert.ok(await all().evaluate(e=>e.indeterminate));check('one checkbox per entry; current-page all/partial state');
  const deleteRequests=report.requests.filter(r=>r.action==='delete').length;await deleteButton().click();assert.ok(await dialog().getByText('确认删除选中的 19 个词条吗？',{exact:true}).isVisible());await dialog().getByRole('button',{name:'取消',exact:true}).click();assert.equal(await selected(),19);assert.equal(report.requests.filter(r=>r.action==='delete').length,deleteRequests);check('cancel confirmation performs no deletion and preserves selection');
  await readAction(()=>page.getByLabel('生词本排序').selectOption('oldest'));assert.equal(await selected(),0);assert.equal(await entries().first().locator('td[data-label="序号"]').innerText(),'1');assert.ok((await entries().first().innerText()).includes('insight'));await choices().first().check();await applyDate('2026-10-08');assert.equal(await selected(),0);assert.equal(await entries().first().locator('td[data-label="序号"]').innerText(),'1');check('sort/date changes clear selection and renumber');
  await choices().first().check();await switchTab('writing');assert.equal(await page.getByRole('checkbox').count(),0);assert.ok(await page.getByRole('button',{name:'管理',exact:true}).isVisible());check('Tab switch exits management');await switchTab('reading');await readAction(()=>page.getByLabel('生词本排序').selectOption('newest'));await page.getByRole('button',{name:'管理',exact:true}).click();await choices().first().check();await readAction(()=>page.getByRole('button',{name:'下一页',exact:true}).click());assert.equal(await entries().count(),1);assert.equal(await entries().first().locator('td[data-label="序号"]').innerText(),'21');assert.equal(await selected(),0);await all().check();assert.equal(await selected(),1);check('20+1 second page starts at 21; selection clears and all selects only its one entry');
  await page.getByRole('button',{name:'选择日期',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'上个月',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'2026-09-30，有收藏活动',exact:true}).waitFor();await page.mouse.click(2,200);
  failNext=true;await deleteButton().click();await dialog().getByRole('button',{name:'确认删除',exact:true}).click();await dialog().getByRole('alert').waitFor();assert.equal(await entries().count(),1);assert.equal(await selected(),1);check('delete failure does not remove row or lose selection');
  const wait=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/batch-delete')&&r.status()===200);await dialog().getByRole('button',{name:'确认删除',exact:true}).click();await wait;await page.waitForFunction(()=>document.querySelectorAll('tbody[data-wordbook-entry]').length===20&&document.querySelector('td[data-label="序号"]')?.textContent==='1');await ready();assert.ok(await page.getByText('已删除 1 个词条。',{exact:true}).isVisible());assert.equal(await page.getByLabel('生词本排序').inputValue(),'newest');await page.getByRole('button',{name:'选择日期',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'上个月',exact:true}).click();await page.getByRole('dialog').getByText('圆点表示有收藏活动；范围可在下方输入。',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').locator('[data-activity-dot]').count(),0);await page.mouse.click(2,200);check('successful atomic delete refreshes list/total, returns valid page and clears last September activity dot');
  await choices().first().check();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.getByRole('checkbox').count(),0);await page.getByRole('button',{name:'管理',exact:true}).click();assert.equal(await selected(),0);check('exit management clears selection');
  for(const width of [1440,390,320]){await layout(width);const file=path.join(output,`wordbook-management-${width}.png`);await entries().first().screenshot({path:file});report.screenshots.push(file);}
  // Date filter remains applied through deletion, and Writing never changes Reading.
  await switchTab('writing');await applyDate('2026-10-08');await page.getByRole('button',{name:'管理',exact:true}).click();
  for(const width of [1440,390,320])await layout(width);
  await all().check();const readingBefore=await h.list(db);await deleteButton().click();const done=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/batch-delete')&&r.status()===200);await dialog().getByRole('button',{name:'确认删除',exact:true}).click();await done;await page.waitForFunction(()=>document.querySelectorAll('tbody[data-wordbook-entry]').length===0);await ready();assert.ok(await page.getByText('2026-10-08',{exact:true}).isVisible());assert.deepEqual(await h.list(db),readingBefore);await page.getByRole('button',{name:'选择日期',exact:true}).click();await page.getByRole('dialog').getByText('圆点表示有收藏活动；范围可在下方输入。',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').locator('[data-activity-dot]').count(),0);check('Writing whole-page delete keeps applied date/sort, clears activity, Reading unchanged');
  assert.deepEqual(report.errors,[]);report.status='PASS';console.log(JSON.stringify({status:report.status,checks:report.checks.length,output},null,2));
})().catch(e=>{report.status='FAIL';report.errors.push(e.message);console.error(e.message);process.exitCode=1;}).finally(async()=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await db?.close();});
