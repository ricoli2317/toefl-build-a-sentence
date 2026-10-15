// Explicitly authorized real acceptance. Five final attempts are expected.
// Normal localhost login + UI input, real Next handlers + production Supabase.
// No SQL writes, service key, response fixtures or localStorage modifications.
// Transport faults only: block a sync or discard a REAL successful ACK once.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.CTW_BROWSER_PLAYWRIGHT||'playwright');
const {loadVocabularySource}=require('../lib/ctw-vocabulary/import.ts');
const {applyVocabularySpellingReview}=require('../lib/ctw-vocabulary/spelling-review.ts');
const origin=process.env.CTW_BROWSER_ORIGIN,account=process.env.CTW_REAL_ACCOUNT_ACCEPTANCE;
if(!origin||new URL(origin).hostname!=='localhost'||account!=='jiangzhuocheng2')throw Error('Requires Ready localhost and explicit CTW_REAL_ACCOUNT_ACCEPTANCE=jiangzhuocheng2.');
const out=path.resolve(process.env.CTW_REAL_ACCEPTANCE_OUTPUT||'outputs/ctw-vocabulary-unification/real-account-acceptance');
const resume=process.env.CTW_REAL_ACCEPTANCE_RESUME==='1',exists=fs.existsSync(path.join(out,'acceptance.json'));
if(exists&&!resume)throw Error('Acceptance already started. Inspect/resume existing records; do not manufacture another five attempts.');
if(resume&&!exists)throw Error('No acceptance to resume.');
const ROOT='/student/ctw-vocabulary',API='/api/student/ctw-vocabulary',REVIEW=API+'/review';
const credentials=Object.fromEntries(fs.readFileSync('.codex/tps-test-accounts.local','utf8').split(/\r?\n/).filter(s=>s.includes('=')).map(s=>{const n=s.indexOf('=');return[s.slice(0,n),s.slice(n+1)];}));
assert.equal(credentials.STUDENT_EMAIL,account);
const report=resume?JSON.parse(fs.readFileSync(path.join(out,'acceptance.json'),'utf8')):{startedAt:new Date().toISOString(),origin,account,integration:'real localhost UI -> real Next handlers -> production Supabase',
  expectedNewAttempts:5,checks:[],sessions:[],baseline:{},snapshots:{},transportFaults:[],unexpectedHttpErrors:[],pageErrors:[]};
if(resume){assert.equal(report.account,account);assert.equal(report.origin,origin);assert.notEqual(report.passed,true);
  const archive=path.join(out,'interrupted-'+(report.resumes?.length??0)+'.json');if(fs.existsSync(archive))throw Error('Resume archive already exists.');
  fs.copyFileSync(path.join(out,'acceptance.json'),archive);
  if(fs.existsSync(path.join(out,'failure.png')))fs.copyFileSync(path.join(out,'failure.png'),archive.replace('.json','.png'));
  report.resumes=[...(report.resumes??[]),new Date().toISOString()];delete report.failure;}
