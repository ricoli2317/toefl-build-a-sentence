// Opt-in concentrated local UI verification. Normal pnpm dev + Ready FIRST.
// One localhost origin, normal login UI, no production write SQL/API calls.
// Wordbook reads below use OFFLINE PGlite after observing the real read API.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{createRequire}=require('node:module');
const origin=process.env.TPS_WORDBOOK_BROWSER_ORIGIN,output=process.env.TPS_WORDBOOK_BROWSER_OUTPUT;
if(!origin||new URL(origin).hostname!=='localhost'||!output||!process.env.TPS_TEST_ACCOUNTS_FILE||!process.env.TPS_PLAYWRIGHT_RUNTIME||!process.env.WORDBOOK_SQL_TEST_PGLITE)throw Error('Explicit started localhost origin, output, private account file and offline runtimes required');
const {chromium}=require(process.env.TPS_PLAYWRIGHT_RUNTIME);
const file=path.join(__dirname,'studentWordbookA3.test.js'),source=fs.readFileSync(file,'utf8');
const h=vm.runInNewContext(source.slice(0,source.indexOf("test('API"))+'\n({fixture,save,list,dates,read,U,E,O});',{require:createRequire(file),__dirname,process,console});
const {parseWordbookQuery}=require('../lib/lexical/wordbookList.ts');
const report={scope:'LOCAL UI + OFFLINE incrementally upgraded SQL. Popup on real BAS/RAP layouts with intercepted mutation feedback. NOT production save acceptance.',checks:[],realRead:[],requests:[],popup:[],errors:[]};
(async()=>{
  fs.mkdirSync(output,{recursive:true});const db=await h.fixture();await db.exec(h.read('supabase/student_wordbook_v1_bugfix_20261008.sql'));
  const browser=await chromium.launch({headless:true,channel:'chrome'}),context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'}),page=await context.newPage();
  page.setDefaultTimeout(30000);page.on('pageerror',e=>report.errors.push(e.message));
  // Safety net installed before any page action. Save/remove NEVER reach production.
  await context.route(`${origin}/api/lexical/wordbook`,async route=>{
    const r=route.request().postDataJSON();await new Promise(resolve=>setTimeout(resolve,80));
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({saved:r.action==='save',domain:['ctw','rdl','rap'].includes(r.selection.sourceType)?'reading':'writing',available:true,wordbookEntryId:'offline-browser-state-only'})});
  });
  try {
    const accounts=Object.fromEntries(fs.readFileSync(process.env.TPS_TEST_ACCOUNTS_FILE,'utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
    await page.goto(`${origin}/login?returnTo=%2Fstudent%2Fwordbook`);await page.locator('#account').fill(accounts.STUDENT_EMAIL);await page.locator('#password').fill(accounts.STUDENT_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(`${origin}/student/wordbook`,{timeout:60000});
    await page.getByRole('heading',{name:'生词本',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[role="tabpanel"]')?.getAttribute('aria-busy')==='false');
    report.realRead.push('real authenticated wordbook GET rendered without fixture interception');
    assert.ok(await page.getByRole('link',{name:'返回',exact:true}).isVisible());assert.equal(await page.getByRole('link',{name:'学生首页',exact:true}).getAttribute('href'),'/student/sets');
    report.checks.push('existing back button + linked 学生首页 / 生词本 breadcrumb');
    await h.save(db);
    const long='We run the research programme in a way that preserves every original detail, including evidence from different contexts, because readers should be able to inspect the complete source sentence without losing any of its meaning or wording when they expand this example.';
    const mixed='We run 中文测试，保留完整原文和标点。'+ '英文及中文 mixed language，'.repeat(12)+'supercalifragilisticexpialidocious'.repeat(5)+' 👨‍👩‍👧‍👦😀!';
    for(const text of [long,mixed]){await db.query('update lexical_occurrences set context_text=$1 where occurrence_id=$2',[text,h.O]);await h.save(db);}
    const word=(await h.list(db)).items[0].wordbookEntryId;
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const yesterdayDate=new Date(`${today}T00:00:00Z`);yesterdayDate.setUTCDate(yesterdayDate.getUTCDate()-1);const yesterday=yesterdayDate.toISOString().slice(0,10);
    await db.exec('delete from student_wordbook_activities');for(const date of ['2026-07-10',yesterday])await db.query(`insert into student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at) values($1,$2,'reading','append',$3)`,[word,h.U,`${date}T02:00:00Z`]);
    await db.exec(`update lexical_occurrences set source_type='bas';update lexical_source_blocks set source_type='bas',block_kind='bas_prompt'`);await h.save(db);
    let heldResolve,holdReading=false;
    await page.route(`${origin}/api/student/wordbook**`,async route=>{
      const url=new URL(route.request().url()),q=parseWordbookQuery(url.searchParams);report.requests.push({path:url.pathname,query:url.search});
      const payload=url.pathname.endsWith('activity-dates')?{dates:await h.dates(db,q.domain,q.timeZone,`${q.month}-01`)}:await h.list(db,{domain:q.domain,page:q.page,size:q.pageSize,sort:q.sort,start:q.startAt,end:q.endAt});
      if(holdReading&&q.domain==='reading'){await new Promise(resolve=>{heldResolve=resolve;});holdReading=false;}
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)}).catch(()=>{});
    });
    await page.reload();await page.locator('tbody[data-wordbook-entry]').waitFor();
    const reading=page.getByRole('tab',{name:'Reading',exact:true}),writing=page.getByRole('tab',{name:'Writing',exact:true});
    assert.equal(await reading.evaluate(e=>getComputedStyle(e).color),'rgb(52, 127, 220)');
    const pos=page.locator('td[data-label="词性"]').first();assert.equal(await pos.innerText(),'v.');assert.deepEqual(await pos.evaluate(e=>[getComputedStyle(e).textAlign,getComputedStyle(e).verticalAlign]),['center','middle']);
    assert.ok(await page.getByLabel('生词本排序').evaluate(e=>parseFloat(getComputedStyle(e).paddingRight)>=36));await page.getByLabel('生词本排序').selectOption('oldest');await page.locator('tbody[data-wordbook-entry]').waitFor();
    report.checks.push('Reading blue, compact centred abbreviated POS, padded select retains oldest sorting');
    async function checkExamples(width){
      await page.setViewportSize({width,height:1000});await page.waitForTimeout(100);
      const expand=page.getByRole('button',{name:'展开完整例句',exact:true});assert.ok(await expand.count()>=2);
      const bounds=await expand.evaluateAll(bs=>bs.map(b=>{const p=b.parentElement,r=p.getBoundingClientRect(),s=b.getBoundingClientRect();return{height:r.height,buttonBottom:s.bottom-r.top,buttonRight:s.right-r.left,width:r.width};}));
      for(const b of bounds){assert.ok(b.height<=48.5,JSON.stringify(b));assert.ok(b.buttonBottom<=48.5);assert.ok(b.buttonRight<=b.width+0.5);}
      await expand.first().focus();await page.keyboard.press('Enter');const collapse=page.getByRole('button',{name:'收起例句',exact:true});assert.equal(await collapse.count(),1);const full=await collapse.locator('..').textContent();assert.ok(full.startsWith(long));await collapse.click();assert.equal(await collapse.count(),0);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    await checkExamples(1440);await checkExamples(390);await checkExamples(320);await page.setViewportSize({width:1440,height:1000});
    report.checks.push('desktop/390/320: two-line inline keyboard ellipsis, independent full-source expand/collapse, mixed Chinese/English/long-token wrapping without overflow');
    const openDate=()=>page.getByRole('button',{name:'选择日期',exact:true}).click();await openDate();
    const prev=page.getByRole('button',{name:'上个月',exact:true}),next=page.getByRole('button',{name:'下个月',exact:true});assert.ok(await next.isDisabled());
    const before=report.requests.filter(r=>r.path==='/api/student/wordbook').length;
    for(let i=0;i<12&&!await prev.isDisabled();i++)await prev.click();await page.getByText('2026年7月',{exact:true}).waitFor();assert.ok(await prev.isDisabled());
    await next.click();await page.getByText('2026年8月',{exact:true}).waitFor();assert.ok(await prev.isEnabled());assert.ok(await next.isEnabled());
    await page.getByRole('button',{name:'今天',exact:true}).click();assert.ok(await next.isDisabled());assert.equal(report.requests.filter(r=>r.path==='/api/student/wordbook').length,before);
    assert.equal(await page.locator('[aria-current="date"]').evaluate(e=>getComputedStyle(e).color),'rgb(52, 127, 220)');
    assert.equal(await page.getByLabel('开始日期',{exact:true}).getAttribute('min'),'2026-07-01');assert.equal(await page.getByLabel('开始日期',{exact:true}).getAttribute('max'),today);
    await page.getByLabel('开始日期',{exact:true}).fill('2026-06-30');assert.ok(await page.getByRole('button',{name:'查看当天',exact:true}).isDisabled());
    await page.getByLabel('开始日期',{exact:true}).fill(today);await page.getByLabel('结束日期',{exact:false}).fill('2026-07-01');assert.ok(await page.getByRole('button',{name:'查看日期范围',exact:true}).isDisabled());
    await page.getByLabel('开始日期',{exact:true}).fill(yesterday);await page.getByLabel('结束日期',{exact:false}).fill(yesterday);await page.getByRole('button',{name:'查看当天',exact:true}).click();await page.getByText(yesterday,{exact:true}).waitFor();
    await openDate();await page.getByLabel('开始日期',{exact:true}).fill('2026-07-01');await page.getByRole('button',{name:'今天',exact:true}).click();assert.ok(await page.getByText(yesterday,{exact:true}).isVisible());assert.equal(await page.getByLabel('开始日期',{exact:true}).inputValue(),'2026-07-01');
    await page.keyboard.press('Escape');await writing.click();await page.locator('tbody[data-wordbook-entry]').waitFor();await page.getByText('全部日期',{exact:true}).waitFor();await page.waitForFunction(()=>getComputedStyle(document.getElementById('wordbook-tab-writing')).color==='rgb(107, 92, 246)');await openDate();assert.equal(await page.getByLabel('开始日期',{exact:true}).inputValue(),'');assert.equal(await page.getByLabel('结束日期',{exact:false}).inputValue(),'');await page.locator('[data-activity-dot]').waitFor();assert.equal(await page.locator('[data-activity-dot]').count(),1);assert.equal(await page.locator('[data-activity-dot]').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(107, 92, 246)');
    await page.getByRole('button',{name:'清除日期选择',exact:true}).click();await reading.click();await page.getByText('全部日期',{exact:true}).waitFor();await openDate();assert.equal(await page.getByLabel('开始日期',{exact:true}).inputValue(),'');await page.locator('[data-activity-dot]').waitFor();assert.equal(await page.locator('[data-activity-dot]').count(),1);assert.equal(await page.locator('[data-activity-dot]').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(52, 127, 220)');await page.keyboard.press('Escape');
    report.checks.push('July/current arrow bounds, middle months, Today no-submit/applied-filter unchanged, date inputs reject out-of-range/reversed, tabs reset applied+draft dates, isolated domain dots and theme');
    holdReading=true;await page.getByLabel('生词本排序').selectOption('newest');await page.waitForFunction(()=>document.querySelector('[role="tabpanel"]')?.getAttribute('aria-busy')==='true');await writing.click();await page.locator('tbody[data-wordbook-entry]').waitFor();heldResolve?.();await page.waitForTimeout(200);assert.ok(await page.getByRole('table',{name:'Writing 生词表',exact:true}).isVisible());assert.ok(await page.getByText('BAS',{exact:true}).isVisible());
    report.checks.push('delayed old-domain response cannot overwrite the new tab; sort preserved');
    for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});await openDate();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.keyboard.press('Escape');}
    await page.screenshot({path:path.join(output,'wordbook-mobile.png')});
    // Targeted history default behavior, using its normal read-only UI.
    await page.goto(`${origin}/student/practice-history`);await openDate();assert.equal(await page.getByLabel('开始日期',{exact:true}).getAttribute('min'),null);await page.getByLabel('开始日期',{exact:true}).fill('2026-06-01');await page.getByLabel('结束日期',{exact:false}).fill('2026-06-01');await page.getByRole('button',{name:'查看当天',exact:true}).click();await page.waitForURL(u=>u.searchParams.get('date')==='2026-06-01');
    await openDate();await page.getByLabel('结束日期',{exact:false}).fill('2026-06-03');await page.getByRole('button',{name:'查看范围统计',exact:true}).click();await page.waitForURL(u=>u.searchParams.get('view')==='range'&&u.searchParams.get('end')==='2026-06-03');report.checks.push('practice-history pre-July day/range navigation unchanged');
    // Real BAS/RAP DOM layouts + real lookup reads, mutations intercepted above.
    await page.route(`${origin}/api/lexical/lookup`,async route=>{
      const response=await route.fetch(),data=await response.json();
      // Deliberately tall verified lookup result tests the former constrained
      // height loop. This is UI geometry only, not a new corpus definition.
      if(data.status==='matched')data.occurrence.context_definition_en += ' Height-change regression fixture.'.repeat(70);
      await route.fulfill({response,json:data});
    });
    for(const [name,resultPath] of [['BAS',process.env.TPS_BAS_RESULT_PATH],['RAP',process.env.TPS_RAP_RESULT_PATH]]){
      if(!resultPath){report.popup.push({name,status:'NOT_RUN',reason:'no existing result path supplied'});continue;}
      await page.setViewportSize({width:1024,height:650});await page.goto(new URL(resultPath,origin).href);
      if(name==='BAS'){const chips=page.getByTestId('practice-result-question-chips').getByRole('button');await chips.first().waitFor();await chips.first().click();}
      await page.locator('[data-lexical-block]').first().waitFor();
      const card=page.getByRole('dialog',{name:'语境查词',exact:true});let matched=false;
      for(let candidate=0;candidate<3&&!matched;candidate++){
        await page.locator('[data-lexical-block]').first().scrollIntoViewIfNeeded();const response=page.waitForResponse(r=>r.url()===`${origin}/api/lexical/lookup`);
        await page.locator('[data-lexical-block]').first().evaluate((e,index)=>{const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let node,count=0;while(node=walker.nextNode())for(const m of node.textContent.matchAll(/\b[A-Za-z]{4,}\b/g)){if(count++!==index)continue;const r=document.createRange();r.setStart(node,m.index);r.setEnd(node,m.index+m[0].length);window.getSelection().removeAllRanges();window.getSelection().addRange(r);e.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));return;}throw Error('No candidate');},candidate);
        matched=(await (await response).json()).status==='matched';if(!matched)await page.keyboard.press('Escape');
      }
      assert.ok(matched,`${name} lookup match`);await card.getByRole('button',{name:/加入生词本|已加入/}).waitFor();
      async function sample(label){const samples=await card.evaluate(async e=>{const values=[];for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);const r=e.getBoundingClientRect();values.push({top:r.top,height:r.height,side:e.dataset.placement});}return values;});assert.equal(new Set(samples.slice(5).map(s=>`${s.top}:${s.side}`)).size,1,`${name} ${label} oscillates`);report.popup.push({name,label,...samples.at(-1)});}
      await sample('before');await card.getByRole('button',{name:/加入生词本|已加入/}).click();await card.getByText(/已加入生词本。|已取消收藏。/).waitFor();await sample('after intercepted mutation');
      const scrollArea=card.locator(':scope > div').first();assert.ok(await scrollArea.evaluate(e=>e.scrollHeight>e.clientHeight));await scrollArea.evaluate(e=>{e.scrollTop=80;});await sample('internal scroll');
      if(name==='BAS')await card.getByRole('button',{name:'关闭查词',exact:true}).click();else await page.keyboard.press('Escape');assert.ok(!await card.isVisible());
    }
    assert.deepEqual(report.errors,[]);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await browser.close();await db.close();}
})().catch(e=>{fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({message:e.message,report},null,2));console.error(e.stack);process.exitCode=1;});
