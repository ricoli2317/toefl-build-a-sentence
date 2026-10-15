// Local UI verification against the REAL Phase 2/3 stores + isolated PGlite.
// Authentication uses only the ordinary localhost UI. No production CTW writes.
// Requires a normally started, Ready Next dev server; never starts one itself.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.CTW_BROWSER_PLAYWRIGHT||'playwright');
const {fixture,client,U}=require('../tests/helpers/ctwVocabularyFixture.cjs');
const store=require('../lib/ctw-vocabulary/store.server.ts'),input=require('../lib/ctw-vocabulary/input.ts');
const origin=process.env.CTW_BROWSER_ORIGIN;
if(!origin||new URL(origin).hostname!=='localhost')throw Error('Set CTW_BROWSER_ORIGIN to the confirmed Ready localhost origin.');
const ROOT='/student/ctw-vocabulary',API='/api/student/ctw-vocabulary';
const output=path.resolve('outputs/ctw-vocabulary-phase3/screenshots');
const credentials=Object.fromEntries(fs.readFileSync('.codex/tps-test-accounts.local','utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
const records=[],problems=[];
function pass(name){records.push({name,passed:true});console.log('PASS',name);}
async function main(){
  const db=await fixture(),browser=await chromium.launch({headless:true});
  try{
    fs.mkdirSync(output,{recursive:true});
    await db.exec(fs.readFileSync('outputs/ctw-vocabulary-phase3/ctw-vocabulary-phase3-install.sql','utf8'));
    await db.exec(fs.readFileSync('supabase/ctw_vocabulary_phase3_start_owner_fix.sql','utf8'));
    let queue=Promise.resolve(),posts=0,failBefore=0,failAfter=0;
    let plainCaptured=false, irregularCaptured=false;
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.route(`${origin}${API}**`,async route=>{
      const job=async()=>{
        const req=route.request(),url=new URL(req.url());
        if(!req.headers().authorization?.startsWith('Bearer ')){await route.fulfill({status:401,json:{error:'请先登录。'}});return;}
        try{
          let data;const c=client(db,'authenticated',U);
          if(url.pathname===`${API}/lists`)data=await store.readVocabularyLists(c,input.parseListEdition(url.searchParams));
          else if(url.pathname===`${API}/lists/start`)data=await store.startVocabularyList(c,input.parseListSource(req.postDataJSON()));
          else if(url.pathname===`${API}/attempts`&&req.method()==='POST'){
            posts++;
            if(failBefore-- >0){await route.fulfill({status:503,json:{error:'隔离数据库验证：模拟保存失败'}});return;}
            data=await store.saveVocabularyAttempt(client(db,'service_role',U),U,input.parseAttemptSubmission(req.postDataJSON()));
            if(failAfter-- >0){await route.abort('failed');return;}
          }else if(url.pathname===`${API}/attempts`)data=await store.readVocabularyHistory(c,U,input.parseHistoryQuery(url.searchParams));
          else if(url.pathname.startsWith(`${API}/attempts/`))data=await store.readVocabularyResult(c,U,url.pathname.split('/').at(-1));
          else throw Error('Unexpected isolated endpoint');
          await route.fulfill({status:200,json:data,headers:{'Cache-Control':'no-store'}});
        }catch(error){await route.fulfill({status:500,json:{error:error.message}});}
      };
      queue=queue.then(job,job);await queue;
    });
    const page=await context.newPage();page.setDefaultTimeout(30000);
    page.on('pageerror',e=>problems.push(e.message));
    const capture=async name=>{await page.screenshot({path:path.join(output,`${name}.png`),fullPage:true});};
    await page.goto(`${origin}/login`);
    await page.locator('#account').fill(credentials.STUDENT_EMAIL);await page.locator('#password').fill(credentials.STUDENT_PASSWORD);
    await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/student/**',{timeout:60000});
    await page.goto(`${origin}${ROOT}`);
    const cards=()=>page.getByRole('tabpanel').getByRole('button');
    await cards().nth(20).waitFor();assert.equal(await cards().count(),21);assert.match(await cards().nth(20).innerText(),/32 词/);
    assert.equal(await page.getByRole('link',{name:'开始测试',exact:true}).count(),0);
    await capture('desktop-mixed-directory');pass('desktop mixed directory: 21 Lists / tail 32 / no independent test entry');
    const nav=page.getByRole('navigation',{name:'学生端主导航'});
    assert.equal(await nav.getByRole('button',{name:'词汇学习'}).getAttribute('aria-expanded'),'true');
    assert.equal(await nav.getByRole('link',{name:'填词题词表',exact:true}).getAttribute('aria-current'),'page');
    await nav.getByRole('button',{name:'词汇学习'}).click();assert.equal(await nav.getByRole('link',{name:'生词本',exact:true}).count(),0);
    await nav.getByRole('button',{name:'词汇学习'}).click();pass('Sidebar parent expand/collapse and child activity');
    await cards().first().click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(page.url(),`${origin}${ROOT}`);
    await cards().first().click();await capture('desktop-list-confirm');
    await page.getByRole('button',{name:'确认',exact:true}).click();await page.waitForURL('**/session/**');
    const local=()=>page.evaluate(()=>{const id=location.pathname.split('/').at(-1);const key=Object.keys(localStorage).find(k=>k.startsWith('tps:ctw-vocabulary:v1:')&&k.endsWith(':'+id));return key?JSON.parse(localStorage.getItem(key)):null;});
    await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.startsWith('tps:ctw-vocabulary:v1:')));
    let data=await local();await page.getByRole('heading',{name:data.entries[0].word,exact:true}).waitFor();
    const originalIds=data.entries.map(e=>e.entry_id);
    for(let i=0;i<data.entries.length;i++){
      await page.getByRole('heading',{name:data.entries[i].word,exact:true}).waitFor();
      if(data.entries[i].senses.length>1){assert.equal(await page.locator('section[aria-label="填词题词表学习与测试"]').getByText(data.entries[i].senses[1].example_en,{exact:true}).count(),1);if(!records.some(r=>r.name==='multi-sense study layout')){await capture('desktop-multiple-senses');pass('multi-sense study layout');}}
      await page.getByRole('button',{name:i===data.entries.length-1?'开始测试':'下一个',exact:true}).click();
    }
    assert.deepEqual((await local()).entries.map(e=>e.entry_id),originalIds);pass('complete List learning uses exactly the same 50 words as spelling');
    await capture('desktop-spelling');
    async function answerAll(wrongFirst=false){
      const current=await local();
      for(let i=current.index;i<current.entries.length;i++){
        const entry=current.entries[i];
        const base=page.getByRole('group',{name:'原形拼写',exact:true}).getByRole('textbox');await base.waitFor();
        assert.equal(await page.getByRole('group',{name:'原形拼写',exact:true}).getByText('原形',{exact:true}).count(),entry.irregular_forms.length?1:0);
        await base.fill(wrongFirst&&i===0?'xxxxx':entry.word);
        for(let j=0;j<entry.irregular_forms.length;j++)await page.getByRole('textbox',{name:'英文拼写',exact:true}).nth(j+1).fill(entry.irregular_forms[j].answers.at(-1));
        if(!entry.irregular_forms.length&&!plainCaptured){
          await capture('desktop-plain-spelling');plainCaptured=true;
        }
        if(entry.irregular_forms.length)irregularCaptured=true;
        if(entry.irregular_forms.length&&!records.some(r=>r.name==='irregular input labels below independent fields')){
          const below=await page.getByRole('group').evaluateAll(nodes=>nodes.every(node=>{const field=node.querySelector('input'),label=node.querySelector('p');return !field||!label||field.getBoundingClientRect().top<label.getBoundingClientRect().top;}));
          assert.equal(below,true);await capture('desktop-irregular-spelling');pass('irregular input labels below independent fields');
        }
        if(['per capita','long-term','people'].includes(entry.word))assert.equal((await local()).draft.spelling,entry.word);
        await page.getByRole('button',{name:'确定',exact:true}).click();await page.getByRole('status').filter({hasText:wrongFirst&&i===0?'请查看各项':'全部拼写正确'}).waitFor();
        await page.getByRole('button',{name:i===current.entries.length-1?'保存并查看结果':'下一个',exact:true}).click();
      }
    }
    assert.equal(posts,0);failBefore=1;await answerAll();
    assert.ok(plainCaptured&&irregularCaptured);pass('plain words hide 原形; irregular words retain 原形 and form labels');
    await page.getByRole('alert').filter({hasText:'尚未确认保存'}).waitFor();assert.ok(page.url().includes('/session/'));
    await capture('desktop-save-retry');pass('failed submit never shows a saved completion state');
    await page.reload();await page.waitForURL('**/results/**');await page.getByText('100%',{exact:true}).waitFor();
    await capture('desktop-results');assert.equal(posts,2);pass('refresh restores pending whole-round submit and saves once');
    const savedId=page.url().split('/').at(-1);assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,1);
    await page.getByRole('link',{name:'返回填词题词表',exact:true}).click();await cards().first().getByText('已完成',{exact:true}).waitFor();assert.match(await cards().first().innerText(),/100%/);
    await capture('desktop-completed-badge');pass('successful 100% full List updates the green badge and highest score');
    await cards().first().click();await page.getByRole('button',{name:'确认',exact:true}).click();await page.waitForURL('**/session/**');
    await page.getByRole('button',{name:'跳过复习',exact:true}).click();await page.getByRole('button',{name:'确定',exact:true}).click();await answerAll(true);
    await page.waitForURL('**/results/**');await page.getByText('98%',{exact:true}).waitFor();
    await page.getByRole('link',{name:'返回填词题词表',exact:true}).click();await cards().first().getByText('已完成',{exact:true}).waitFor();assert.match(await cards().first().innerText(),/100%/);pass('lower later score does not lower best or completed status');
    await page.getByRole('tab',{name:'CEFR',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')==='CEFR 词表');
    await cards().nth(22).waitFor();assert.equal(await cards().count(),23);
    assert.match(await cards().nth(12).innerText(),/3 词/);await capture('desktop-cefr-directory');
    await cards().nth(12).click();assert.match(await page.getByRole('dialog').innerText(),/B1 List 04/);
    await page.getByRole('button',{name:'确认',exact:true}).click();await page.waitForURL('**/session/**');
    for(let i=0;i<3;i++){await page.getByRole('button',{name:i===2?'开始测试':'下一个',exact:true}).click();}
    failAfter=1;await answerAll();await page.getByRole('alert').filter({hasText:'尚未确认保存'}).waitFor();
    await page.getByRole('button',{name:'重试保存',exact:true}).click();await page.waitForURL('**/results/**');await page.getByText('100%',{exact:true}).waitFor();
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,3);pass('CEFR 3-word full flow; lost ACK retry is idempotent');
    await page.getByRole('link',{name:'返回填词题词表',exact:true}).click();await page.waitForURL('**/ctw-vocabulary?tab=cefr');
    await cards().nth(12).getByText('已完成',{exact:true}).waitFor();await capture('desktop-cefr-completed');
    const template=(await db.query('select * from ctw_vocabulary_entries limit 1')).rows[0];
    await db.query(`insert into ctw_vocabulary_entries(word,list_number,list_position,cefr,senses,irregular_forms,source_sha256)
      values('futureword',21,33,'B1',$1::jsonb,'[]',$2)`,[JSON.stringify(template.senses),template.source_sha256]);
    await page.reload();await cards().nth(12).getByText('进行中',{exact:true}).waitFor();assert.match(await cards().nth(12).innerText(),/100%/);await capture('desktop-cefr-after-append');pass('append keeps historical 100% but resets completion for current members');
    await page.setViewportSize({width:390,height:844});await page.reload();await cards().nth(22).waitFor();await capture('mobile-cefr-directory');
    await page.getByRole('button',{name:'打开导航',exact:true}).click();await nav.getByRole('link',{name:'填词题词表',exact:true}).waitFor();await capture('mobile-sidebar');
    await page.getByRole('button',{name:'关闭导航',exact:true}).last().click();pass('mobile directory and Sidebar activity');
    await cards().nth(12).click();await page.getByRole('button',{name:'确认',exact:true}).click();await page.waitForURL('**/session/**');
    await page.getByRole('button',{name:'跳过复习',exact:true}).click();await page.getByRole('button',{name:'确定',exact:true}).click();
    data=await local();await page.getByRole('group',{name:'原形拼写',exact:true}).getByRole('textbox').fill(data.entries[0].word);
    await capture('mobile-spelling');await page.reload();await page.getByRole('group',{name:'原形拼写',exact:true}).getByRole('textbox').waitFor();
    assert.equal((await local()).draft.spelling,data.entries[0].word);pass('mobile spelling draft survives refresh without replacing native input');
    const native=page.getByRole('group',{name:'原形拼写',exact:true}).getByRole('textbox');
    await native.fill('');await native.pressSequentially(data.entries[0].word+'excess');
    assert.equal((await local()).draft.spelling,data.entries[0].word);
    await native.evaluate(node=>{node.setSelectionRange(0,node.value.length);const clipboardData=new DataTransfer();clipboardData.setData('text',node.value);node.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));});
    assert.equal((await local()).draft.spelling,data.entries[0].word);pass('native mobile typing limits and selected paste preserve spelling');
    await page.setViewportSize({width:768,height:1024});await capture('ipad-spelling');
    assert.ok(await page.locator('section[aria-label="填词题词表学习与测试"]').evaluate(node=>node.scrollWidth<=innerWidth));pass('iPad spelling layout fits width');
    await page.goto(`${origin}/student/wordbook`);await page.getByRole('heading',{name:'生词本',exact:true}).waitFor();
    await page.getByRole('link',{name:'开始复习',exact:true}).waitFor();await capture('ipad-old-wordbook');
    await page.getByRole('link',{name:'开始复习',exact:true}).click();await page.getByRole('button',{name:'开始复习',exact:true}).waitFor();await capture('ipad-old-wordbook-settings');pass('original wordbook list and existing review settings still render');
    await page.goto(`${origin}${ROOT}/history`);await page.getByRole('link').filter({hasText:'查看结果'}).first().waitFor();
    await page.goto(`${origin}${ROOT}/results/${savedId}`);await page.getByText('100%',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox').count(),0);pass('history results remain read-only and refreshable');
    assert.deepEqual(problems,[]);
    fs.writeFileSync(path.join(output,'browser-verification.json'),JSON.stringify({verifiedAt:new Date().toISOString(),origin,database:'isolated PGlite, actual Phase 2/3 SQL and JS stores; normal localhost login; production CTW unchanged',records,problems},null,2));
  }finally{await browser.close();await db.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
