const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{spawnSync}=require('node:child_process');
const {coordinate,withMaintenanceLock,STAGES}=require('../lib/vocabulary-maintenance/coordinator.ts');
const f=require('./helpers/ctwIncrementalFixture.cjs');
const ROOT=path.resolve(__dirname,'..'),BASE=path.join(ROOT,'tmp/vocabulary-maintenance');
async function workspace(){await fs.mkdir(BASE,{recursive:true});return fs.mkdtemp(path.join(BASE,'synthetic-test-'));}
function adapter(){
  const calls=[],checkpoints=[],failures=new Set(),badProof=new Set();
  return {calls,checkpoints,failures,badProof,run:async(b,s)=>{
    calls.push(`${b}:${s}`);if(failures.has(`${b}:${s}`))throw Error('synthetic branch failure');
    return {verified:!badProof.has(b),binding:`${b}-${s}`};
  },validate:async(b,s,r)=>{assert.equal(r.binding,`${b}-${s}`);},checkpoint:async(b,r)=>{assert.equal(r.verified,true);checkpoints.push(b);}};
}
async function run(root,a,stage,branches=['ctw','lexical']){return coordinate({root,run:'synthetic',config:{synthetic:true},stage,branches,adapter:a});}

test('both branches: staged prerequisites, no early checkpoint, success, independent report and zero duplicate imports',async()=>{
  const dir=await workspace(),a=adapter();try{
    const premature=await run(dir,a,'import');assert.equal(premature.branches.ctw.stages.import.status,'failed');assert.equal(a.calls.length,0);
    for(const s of STAGES){await run(dir,a,s);if(s!=='post-verify')assert.deepEqual(a.checkpoints,[]);}
    const before=[...a.calls],again=await run(dir,a,'import');assert.deepEqual(a.calls,before);
    await run(dir,a,'post-verify');assert.deepEqual(a.checkpoints,['ctw','lexical']);
    assert.ok(again.branches.ctw.completed&&again.branches.lexical.completed);
    assert.equal(again.branches.ctw.stages.import.result.binding,'ctw-import');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
for(const failed of ['ctw','lexical'])test(`${failed} failure: successful branch retained, failed-only retry, commit/ACK-loss resume`,async()=>{
  const dir=await workspace(),a=adapter(),other=failed==='ctw'?'lexical':'ctw';try{
    for(const s of ['plan','prepare','verify'])await run(dir,a,s);
    a.failures.add(`${failed}:import`);let state=await run(dir,a,'import');
    assert.equal(state.branches[failed].stages.import.status,'failed');assert.equal(state.branches[other].stages.import.status,'succeeded');
    await run(dir,a,'post-verify');assert.deepEqual(a.checkpoints,[other]);
    a.failures.clear();await run(dir,a,'import',[failed]);await run(dir,a,'post-verify',[failed]);
    assert.equal(a.calls.filter(c=>c===`${other}:import`).length,1);assert.deepEqual(a.checkpoints,[other,failed]);
    state=await run(dir,a,'import');assert.ok(state.branches.ctw.completed&&state.branches.lexical.completed);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('unverified post-state never advances checkpoint; independent baselines/config cannot be silently replaced',async()=>{
  const dir=await workspace(),a=adapter();try{
    for(const s of STAGES.slice(0,-1))await run(dir,a,s);
    a.badProof.add('ctw');const state=await run(dir,a,'post-verify');assert.equal(state.branches.ctw.completed,false);assert.deepEqual(a.checkpoints,['lexical']);
    await assert.rejects(coordinate({root:dir,run:'synthetic',config:{different:true},stage:'plan',branches:['ctw'],adapter:a}),/config mismatch/);
    a.badProof.clear();await run(dir,a,'post-verify',['ctw']);assert.deepEqual(a.checkpoints,['lexical','ctw']);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('checkpoint-write failure retries post-verify, never import; run lock excludes concurrent writers',async()=>{
  const dir=await workspace(),a=adapter();try{
    for(const s of STAGES.slice(0,-1))await run(dir,a,s);
    const original=a.checkpoint;let fail=true;
    a.checkpoint=async(b,r)=>{if(b==='ctw'&&fail){fail=false;throw Error('synthetic filesystem failure');}await original(b,r);};
    await run(dir,a,'post-verify');await run(dir,a,'post-verify');assert.equal(a.calls.filter(c=>c==='ctw:import').length,1);
    await withMaintenanceLock(dir,async()=>assert.rejects(withMaintenanceLock(dir,async()=>{}),/locked/));
    await withMaintenanceLock(dir,async()=>{});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('immutable binding failures invalidate stage and block import rather than trusting cached success',async()=>{
  const dir=await workspace(),a=adapter();try{
    await run(dir,a,'plan');const original=a.validate;a.validate=async(b,s,r)=>{if(b==='ctw')throw Error('synthetic artifact tamper');await original(b,s,r);};
    const state=await run(dir,a,'prepare');assert.equal(state.branches.ctw.stages.prepare.status,'failed');assert.equal(state.branches.lexical.stages.prepare.status,'succeeded');
    const imported=await run(dir,a,'import');assert.equal(imported.branches.ctw.stages.import.status,'failed');assert.ok(!a.calls.includes('ctw:import'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

const nodeArgs=['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','--experimental-strip-types'];
function cli(script,args){const env={...process.env};delete env.SUPABASE_DB_URL;delete env.SUPABASE_SERVICE_ROLE_KEY;
  return spawnSync(process.execPath,[...nodeArgs,path.join(ROOT,'scripts',script),...args],{cwd:ROOT,env,encoding:'utf8'});}
test('real offline CTW and unified CLIs: synthetic plan/review/prepare/verify/SQL handoff, immutable retry, live/write fail-closed',async()=>{
  const dir=await workspace(),id=`synthetic-${randomUUID()}`,unifiedRun=path.join(BASE,'runs',id);try{
    const snapshot=f.snapshot(),snapshotFile=path.join(dir,'snapshot.json'),cp=path.join(dir,'checkpoint.json'),out=path.join(dir,'ctw'),review=path.join(dir,'review.json');
    const save=(name,x)=>fs.writeFile(name,JSON.stringify(x));await save(snapshotFile,snapshot);await save(cp,f.checkpoint(snapshot));
    const invoke=(...args)=>cli('ctw-vocabulary-incremental.ts',args);
    assert.equal(invoke('plan','--snapshot',snapshotFile,'--checkpoint',cp,'--out',out).status,0);
    const p=JSON.parse(await fs.readFile(path.join(out,'plan.json'),'utf8'));await save(review,f.review(p));
    for(let i=0;i<2;i++)assert.equal(invoke('prepare','--out',out,'--review',review).status,0);
    assert.equal(invoke('verify','--out',out,'--snapshot',snapshotFile).status,0);
    assert.equal(invoke('import','--out',out).status,0); // SQL generation only, no DB access
    assert.notEqual(invoke('capture','--output',path.join(dir,'never.json')).status,0);
    assert.notEqual(invoke('post-verify','--out',out).status,0);
    assert.notEqual(invoke('import','--out',out,'--write').status,0); // no connection URL
    assert.notEqual(invoke('plan','--snapshot',snapshotFile,'--checkpoint',cp,'--out',out,'--typo').status,0);
    const configFile=path.join(dir,'config.json');await save(configFile,{version:'vocabulary-maintenance-config-v1',run:id,
      ctw:{snapshot:snapshotFile,checkpoint:cp,review},lexical:{run:id}});
    const unified=(stage,...args)=>cli('vocabulary-incremental.ts',[stage,'--config',configFile,...args]);
    assert.notEqual(unified('plan').status,0); // both branches require live authorization
    assert.equal(unified('plan','--branch','ctw').status,0);
    // New run snapshot/plan is identical, so reviewed plan digest is reusable here.
    assert.equal(unified('prepare','--branch','ctw').status,0);
    assert.equal(unified('prepare','--branch','ctw').status,0);
    assert.notEqual(unified('import','--branch','ctw').status,0);
    assert.notEqual(unified('post-verify','--branch','ctw').status,0);
    const authorized=unified('import','--write'); // valid command; prerequisites stop it before any child DB operation
    assert.notEqual(authorized.status,0);assert.doesNotMatch(authorized.stderr,/read-only checks/);
    assert.equal(JSON.parse(authorized.stdout).branches.lexical.stages.import.status,'failed');
    const report=unified('report');assert.equal(report.status,0);const r=JSON.parse(report.stdout);
    assert.equal(r.branches.ctw.stages.prepare.attempts,1);assert.equal(r.branches.lexical.completed,false);
    assert.deepEqual(JSON.parse(await fs.readFile(cp,'utf8')),f.checkpoint(snapshot));
  }finally{await fs.rm(dir,{recursive:true,force:true});await fs.rm(unifiedRun,{recursive:true,force:true});}
});
