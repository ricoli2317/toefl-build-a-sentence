// Local unified-flow verification: normal localhost login, CTW API backed ONLY
// by isolated PGlite + actual server adapters. No production CTW records.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {chromium}=require(process.env.CTW_BROWSER_PLAYWRIGHT||'playwright');
const {fixture,client,U,read,source}=require('../tests/helpers/ctwVocabularyFixture.cjs');
const store=require('../lib/ctw-vocabulary/store.server.ts');
const server=require('../lib/ctw-vocabulary/review.server.ts');
const input=require('../lib/ctw-vocabulary/input.ts');
const origin=process.env.CTW_BROWSER_ORIGIN;
if(!origin||new URL(origin).hostname!=='localhost')throw Error('Use the localhost origin reported Ready by Next.');
const ROOT='/student/ctw-vocabulary',API='/api/student/ctw-vocabulary',REVIEW=API+'/review';
const out=path.resolve('outputs/ctw-vocabulary-unification/screenshots');
const account=Object.fromEntries(fs.readFileSync('.codex/tps-test-accounts.local','utf8').split(/\r?\n/).filter(s=>s.includes('=')).map(s=>{const n=s.indexOf('=');return[s.slice(0,n),s.slice(n+1)];}));
const checks=[],errors=[],counts={};
function pass(name){checks.push({name,passed:true});console.log('PASS',name);}
async function main(){
  fs.mkdirSync(out,{recursive:true});const db=await fixture(),browser=await chromium.launch({headless:true});
  let page,blocked=false,failures=0,queue=Promise.resolve();
  try{
    for(const file of ['outputs/ctw-vocabulary-phase3/ctw-vocabulary-phase3-install.sql','supabase/ctw_vocabulary_phase3_start_owner_fix.sql','supabase/ctw_vocabulary_american_spelling.sql','supabase/ctw_vocabulary_american_spelling_verify.sql','supabase/ctw_vocabulary_review_sync.sql','supabase/ctw_vocabulary_review_sync_verify.sql'])await db.exec(read(file));
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    await context.route(origin+API+'**',async route=>{
      const job=async()=>{
        const request=route.request(),url=new URL(request.url());
        counts[url.pathname+url.search]=(counts[url.pathname+url.search]||0)+1;
        if(!request.headers().authorization?.startsWith('Bearer ')){await route.fulfill({status:401,json:{error:'请先登录。'}});return;}
        if(blocked&&request.method()==='POST'&&url.pathname.startsWith(REVIEW+'/')){failures++;await route.fulfill({status:503,json:{error:'隔离测试：临时断网',code:'REVIEW_NETWORK'}});return;}
        try{
          const c=client(db,'authenticated',U),service=client(db,'service_role',U);let data;
          if(url.pathname===API+'/lists')data=await store.readVocabularyLists(c,input.parseListEdition(url.searchParams));
          else if(url.pathname===REVIEW&&request.method()==='POST')data=await server.createCtwReview(c,service,U,server.parseCtwReviewStart(request.postDataJSON()));
          else if(url.pathname===REVIEW)data=await server.readCtwReviewHistory(c,Number(url.searchParams.get('page')||1));
          else if(url.pathname.startsWith(REVIEW+'/')){
            const id=url.pathname.split('/').at(-1);
            data=request.method()==='POST'?await server.syncCtwReview(service,U,id,server.parseCtwReviewCommand(request.postDataJSON().command)):await server.readCtwReview(c,U,id);
          }else throw Error('Unexpected CTW endpoint '+url.pathname);
          await route.fulfill({status:200,json:data,headers:{'Cache-Control':'no-store'}});
        }catch(e){await route.fulfill({status:e.code?.includes('NOT_FOUND')?404:e.code?.includes('CONFLICT')?409:500,json:{error:e.message,code:e.code}});}
      };queue=queue.then(job,job);await queue;
    });
    page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
    const shot=async name=>{await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});};
    const local=()=>page.evaluate(()=>{const id=location.pathname.split('/').at(-1),key=Object.keys(localStorage).find(k=>k.startsWith('tps:ctw-vocabulary-review:pending:')&&k.endsWith(':'+id));return key?JSON.parse(localStorage.getItem(key)):null;});
    const cards=()=>page.getByRole('tabpanel').getByRole('button');
    const waitPosition=async n=>page.waitForFunction(n=>{const id=location.pathname.split('/').at(-1),key=Object.keys(localStorage).find(k=>k.startsWith('tps:ctw-vocabulary-review:pending:')&&k.endsWith(':'+id));return key&&JSON.parse(localStorage.getItem(key)).position===n;},n);
    const synced=async()=>page.waitForFunction(()=>{const id=location.pathname.split('/').at(-1),key=Object.keys(localStorage).find(k=>k.startsWith('tps:ctw-vocabulary-review:pending:')&&k.endsWith(':'+id));return !key||JSON.parse(localStorage.getItem(key)).queue.length===0;});
    async function fill(correct=true){const state=await local(),card=state.round.cards[state.position-1],fields=page.getByRole('textbox',{name:'英文拼写',exact:true});
      await fields.first().waitFor();
      assert.equal(await fields.count(),card.spellingGroups.reduce((n,g)=>n+(g.requiredAll?g.shapes.length:1),0));
      let field=0;for(const group of card.spellingGroups){const values=group.requiredAll?group.accepted:[group.accepted.at(-1)];
        for(const value of values)await fields.nth(field++).fill(correct||group.id!=='base'?value:'x');}
    }
    async function start(index){await cards().nth(index).click();await page.getByRole('button',{name:'确认',exact:true}).click();await page.waitForURL('**/session/**');await page.getByRole('button',{name:'跳过复习',exact:true}).waitFor();return local();}
    await page.goto(origin+'/login');await page.locator('#account').fill(account.STUDENT_EMAIL);await page.locator('#password').fill(account.STUDENT_PASSWORD);
    await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/student/**',{timeout:60000});
    await page.goto(origin+ROOT);await cards().nth(20).waitFor();assert.equal(await cards().count(),21);assert.match(await cards().nth(20).innerText(),/32 个词条/);await shot('01-mixed-cards');
    await page.getByRole('tab',{name:'CEFR',exact:true}).click();await cards().nth(22).waitFor();await shot('02-cefr-cards');
    const baseline={mixed:counts[API+'/lists?edition=mixed'],cefr:counts[API+'/lists?edition=cefr']};
    for(let i=0;i<3;i++){await page.getByRole('tab',{name:'乱序版',exact:true}).click();await cards().nth(20).waitFor();await page.getByRole('tab',{name:'CEFR',exact:true}).click();await cards().nth(22).waitFor();}
    await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));});
    await page.waitForTimeout(350);
    assert.deepEqual({mixed:counts[API+'/lists?edition=mixed'],cefr:counts[API+'/lists?edition=cefr']},baseline);
    pass('Both TABs load once; repeated TAB/focus changes reuse StudentDataCache without flashing or requests');
    const listName=cards().nth(12);assert.match(await listName.innerText(),/3 个词条/);
    const state=await start(12),id=state.round.session.session_id;
    await page.getByText('1/3',{exact:true}).waitFor();await shot('03-study-progress');
    await page.getByRole('button',{name:'下一个',exact:true}).click();await page.getByText('2/3',{exact:true}).waitFor();
    await page.getByRole('button',{name:'下一个',exact:true}).click();await page.getByText('3/3',{exact:true}).waitFor();
    await page.getByRole('button',{name:'开始测试',exact:true}).click();await page.getByText('0/3',{exact:true}).waitFor();
    pass('Shared workspace displays independent centered study/test counters using the real 3-word List');
    const first=(await local()).round.cards[0];await fill();const clicked=Date.now();await page.getByRole('button',{name:'确定',exact:true}).click();
    assert.equal((await local()).position,1);await page.getByRole('button',{name:'即将进入下一题',exact:true}).waitFor();await waitPosition(2);
    assert.ok(Date.now()-clicked>=900);await synced();
    const persisted=await server.readCtwReview(client(db,'authenticated',U),U,id);assert.equal(persisted.session.answered,1);
    pass('Correct feedback uses the shared 1-second automatic advance; first answer is already persisted before round end');
    await fill(false);await page.getByRole('button',{name:'确定',exact:true}).click();await page.waitForTimeout(1200);assert.equal((await local()).position,2);
    await shot('04-wrong-feedback');await page.getByRole('button',{name:'下一个',exact:true}).click();await waitPosition(3);await synced();
    pass('Wrong feedback stays on the same word until the student clicks next');
    blocked=true;await fill();await page.getByRole('button',{name:'确定',exact:true}).click();
    await page.locator('[data-review-persistence="local"]').waitFor();
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,0);
    assert.equal(await page.getByRole('button',{name:'错词再练',exact:true}).isDisabled(),true);
    const pendingIds=(await local()).queue.map(c=>c.id);await shot('05-local-result-pending');
    await page.reload();await page.locator('[data-review-persistence="local"]').waitFor();assert.deepEqual((await local()).queue.map(c=>c.id),pendingIds);
    await page.getByText('同步暂未完成，记录已保留。',{exact:true}).waitFor({timeout:20000});await shot('06-retry-notice');assert.ok(failures>=4);
    blocked=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.locator('[data-review-persistence="saved"]').waitFor();
    assert.equal((await store.readVocabularyResult(client(db,'authenticated',U),U,id)).correct_count,2);
    assert.equal(await page.getByRole('region',{name:'错词详情'}).locator('article').count(),1);
    await page.getByText('你的拼写：x',{exact:true}).waitFor();assert.equal(await page.getByText(/学生拼写/).count(),0);
    assert.equal(await page.getByRole('region',{name:'错词详情'}).getByRole('heading',{name:first.expected.expression,exact:true}).count(),0);
    await shot('07-saved-wrong-only-result');pass('Offline queue survives refresh; bounded retries recover; unconfirmed result never claims saved; only wrong words shown');
    await page.getByRole('button',{name:'错词再练',exact:true}).click();await page.waitForURL(url=>url.pathname.includes('/session/')&&!url.pathname.endsWith(id));
    await page.getByText('1/1',{exact:true}).waitFor();assert.equal((await local()).round.cards.length,1);await shot('08-retry-study');
    await page.getByRole('button',{name:'开始测试',exact:true}).click();await fill();await page.getByRole('button',{name:'确定',exact:true}).click();await page.locator('[data-review-persistence="saved"]').waitFor();
    assert.equal(await page.getByRole('button',{name:'错词再练',exact:true}).count(),0);await shot('09-retry-perfect');
    assert.equal((await db.query('select count(*)::int n from student_ctw_vocabulary_attempts')).rows[0].n,2);
    assert.equal((await store.readVocabularyResult(client(db,'authenticated',U),U,id)).correct_count,2);
    pass('Wrong-only retry reuses study/test/auto-advance, creates its own result, preserves original and hides retry when perfect');
    await page.getByRole('link',{name:'返回填词题词表',exact:true}).click();await cards().nth(22).waitFor();
    assert.equal(counts[API+'/lists?edition=mixed'],baseline.mixed);
    assert.match(await cards().nth(12).innerText(),/进行中/);assert.doesNotMatch(await cards().nth(12).innerText(),/100%/);
    await shot('10-directory-relevant-refresh');pass('Returning refreshes only the affected edition; partial retry does not mark a whole List 100% complete');
    await page.getByRole('link',{name:'测试历史',exact:true}).click();await page.getByRole('heading',{name:'B1 · List 04',exact:true}).waitFor();
    await page.getByRole('heading',{name:'B1 · List 04 · 错词再练',exact:true}).waitFor();await shot('11-shared-history');
    await page.getByRole('link',{name:'查看结果',exact:true}).first().click();await page.locator('[data-review-persistence="saved"]').waitFor();assert.equal(await page.getByRole('textbox').count(),0);
    pass('Shared Wordbook history cards show correct range/date/status/progress/score and reopen read-only results');
    await page.goto(origin+ROOT+'?tab=cefr');await cards().nth(22).waitFor();const recovered=await start(12),recoveredId=recovered.round.session.session_id;await synced();
    await page.getByRole('link',{name:'暂停',exact:true}).click();await page.getByRole('link',{name:'恢复复习',exact:true}).waitFor();
    await page.evaluate(id=>{const key=Object.keys(localStorage).find(k=>k.startsWith('tps:ctw-vocabulary-review:pending:')&&k.endsWith(':'+id));localStorage.removeItem(key);},recoveredId);
    await page.getByRole('link',{name:'恢复复习',exact:true}).click();await page.getByRole('button',{name:'跳过复习',exact:true}).waitFor();
    assert.equal(counts[REVIEW+'/'+recoveredId+'?round=1'],1);
    await page.getByRole('button',{name:'跳过复习',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确定',exact:true}).click();
    for(let n=1;n<=3;n++){await fill();await page.getByRole('button',{name:'确定',exact:true}).click();if(n<3)await waitPosition(n+1);}
    await page.locator('[data-review-persistence="saved"]').waitFor();await page.getByRole('link',{name:'测试历史',exact:true}).click();
    await page.locator(`a[href="${ROOT}/results/${recoveredId}"]`).click();await page.locator('[data-review-persistence="saved"]').waitFor();await page.getByText('100%',{exact:true}).waitFor();
    assert.equal(counts[REVIEW+'/'+recoveredId+'?round=1'],2);await shot('17-server-recovery-final-result');
    pass('Server-only unfinished recovery caches an active round; final ACK invalidates that snapshot so result/history reopen the completed 100% result');
    await page.goto(origin+ROOT);await cards().nth(20).waitFor();const mixed=await start(0),mixedId=mixed.round.session.session_id;
    assert.equal(mixed.round.cards[0].expected.expression,'get');
    const forms=page.getByRole('region',{name:'不规则变化',exact:true});await forms.waitFor();
    assert.match(await forms.innerText(),/过去时\s+got/);assert.match(await forms.innerText(),/过去分词\s+got\s*\/\s*gotten/);
    await shot('18-get-study-forms');pass('get study shows got and got/gotten from the exact testing groups, without extra progress items');
    assert.ok(mixed.round.cards[0].spellingGroups.length>1);await page.getByRole('button',{name:'跳过复习',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确定',exact:true}).click();
    const fields=page.getByRole('textbox',{name:'英文拼写',exact:true});const card=mixed.round.cards[0];
    await fill();await page.getByRole('group',{name:'过去分词',exact:true}).getByRole('textbox').last().fill('x');
    const labelsBelow=await page.getByRole('group').evaluateAll(nodes=>nodes.every(node=>{const field=node.querySelector('input'),label=node.querySelector('p');return !field||!label||field.getBoundingClientRect().top<label.getBoundingClientRect().top;}));assert.ok(labelsBelow);
    await shot('12-irregular-inputs');await page.getByRole('button',{name:'确定',exact:true}).click();await page.waitForTimeout(1200);assert.equal((await local()).position,1);await synced();
    await page.getByRole('link',{name:'暂停',exact:true}).click();await page.getByRole('heading',{name:'乱序版 · List 01',exact:true}).waitFor();await shot('13-unfinished-history');
    await page.getByRole('link',{name:'恢复复习',exact:true}).first().click();await page.waitForURL('**/session/'+mixedId);await page.getByRole('button',{name:'下一个',exact:true}).waitFor();
    assert.equal((await local()).answers[card.itemId].assessments.base,true);assert.equal((await local()).answers[card.itemId].correct,false);
    assert.equal((await local()).answers[card.itemId].assessments.past,true);assert.equal((await local()).answers[card.itemId].assessments.past_participle,false);
    pass('Irregular fields grade together; labels remain below; a wrong form prevents auto-advance; history restores the feedback');
    await page.getByRole('button',{name:'下一个',exact:true}).click();await waitPosition(2);
    const current=(await local()).round.cards[1],field=page.getByRole('textbox',{name:'英文拼写',exact:true}).first();
    await page.setViewportSize({width:390,height:844});await field.fill(current.expected.expression);await field.focus();await shot('14-mobile-input');
    await field.evaluate(node=>{window.__ctwInput=node;});await page.setViewportSize({width:768,height:1024});
    assert.ok(await field.evaluate(node=>window.__ctwInput===node));await shot('15-ipad-input');
    await page.reload();await page.getByRole('textbox',{name:'英文拼写',exact:true}).first().waitFor();assert.equal(await page.getByRole('textbox',{name:'英文拼写',exact:true}).first().inputValue(),current.expected.expression.replace(/\s/g,''));
    pass('Mobile/iPad layouts retain the exact native input DOM across resize; unanswered draft survives refresh');
    await page.goto(origin+'/student/wordbook');await page.getByRole('heading',{name:'生词本',exact:true}).waitFor();await page.getByRole('link',{name:'开始复习',exact:true}).click();
    await page.getByRole('button',{name:'开始复习',exact:true}).waitFor();await shot('16-original-wordbook-setup');pass('Original Wordbook list and immersive setup still render with original controls');
    await page.setViewportSize({width:1440,height:1000});
    const reviewed=[];
    // Real UI for every one of the original 47 irregular entries, backed only
    // by the isolated DB. Seed a legacy wrong answer to open a one-word retry;
    // no localStorage injection and no production result creation.
    for(const original of source().rows.filter(row=>row.irregular_forms.length)){
      const entry=(await db.query('select * from ctw_vocabulary_entries where word=$1',[original.word])).rows[0],legacyId=randomUUID();
      const historical=await store.saveVocabularyAttempt(client(db,'service_role'),U,{attemptId:legacyId,mode:'base_form',source:{kind:'list',listNumber:entry.list_number},
        answers:[{entryId:entry.entry_id,spelling:'x',irregularSpellings:entry.irregular_forms.map(form=>({formType:form.form_type,spelling:form.answers[0]}))}]});
      await page.goto(origin+ROOT+'/results/'+legacyId);await page.getByRole('button',{name:'错词再练',exact:true}).click();await page.waitForURL('**/session/**');
      await page.getByRole('heading',{name:entry.word,exact:true}).waitFor();const round=(await local()).round,card=round.cards[0];
      assert.equal(round.cards.length,1);await page.getByText('1/1',{exact:true}).waitFor();
      const region=page.getByRole('region',{name:'不规则变化',exact:true}),expected=card.spellingGroups.slice(1);
      assert.equal(await region.count(),expected.length?1:0,entry.word);
      if(expected.length){const rows=region.locator('tbody tr');assert.equal(await rows.count(),expected.length);
        for(let i=0;i<expected.length;i++){assert.equal((await rows.nth(i).locator('th').innerText()).trim(),expected[i].label);
          assert.equal((await rows.nth(i).locator('td').innerText()).trim(),expected[i].accepted.join(' / '));}}
      if(['be','far','burn','learn','get','craftsperson','millennium','leaf'].includes(entry.word))await shot('forms-study-'+entry.word);
      await page.getByRole('button',{name:'开始测试',exact:true}).click();await fill();
      assert.equal(await region.count(),0);assert.equal(await page.getByRole('group').count(),card.spellingGroups.length);
      if(entry.word==='be'){
        assert.deepEqual(expected.map(group=>[group.label,group.accepted]),[['现在时',['am','is','are']],['过去时',['was','were']],['过去分词',['been']]]);
        const present=page.getByRole('group',{name:'现在时',exact:true}).getByRole('textbox');await present.nth(0).fill('is');await present.nth(1).fill('am');
        await page.setViewportSize({width:390,height:844});await shot('forms-test-be-mobile');
        const positions=await present.evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().top));assert.ok(Math.max(...positions)-Math.min(...positions)<2);
        await present.first().focus();await present.first().evaluate(node=>{window.__ctwInput=node;});await page.setViewportSize({width:768,height:1024});
        assert.ok(await present.first().evaluate(node=>window.__ctwInput===node));await shot('forms-test-be-ipad');
        await page.reload();await page.getByRole('group',{name:'现在时',exact:true}).waitFor();
        assert.deepEqual(await page.getByRole('group',{name:'现在时',exact:true}).getByRole('textbox').evaluateAll(nodes=>nodes.map(node=>node.value)),['is','am','are']);
      }
      if(entry.word==='far'){
        for(const label of ['比较级','最高级']){const group=expected.find(g=>g.label===label),fields=page.getByRole('group',{name:label,exact:true}).getByRole('textbox');
          await fields.nth(0).fill(group.accepted[1]);await fields.nth(1).fill(group.accepted[0]);}
        await page.setViewportSize({width:390,height:844});await shot('forms-test-far-mobile');
      }
      if(['burn','learn','get'].includes(entry.word)){await page.setViewportSize({width:390,height:844});await shot('forms-test-'+entry.word+'-mobile');}
      if(entry.word==='get'){
        const pp=page.getByRole('group',{name:'过去分词',exact:true}).getByRole('textbox');await pp.last().fill('');
        await page.getByRole('button',{name:'确定',exact:true}).click();await page.getByRole('button',{name:'下一个',exact:true}).waitFor();
        await page.waitForTimeout(1100);assert.equal((await local()).position,1);await page.getByRole('button',{name:'下一个',exact:true}).click();
        await page.locator('[data-review-persistence="saved"]').waitFor();const failedId=new URL(page.url()).pathname.split('/').at(-1);
        const failed=await store.readVocabularyResult(client(db,'authenticated',U),U,failedId);assert.equal(failed.correct_count,0);
        await page.getByText('正确拼写：got / gotten',{exact:true}).waitFor();await shot('forms-get-wrong-result');
        await page.getByRole('button',{name:'错词再练',exact:true}).click();await page.waitForURL(url=>url.pathname.includes('/session/')&&!url.pathname.endsWith(failedId));
        await page.getByRole('region',{name:'不规则变化',exact:true}).waitFor();await page.getByText('got / gotten',{exact:true}).waitFor();
        await page.getByRole('button',{name:'开始测试',exact:true}).click();await fill();
        pass('get requires got AND gotten; omitted variant fails, result shows the same answers and retry teaches/tests both');
      }
      const sessionId=new URL(page.url()).pathname.split('/').at(-1);await page.getByRole('button',{name:'确定',exact:true}).click();
      await page.locator('[data-review-persistence="saved"]').waitFor();await page.getByText('100%',{exact:true}).waitFor();
      const saved=await store.readVocabularyResult(client(db,'authenticated',U),U,sessionId);assert.equal(saved.correct_count,1,entry.word);
      for(const group of saved.answers[0].irregularResults)assert.deepEqual(group.acceptedAnswers,card.spellingGroups.find(g=>g.id===group.formType).accepted);
      assert.deepEqual(await store.readVocabularyResult(client(db,'authenticated',U),U,legacyId),historical);
      reviewed.push({word:entry.word,rows:expected.map(g=>({label:g.label,answers:g.accepted})),passed:true});
      await page.setViewportSize({width:1440,height:1000});
    }
    assert.equal(reviewed.length,47);assert.equal(reviewed.reduce((n,row)=>n+row.rows.length,0),87);
    pass('All original 47 entries: study rows equal required test slots and saved answers; leaf has no extra row; old grades unchanged');
    pass('be has three rows, same-length permutations pass; far requires both variants; get/burn/learn mobile rows retain all inputs and drafts');
    await db.exec(read('supabase/ctw_vocabulary_review_sync_verify.sql'));assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({verifiedAt:new Date().toISOString(),origin,database:'isolated PGlite, no production CTW writes',checks,reviewedIrregularEntries:reviewed,counts,simulatedSyncFailures:failures,pageErrors:errors},null,2));
  }catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
  finally{await browser.close();await db.close();}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