const save=()=>fs.writeFileSync(path.join(out,'acceptance.json'),JSON.stringify(report,null,2));
function pass(name){if(!report.checks.some(c=>c.name===name))report.checks.push({name,passed:true});save();console.log('PASS',name);}
const safeError=error=>String(error?.message??error).split('Call log:')[0].replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]');
async function main(){
  fs.mkdirSync(out,{recursive:true});save();
  // Keep real pending operations across an interrupted acceptance. The browser
  // profile contains authentication and belongs OUTSIDE the checkout/artifacts.
  const profile=process.env.CTW_REAL_BROWSER_PROFILE||'/private/var/folders/w0/gqcjdk5947vb6k_rc2bvqjp40000gn/T/opencode/ctw-unified-real-account-profile';
  assert.ok(!path.resolve(profile).startsWith(process.cwd()+path.sep),'Browser profile must stay outside the repository.');
  let page,context,authorization,blockSync=false,dropAck=false,closing=false;
  const counts={};
  try{
    context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1440,height:1000}});
    await context.route(origin+API+'**',async route=>{
      try{
      const request=route.request(),url=new URL(request.url());counts[url.pathname+url.search]=(counts[url.pathname+url.search]||0)+1;
      authorization=request.headers().authorization||authorization;
      if(request.method()==='POST'&&url.pathname.startsWith(REVIEW+'/')){
        const command=request.postDataJSON().command;
        if(blockSync){report.transportFaults.push({kind:'blocked-before-server',commandId:command.id});await route.abort('internetdisconnected');return;}
        if(dropAck&&command.action==='answer'){
          dropAck=false;const real=await route.fetch({timeout:15000});assert.equal(real.status(),200);const ack=await real.json();assert.equal(ack.acknowledged,command.id);
          report.transportFaults.push({kind:'discarded-real-ack',commandId:command.id});await route.abort('failed');return;
        }
      }
      await route.continue();
      }catch(error){if(!closing){report.transportCallbackErrors=[...(report.transportCallbackErrors??[]),{name:error.name,message:safeError(error)}];save();}
        await route.abort('failed').catch(()=>{});}
    });
    page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(30000);
    page.on('pageerror',e=>report.pageErrors.push(e.message));
    page.on('response',response=>{const url=new URL(response.url());if(url.origin===origin&&url.pathname.startsWith(API)&&response.status()>=400)
      report.unexpectedHttpErrors.push({path:url.pathname+url.search,status:response.status()});});
    const shot=name=>page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
    const local=()=>page.evaluate(()=>{const id=location.pathname.split('/').at(-1),key=Object.keys(localStorage).find(k=>k.startsWith('tps:ctw-vocabulary-review:pending:')&&k.endsWith(':'+id));return key?JSON.parse(localStorage.getItem(key)):null;});
    const get=async url=>{assert.ok(authorization);const result=await page.evaluate(async({url,authorization})=>{const r=await fetch(url,{headers:{Authorization:authorization},cache:'no-store'});return{status:r.status,cache:r.headers.get('Cache-Control'),data:await r.json()};},{url,authorization});
      assert.equal(result.status,200,url);assert.equal(result.cache,'no-store');return result.data;};
    const cards=()=>page.getByRole('tabpanel').getByRole('button');
    const synced=()=>page.waitForFunction(()=>{const id=location.pathname.split('/').at(-1),key=Object.keys(localStorage).find(k=>k.startsWith('tps:ctw-vocabulary-review:pending:')&&k.endsWith(':'+id));return !key||JSON.parse(localStorage.getItem(key)).queue.length===0;});
    async function fill(card,{wrongGet=false,swapBe=false}={}){
      const fields=page.getByRole('textbox',{name:'英文拼写',exact:true});await fields.first().waitFor();
      assert.equal(await fields.count(),card.spellingGroups.reduce((n,g)=>n+(g.requiredAll?g.shapes.length:1),0));
      let index=0;for(const group of card.spellingGroups){const values=[...(group.requiredAll?group.accepted:[group.accepted.at(-1)])];
        if(swapBe&&group.label==='现在时')[values[0],values[1]]=[values[1],values[0]];
        if(wrongGet&&group.label==='过去分词')values[values.length-1]='';
        for(const value of values)await fields.nth(index++).fill(value);
      }
    }
    async function directory(edition){await page.goto(origin+ROOT+(edition==='cefr'?'?tab=cefr':''));await cards().nth(edition==='cefr'?22:20).waitFor();return get(API+'/lists?edition='+edition);}
    async function start(edition,group,list){const catalog=await directory(edition),index=catalog.lists.findIndex(c=>c.group===group&&c.listNumber===list);assert.ok(index>=0);
      const previous=report.sessions.find(s=>s.kind==='full-list'&&s.source.kind===(edition==='cefr'?'cefr_list':'list')&&s.source.listNumber===list&&(!group||s.source.group===group));
      if(previous){await page.goto(origin+ROOT+'/session/'+previous.id);
        await page.waitForFunction(id=>Object.keys(localStorage).some(k=>k.startsWith('tps:ctw-vocabulary-review:pending:')&&k.endsWith(':'+id)),previous.id);
        const state=await local();assert.ok(state);assert.equal(state.round.session.session_id,previous.id);return state.round;}
      await cards().nth(index).click();await page.getByRole('button',{name:'确认',exact:true}).click();await page.waitForURL('**/session/**');
      await page.getByRole('button',{name:'跳过复习',exact:true}).waitFor();const state=await local();assert.ok(state);
      report.owner=state.owner;report.sessions.push({id:state.round.session.session_id,source:state.round.metadata.source,total:state.round.session.total,kind:'full-list'});save();return state.round;}
    async function retry(parent){await page.getByRole('button',{name:'错词再练',exact:true}).click();await page.waitForURL(url=>url.pathname.includes('/session/')&&!url.pathname.endsWith(parent));
      await page.getByRole('button',{name:'开始测试',exact:true}).waitFor();const state=await local();assert.ok(state);
      report.sessions.push({id:state.round.session.session_id,source:state.round.metadata.source,total:state.round.session.total,parent,kind:'wrong-only'});save();return state.round;}
    async function testPhase(){const begin=page.getByRole('button',{name:'开始测试',exact:true});
      if(await begin.count())await begin.click();else{await page.getByRole('button',{name:'跳过复习',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确定',exact:true}).click();}
      await page.getByRole('textbox',{name:'英文拼写',exact:true}).first().waitFor();}
    async function nextPosition(position){await page.waitForFunction(position=>{const id=location.pathname.split('/').at(-1),key=Object.keys(localStorage).find(k=>k.startsWith('tps:ctw-vocabulary-review:pending:')&&k.endsWith(':'+id));
      if(!key)return true;const v=JSON.parse(localStorage.getItem(key));return v.position!==position||v.phase==='result';},position);}
    async function finish(round,{wrongGet=false,swapBe=false,offlineLast=false,wrongFirst=false,firstAnswerCheck=false}={}){
      const recovered=await local();
      for(let i=recovered.position-1;i<round.cards.length;i++){
        const state=await local();assert.equal(state.position,i+1);const card=state.round.cards[i],wrong=(wrongGet&&card.expected.expression==='get')||(wrongFirst&&i===0);
        if(state.answers[card.itemId]){assert.equal(state.answers[card.itemId].correct,!wrong);
          if(wrong){await page.getByRole('button',{name:'下一个',exact:true}).click();await nextPosition(i+1);}else await nextPosition(i+1);continue;}
        await fill(card,{wrongGet:wrongGet&&card.expected.expression==='get',swapBe:swapBe&&card.expected.expression==='be'});
        if(wrongFirst&&i===0)await page.getByRole('textbox',{name:'英文拼写',exact:true}).first().fill('x');
        if(offlineLast&&i===round.cards.length-1)blockSync=true;
        const at=Date.now();await page.getByRole('button',{name:'确定',exact:true}).click();
        if(wrong){await page.getByRole('button',{name:'下一个',exact:true}).waitFor();await page.waitForTimeout(1100);assert.equal((await local()).position,i+1);
          if(card.expected.expression==='get')await shot('get-incomplete-variant');
          await page.getByRole('button',{name:'下一个',exact:true}).click();
          await nextPosition(i+1);
        }else{await nextPosition(i+1);assert.ok(Date.now()-at>=900);}
        if(firstAnswerCheck&&i===0){await synced();const server=await get(REVIEW+'/'+round.session.session_id+'?round=1');assert.equal(server.session.answered,1);
          assert.equal(server.cards[0].answer.correct,!wrong);assert.equal(server.session.status,'active');pass('Real first answer is persisted and readable before the round ends; correct advances after one second');}
      }
      if(offlineLast){
        await page.locator('[data-review-persistence="local"]').waitFor();const before=await local(),pendingIds=before.queue.map(c=>c.id);
        assert.ok(pendingIds.length);assert.equal(await page.getByRole('button',{name:'错词再练',exact:true}).isDisabled(),true);
        const server=await get(REVIEW+'/'+round.session.session_id+'?round=1');assert.equal(server.session.status,'active');assert.equal(server.session.answered,round.cards.length-1);
        await shot('offline-local-result');await page.reload();await page.locator('[data-review-persistence="local"]').waitFor();assert.deepEqual((await local()).queue.map(c=>c.id),pendingIds);
        await page.getByText('同步暂未完成，记录已保留。',{exact:true}).waitFor({timeout:25000});await shot('offline-retry-notice');
        blockSync=false;await page.evaluate(()=>window.dispatchEvent(new Event('online')));
        pass('Real unsynced commands survive refresh; server stays active until retry ACK, and local result never claims saved');
      }
      const waitingAt=Date.now(),waiting=await local();
      await page.locator('[data-review-persistence="saved"]').waitFor({timeout:180000});
      report.syncWaits=[...(report.syncWaits??[]),{sessionId:round.session.session_id,pendingBeforeWait:waiting?.queue.length??0,milliseconds:Date.now()-waitingAt}];
      const result=await get(API+'/attempts/'+round.session.session_id),expectedWrong=(wrongGet?1:0)+(wrongFirst?1:0);
      assert.equal(result.answer_count,round.cards.length);assert.equal(result.correct_count,round.cards.length-expectedWrong);
      for(const answer of result.answers){const card=round.cards.find(c=>c.itemId===answer.entryId);
        for(const form of answer.irregularResults)assert.deepEqual(form.acceptedAnswers,card.spellingGroups.find(g=>g.id===form.formType).accepted);}
      const wrongRegion=page.getByRole('region',{name:'错词详情'});assert.equal(await wrongRegion.count(),expectedWrong?1:0);
      if(expectedWrong)assert.equal(await wrongRegion.locator('article').count(),expectedWrong);else assert.equal(await page.getByRole('button',{name:'错词再练',exact:true}).count(),0);
      report.sessions.find(s=>s.id===round.session.session_id).result=result;save();return result;
    }
    await page.goto(origin+'/login');await Promise.race([page.locator('#account').waitFor(),page.waitForURL('**/student/**')]);
    if(new URL(page.url()).pathname==='/login'){await page.locator('#account').fill(credentials.STUDENT_EMAIL);await page.locator('#password').fill(credentials.STUDENT_PASSWORD);
      await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/student/**',{timeout:60000});}
    await directory('mixed');if(!report.baseline.history){report.baseline.mixed=await get(API+'/lists?edition=mixed');report.baseline.cefr=await get(API+'/lists?edition=cefr');
      report.baseline.history=await get(REVIEW+'?page=1');report.baseline.results={};
      for(const item of report.baseline.history.items)report.baseline.results[item.session_id]=await get(API+'/attempts/'+item.session_id);save();}
    pass('Normal test-account login; real directory, new history RPC and historical result reads return 200');
    const original=loadVocabularySource(fs.readFileSync('data/ctw-vocabulary/ctw-vocabulary-cefr-reviewed.json'),'initial');
    const patch=JSON.parse(fs.readFileSync('data/ctw-vocabulary/irregular-spelling-adjustments.json','utf8')),expected=applyVocabularySpellingReview(original.rows,patch.changes),words=[];
    for(let pageNumber=1;;pageNumber++){const pageData=await get(API+'/words?page='+pageNumber+'&pageSize=50');words.push(...pageData.items);if(!pageData.hasMore)break;}
    assert.equal(words.length,1032);for(let i=0;i<words.length;i++){const a=words[i],e=expected[i];assert.deepEqual({word:a.word,list:'List '+String(a.list_number).padStart(2,'0'),cefr:a.cefr,senses:a.senses,forms:a.irregular_forms},
      {word:e.word,list:e.list_id,cefr:e.cefr,senses:e.senses,forms:e.irregular_forms});assert.equal(a.source_sha256,original.sha256);}
    pass('All 1032 production entries match reviewed content/order and final three-row data delta, including all irregular forms');
    // Exercise TAB/focus cache without programmatic reads in the measured window.
    const before={mixed:counts[API+'/lists?edition=mixed'],cefr:counts[API+'/lists?edition=cefr']};
    await page.getByRole('tab',{name:'CEFR',exact:true}).click();await cards().nth(22).waitFor();const cefrFirst=counts[API+'/lists?edition=cefr'];
    for(let n=0;n<3;n++){await page.getByRole('tab',{name:'乱序版',exact:true}).click();await cards().nth(20).waitFor();await page.getByRole('tab',{name:'CEFR',exact:true}).click();await cards().nth(22).waitFor();}
    await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));});await page.waitForTimeout(350);
    assert.equal(counts[API+'/lists?edition=mixed'],before.mixed);assert.equal(counts[API+'/lists?edition=cefr'],cefrFirst);await shot('real-cefr-directory');
    pass('Real TAB/focus switching reuses loaded directory data without repeated requests');
    if(!report.sessions.some(s=>s.kind==='wrong-only'&&s.source.kind==='cefr_list'&&s.result)){
    const cefr=await start('cefr','B1',4);assert.equal(cefr.cards.length,3);await shot('real-cefr-study');await testPhase();
    await finish(cefr,{wrongFirst:true,offlineLast:true,firstAnswerCheck:true});await shot('real-cefr-result');
    const cefrRetry=await retry(cefr.session.session_id);assert.equal(cefrRetry.cards.length,1);await testPhase();await finish(cefrRetry);await shot('real-cefr-retry-result');
    assert.deepEqual(await get(API+'/lists?edition=mixed'),report.baseline.mixed);report.snapshots.afterCefr=await get(API+'/lists?edition=cefr');
    pass('Real CEFR 3-word round saves 2/3, wrong-only retry saves 1/1 independently');
    }
    const mixed=await start('mixed','',1);assert.equal(mixed.cards.length,50);const getCard=mixed.cards.find(c=>c.expected.expression==='get');assert.ok(getCard);
    assert.deepEqual(getCard.spellingGroups.find(g=>g.id==='past_participle').accepted,['got','gotten']);
    if((await local()).phase==='study'){await page.getByText('got / gotten',{exact:true}).waitFor();await shot('real-get-study');
    await synced();await page.getByRole('link',{name:'暂停',exact:true}).click();await page.locator(`a[href="${ROOT}/session/${mixed.session.session_id}"]`).waitFor();await shot('real-unfinished-history');
    await page.locator(`a[href="${ROOT}/session/${mixed.session.session_id}"]`).click();await page.getByRole('button',{name:'跳过复习',exact:true}).waitFor();await page.reload();await page.getByText('got / gotten',{exact:true}).waitFor();
    pass('Real unfinished List is visible in history and restores exact study session through pause/resume/refresh');
    await testPhase();}
    dropAck=!report.transportFaults.some(f=>f.kind==='discarded-real-ack');await finish(mixed,{wrongGet:true});await shot('real-get-wrong-result');
    assert.equal(report.transportFaults.filter(f=>f.kind==='discarded-real-ack').length,1);
    const getRetry=await retry(mixed.session.session_id);assert.equal(getRetry.cards.length,1);assert.equal(getRetry.cards[0].expected.expression,'get');await page.getByText('got / gotten',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});await shot('real-get-retry-mobile-study');await testPhase();await fill(getRetry.cards[0]);await shot('real-get-retry-mobile-input');await finish(getRetry);await page.setViewportSize({width:1440,height:1000});
    pass('Real mixed List saves 49/50 when gotten is omitted; retry teaches/tests got AND gotten and saves 1/1; lost real ACK creates no duplicate attempt');
    const beRound=await start('mixed','',3),be=beRound.cards.find(c=>c.expected.expression==='be');assert.ok(be);assert.equal(beRound.cards.length,50);
    assert.deepEqual(be.spellingGroups.slice(1).map(g=>[g.label,g.accepted]),[['现在时',['am','is','are']],['过去时',['was','were']],['过去分词',['been']]]);
    // Study the real List normally through be, capturing the exact taught rows.
    while((await local()).round.cards[(await local()).position-1].expected.expression!=='be')await page.getByRole('button',{name:'下一个',exact:true}).click();
    await page.getByRole('heading',{name:'be',exact:true}).waitFor();const region=page.getByRole('region',{name:'不规则变化'});assert.equal(await region.locator('tbody tr').count(),3);await shot('real-be-study');
    await testPhase();await finish(beRound,{swapBe:true});await shot('real-be-perfect-result');
    pass('Real be List saves 50/50; three tense rows and swapped same-length am/is are correctly graded server-side');
    const history=await get(REVIEW+'?page=1');assert.equal(history.total,report.baseline.history.total+5);assert.equal(report.sessions.length,5);
    for(const [id,result]of Object.entries(report.baseline.results))assert.deepEqual(await get(API+'/attempts/'+id),result);
    for(const session of report.sessions){const round=await get(REVIEW+'/'+session.id+'?round=1');assert.equal(round.session.status,'completed');assert.equal(round.summary.correct,session.result.correct_count);}
    report.snapshots.finalMixed=await get(API+'/lists?edition=mixed');report.snapshots.finalCefr=await get(API+'/lists?edition=cefr');report.snapshots.finalHistory=history;
    assert.deepEqual(report.snapshots.finalCefr,report.snapshots.afterCefr);
    assert.deepEqual(report.snapshots.finalMixed.lists.filter(list=>![1,3].includes(list.listNumber)),report.baseline.mixed.lists.filter(list=>![1,3].includes(list.listNumber)));
    const beList=report.snapshots.finalMixed.lists.find(list=>list.listNumber===3);assert.equal(beList.status,'completed');assert.equal(beList.bestAccuracy,100);
    const getList=report.snapshots.finalMixed.lists.find(list=>list.listNumber===1),oldGet=report.baseline.mixed.lists.find(list=>list.listNumber===1);
    assert.equal(getList.bestAccuracy,Math.max(oldGet.bestAccuracy??0,98));assert.equal(getList.status,oldGet.status==='completed'?'completed':'in_progress');
    const cefrList=report.snapshots.finalCefr.lists.find(list=>list.group==='B1'&&list.listNumber===4),oldCefr=report.baseline.cefr.lists.find(list=>list.group==='B1'&&list.listNumber===4);
    assert.equal(cefrList.bestAccuracy,oldCefr.bestAccuracy);assert.equal(cefrList.status,oldCefr.status);
    pass('Mixed/CEFR progress stays independent, unrelated Lists are unchanged, old best 100% is retained and be List completes at 100%');
    await page.goto(origin+ROOT+'/history');await page.locator(`a[href="${ROOT}/results/${beRound.session.session_id}"]`).waitFor();await shot('real-final-history');
    await page.locator(`a[href="${ROOT}/results/${mixed.session.session_id}"]`).click();await page.getByText('你的拼写：got /',{exact:true}).waitFor();await shot('real-refreshed-get-result');
    await page.reload();await page.getByText('正确拼写：got / gotten',{exact:true}).waitFor();
    pass('Five new immutable attempts reopen consistently; baseline historical attempts remain byte-for-byte unchanged');
    assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.unexpectedHttpErrors,[]);report.counts=counts;report.finishedAt=new Date().toISOString();report.passed=true;save();
  }catch(error){report.passed=false;report.failure=safeError(error);save();if(page&&!new URL(page.url()).pathname.includes('login'))await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});throw Error(safeError(error));}
  finally{closing=true;if(context){await context.unrouteAll({behavior:'wait'}).catch(()=>{});await context.close();}}
}
main().catch(error=>{console.error(safeError(error));process.exitCode=1;});
