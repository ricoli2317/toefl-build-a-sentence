// Opt-in TARGETED UI check. Start normal pnpm dev and wait for Ready FIRST.
// No credentials embedded, no production writes. Login uses normal localhost UI.
// After checking the real missing-A3 response, intercept ONLY wordbook GETs and
// serve results from shipped A3 SQL in OFFLINE PGlite. Never call this production
// date-filter acceptance. Screenshots are taken only AFTER leaving login.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const origin = process.env.TPS_WORDBOOK_BROWSER_ORIGIN;
const accountsPath = process.env.TPS_TEST_ACCOUNTS_FILE;
const output = process.env.TPS_WORDBOOK_BROWSER_OUTPUT;
if (!origin || !accountsPath || !output || !process.env.TPS_PLAYWRIGHT_RUNTIME || !process.env.WORDBOOK_SQL_TEST_PGLITE) throw Error('Explicit verified localhost origin, account file, output and local runtimes required');
if (new URL(origin).hostname !== 'localhost') throw Error('Localhost only');
const { chromium } = require(process.env.TPS_PLAYWRIGHT_RUNTIME);
// Reuse precisely the offline fixtures and shipped RPC, without running tests.
const testPath = path.join(root, 'tests/studentWordbookA3.test.js');
const source = fs.readFileSync(testPath, 'utf8');
const helper = vm.runInNewContext(source.slice(0, source.indexOf("test('API")) + '\n({fixture,save,list,dates,U,E,O});', {
  require: createRequire(testPath), __dirname: path.dirname(testPath), process, console
});

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const db = await helper.fixture();
  const browser = await chromium.launch({ headless: true, channel: process.env.TPS_PLAYWRIGHT_CHANNEL ?? 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage();
  const report = { scope: 'LOCAL UI + OFFLINE shipped A3 SQL; NOT production acceptance', checks: [], realApi: [], viewports: [], fixtureRequests: [] };
  const errors = [];
  let fixtureMode = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (!fixtureMode && response.url().startsWith(`${origin}/api/student/wordbook`)) report.realApi.push({ path: new URL(response.url()).pathname, status: response.status(), cacheControl: response.headers()['cache-control'] }); });
  try {
    const accounts = Object.fromEntries(fs.readFileSync(accountsPath,'utf8').split(/\r?\n/).filter(line=>line.includes('=')&&!line.trim().startsWith('#')).map(line=>{ const i=line.indexOf('=');return [line.slice(0,i).trim(),line.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
    await page.goto(`${origin}/login?returnTo=%2Fstudent%2Fwordbook`);
    await page.locator('#account').fill(accounts.STUDENT_EMAIL);
    await page.locator('#password').fill(accounts.STUDENT_PASSWORD);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.waitForURL(`${origin}/student/wordbook`,{ timeout:60000 });
    await page.getByRole('heading',{name:'生词本',exact:true}).waitFor();
    await page.getByText('生词本读取暂不可用；若尚未安装 A3 SQL，请完成安装后重试。',{exact:true}).waitFor({ timeout:60000 });
    assert.ok(report.realApi.some(r=>r.status===503&&r.cacheControl==='no-store'));
    const anonymous = await page.evaluate(async()=> (await fetch('/api/student/wordbook',{cache:'no-store'})).status);
    assert.equal(anonymous,401);
    report.checks.push('real authenticated API explicitly unavailable before A3; no-store; anonymous 401');
    const links=await page.locator('nav[aria-label="学生端主导航"] a').evaluateAll(elements=>elements.map(e=>({href:e.getAttribute('href'),text:e.textContent})));
    const wrong=links.findIndex(l=>l.href==='/student/wrong-questions');
    assert.equal(links[wrong+1].href,'/student/wordbook');
    assert.equal(await page.locator('nav[aria-label="页面路径"]').innerText(),'学习\n/\n生词本');
    report.checks.push('sidebar directly under wrong questions, active link, breadcrumb 学习 / 生词本');

    await helper.save(db);
    await db.query(`update lexical_occurrences set context_meaning_zh='保持运行；维持' where occurrence_id=$1`,[helper.O]);
    await helper.save(db);
    const long='We run the research programme in a way that preserves every original detail, including evidence from different contexts, because readers should be able to inspect the complete source sentence without losing any of its meaning or wording when they expand this example.';
    await db.query('update lexical_occurrences set context_text=$1 where occurrence_id=$2',[long,helper.O]);await helper.save(db);
    await db.query(`update lexical_occurrences set source_type='rdl' where occurrence_id=$1`,[helper.O]);await db.exec(`update lexical_source_blocks set source_type='rdl',block_kind='rdl_material'`);await helper.save(db);
    await db.query(`update lexical_occurrences set source_type='rap' where occurrence_id=$1`,[helper.O]);await db.exec(`update lexical_source_blocks set source_type='rap',block_kind='rap_paragraph'`);await helper.save(db);
    // Snapshot times below are OFFLINE fixture facts for the supplied example dates.
    const word=(await helper.list(db)).items[0].wordbookEntryId;
    await db.exec('delete from student_wordbook_activities');
    for (const at of ['2026-10-07T16:00:00Z','2026-10-09T16:00:00Z','2026-10-11T16:00:00Z']) await db.query(`insert into student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at) values($1,$2,'reading','append',$3)`,[word,helper.U,at]);
    for (const source of ['bas','write_email','academic_discussion']) {
      await db.query(`update lexical_occurrences set source_type=$1 where occurrence_id=$2`,[source,helper.O]);await db.query('update lexical_source_blocks set source_type=$1,block_kind=$2',[source,source==='bas'?'bas_prompt':source==='write_email'?'email_scenario':'academic_student_response']);await helper.save(db);
    }
    await db.query(`update lexical_entries set useful_patterns='[{"pattern":"run a business","meaning_zh":"经营企业"}]' where entry_id=$1`,[helper.E]);
    const { parseWordbookQuery } = require('../lib/lexical/wordbookList.ts');
    fixtureMode = true;
    await page.route(`${origin}/api/student/wordbook**`,async route=>{
      const url=new URL(route.request().url());const q=parseWordbookQuery(url.searchParams);
      report.fixtureRequests.push({path:url.pathname,domain:q.domain,page:q.page,sort:q.sort,start:q.startAt,end:q.endAt,month:q.month});
      const payload=url.pathname.endsWith('/activity-dates')
        ? { dates:await helper.dates(db,q.domain,q.timeZone,`${q.month}-01`),domain:q.domain,month:q.month,timeZone:q.timeZone }
        : await helper.list(db,{domain:q.domain,page:q.page,size:q.pageSize,sort:q.sort,start:q.startAt,end:q.endAt});
      await route.fulfill({status:200,contentType:'application/json',headers:{'Cache-Control':'no-store'},body:JSON.stringify(payload)});
    });
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.locator('tbody[data-wordbook-entry]').waitFor();
    assert.deepEqual(await page.locator('thead th').allTextContents(),['单词','词性','语境义','例句','派生']);
    assert.equal(await page.locator('tbody[data-wordbook-entry]').count(),1);
    assert.equal(await page.locator('td[data-label="语境义"]').count(),2);
    assert.equal(await page.locator('td[data-label="例句"]').count(),3);
    assert.equal(await page.locator('td[data-label="派生"]').first().innerText(),'—');
    const wordAlignment=await page.locator('td[data-label="单词"]').evaluate(e=>getComputedStyle(e).verticalAlign);assert.equal(wordAlignment,'middle');
    const expand=page.getByRole('button',{name:'展开全文',exact:true}).first();await expand.waitFor();
    const paragraph=page.locator('td[data-label="例句"] p').filter({hasText:long}).first();assert.ok(await paragraph.evaluate(e=>e.clientHeight<=48));
    await expand.click();assert.ok(await paragraph.evaluate(e=>e.clientHeight>48));assert.equal(await paragraph.textContent(),long);
    assert.equal(await page.getByRole('button',{name:'收起',exact:true}).count(),1);
    await page.getByRole('button',{name:'收起',exact:true}).click();assert.ok(await paragraph.evaluate(e=>e.clientHeight<=48));
    report.checks.push('reading five columns, multiple senses/linked examples fully present, word vertically centred, empty derived —, independent exact-text expand/collapse');
    await page.screenshot({path:path.join(output,'reading-desktop.png'),fullPage:true});
    await page.getByRole('button',{name:'选择日期',exact:true}).click();
    await page.locator('[data-activity-dot]').first().waitFor();assert.equal(await page.locator('[data-activity-dot]').count(),3);
    const beforeMonth=report.fixtureRequests.filter(r=>!r.month).length;
    await page.getByRole('button',{name:'下个月',exact:true}).click();await page.getByText('2026年11月',{exact:true}).waitFor();
    await page.getByRole('button',{name:'上个月',exact:true}).click();await page.getByText('2026年10月',{exact:true}).waitFor();
    assert.equal(report.fixtureRequests.filter(r=>!r.month).length,beforeMonth);
    await page.getByRole('button',{name:'2026-10-10，有收藏活动',exact:true}).click();await page.getByRole('button',{name:'查看当天',exact:true}).click();
    await page.getByText('2026-10-10',{exact:true}).waitFor();await page.locator('tbody[data-wordbook-entry]').waitFor();assert.equal(await page.locator('td[data-label="例句"]').count(),3);
    await page.getByRole('button',{name:'选择日期',exact:true}).click();await page.getByLabel('开始日期',{exact:true}).fill('2026-10-08');await page.getByLabel('结束日期',{exact:false}).fill('2026-10-12');
    await page.getByRole('button',{name:'查看日期范围',exact:true}).click();await page.getByText('2026-10-08 — 2026-10-12',{exact:true}).waitFor();await page.locator('tbody[data-wordbook-entry]').waitFor();assert.equal(await page.locator('tbody[data-wordbook-entry]').count(),1);
    await page.getByLabel('生词本排序').selectOption('oldest');await page.locator('tbody[data-wordbook-entry]').waitFor();
    report.checks.push('month dots from domain/month SQL, month switching no list reload, day/range selection retains all contexts, dedupe, sort request');
    await page.getByRole('tab',{name:'Writing',exact:true}).click();await page.getByRole('table',{name:'Writing 生词表'}).waitFor();await page.locator('tbody[data-wordbook-entry]').waitFor();
    assert.deepEqual(await page.locator('thead th').allTextContents(),['单词','词性','语境义','例句','常见搭配']);
    for(const label of ['BAS','WE','AD']) assert.ok(await page.getByText(label,{exact:true}).first().isVisible());
    assert.ok(await page.getByText('run a business',{exact:true}).first().isVisible());
    const badge=await page.getByText('BAS',{exact:true}).first().evaluate(e=>getComputedStyle(e).color);assert.notEqual(badge,'rgb(52, 127, 220)');
    await page.getByRole('button',{name:'选择日期',exact:true}).click();
    await page.locator('[data-activity-dot]').first().waitFor();assert.equal(await page.locator('[data-activity-dot]').count(),1);
    await page.getByRole('button',{name:'清除日期选择',exact:true}).click();
    report.checks.push('writing independent table/sources/patterns, distinct existing writing theme, separate filter state');
    await page.screenshot({path:path.join(output,'writing-desktop.png'),fullPage:true});
    for (const width of [1440,1024,768,390,320]) {
      await page.setViewportSize({width,height:1000});
      await page.getByRole('tab',{name:'Reading',exact:true}).click();await page.locator('tbody[data-wordbook-entry]').waitFor();
      const bounds=await page.evaluate(()=>({viewport:innerWidth,body:document.documentElement.scrollWidth,table:document.querySelector('table').getBoundingClientRect().width}));
      assert.ok(bounds.body<=width,`overflow at ${width}: ${JSON.stringify(bounds)}`);report.viewports.push(bounds);
      if(width===390) await page.screenshot({path:path.join(output,'reading-mobile.png'),fullPage:true});
      if(width===320) {await page.getByRole('button',{name:'选择日期',exact:true}).click();assert.ok(await page.getByLabel('开始日期',{exact:true}).isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.keyboard.press('Escape');}
    }
    report.checks.push('no horizontal viewport overflow desktop/tablet/mobile incl 320px date popover');
    await page.getByRole('button',{name:'清除',exact:true}).click();await page.locator('tbody[data-wordbook-entry]').waitFor();
    // Generate ONLY small offline SQL fixtures to exercise actual bounded UI
    // paging. Each row is saved using the shipped A3 RPC, not a fabricated total.
    for(let i=0;i<20;i++) {
      const uuid=n=>`00000000-0000-4000-8000-${String(n+i).padStart(12,'0')}`;
      const e=uuid(100),o=uuid(200),b=uuid(300),content=`paragraph:ui-${i}`;
      await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant)
        values($1,$2,$2,'word','')`,[e,`offline-${i}`]);
      await db.query(`insert into lexical_occurrences(occurrence_id,entry_id,source_type,source_item_id,content_block_id,start_offset,end_offset,surface_text,context_text,context_pos,context_meaning_zh,context_definition_en)
        select $1,$2,'ctw',source_item_id,$3,start_offset,end_offset,surface_text,context_text,context_pos,context_meaning_zh,context_definition_en from lexical_occurrences where occurrence_id=$4`,[o,e,content,helper.O]);
      await db.query(`insert into lexical_source_blocks select $1,'ctw',source_item_id,$2,'ctw_paragraph',source_text_hash,generation_status from lexical_source_blocks limit 1`,[b,content]);
      await helper.save(db,'save',helper.U,o);
    }
    await page.reload();await page.getByText('共 21 个词汇 · 第 1 / 2 页',{exact:true}).waitFor();assert.equal(await page.locator('tbody[data-wordbook-entry]').count(),20);
    await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByText('共 21 个词汇 · 第 2 / 2 页',{exact:true}).waitFor();assert.equal(await page.locator('tbody[data-wordbook-entry]').count(),1);
    await page.getByRole('button',{name:'上一页',exact:true}).click();await page.getByText('共 21 个词汇 · 第 1 / 2 页',{exact:true}).waitFor();report.checks.push('actual SQL-backed UI paging 20/1 records, previous/next controls');
    await db.exec('delete from student_wordbook_entries');await page.reload();await page.getByText('还没有 Reading 生词。',{exact:false}).waitFor();report.checks.push('empty wordbook hint');
    // The same extracted form still performs the existing history day/range URL
    // interactions. Only targeted GET payloads intercepted, no history writes.
    await page.route(`${origin}/api/student/practice-history**`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({range:{},reading:null,writing:null,days:[]})}));
    await page.goto(`${origin}/student/practice-history`);await page.getByRole('button',{name:'选择日期',exact:true}).click();
    await page.getByLabel('开始日期',{exact:true}).fill('2026-10-06');await page.getByLabel('结束日期',{exact:false}).fill('2026-10-06');await page.getByRole('button',{name:'查看当天',exact:true}).click();
    await page.waitForURL(url=>url.searchParams.get('date')==='2026-10-06');
    await page.getByRole('button',{name:'选择日期',exact:true}).click();await page.getByLabel('开始日期',{exact:true}).fill('2026-10-06');await page.getByLabel('结束日期',{exact:false}).fill('2026-10-12');await page.getByRole('button',{name:'查看范围统计',exact:true}).click();
    await page.waitForURL(url=>url.searchParams.get('view')==='range'&&url.searchParams.get('end')==='2026-10-12');report.checks.push('practice-history extracted date form preserves existing day/range navigation');
    report.pageErrors=errors;assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({scope:report.scope,checks:report.checks,viewports:report.viewports,output},null,2));
  } finally { await browser.close();await db.close(); }
})().catch(error=>{ console.error(error.message);process.exitCode=1; });
