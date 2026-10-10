const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {insertReviewSpelling,constrainReviewSpelling,spellingLetterCount}=require('../lib/lexical/wordbookReviewInput.ts');
const {recordReviewSyncFailure,visibleReviewSyncError,acknowledgeReview,readLocalReview,saveLocalReview}=require('../lib/lexical/wordbookReviewLocal.ts');
const shape='__________';
test('10 spelling blanks reject excess letters from typing, native input fallback and paste',()=>{
  assert.deepEqual(insertReviewSpelling(shape,'compromise',10,10,'xyz'),{value:'compromise',caret:10});
  assert.equal(insertReviewSpelling(shape,'',0,0,'compromises-extra').value,'compromise');
  assert.equal(constrainReviewSpelling(shape,'compromise','compromises').value,'compromise');
  assert.equal(constrainReviewSpelling(shape,'compromise','compXYZromise').value,'compromise');
});
test('selected replacement counts letters outside the selection and keeps the untouched suffix/caret',()=>{
  assert.deepEqual(insertReviewSpelling(shape,'compromise',2,5,'ABCDEF'),{value:'coABComise',caret:5});
  assert.deepEqual(constrainReviewSpelling(shape,'compromise','coABCDEFomise'),{value:'coABComise',caret:5});
  assert.equal(insertReviewSpelling(shape,'compromise',0,10,'abcdefghijklm').value,'abcdefghij');
  assert.equal(insertReviewSpelling(shape,'compromise',4,4,'z').value,'compromise');
});
test('backspace, deletion and re-insertion free capacity without rewriting punctuation or spelling',()=>{
  assert.equal(constrainReviewSpelling(shape,'compromise','compromis').value,'compromis');
  assert.equal(insertReviewSpelling(shape,'compromis',9,9,'EX').value,'compromisE');
  for(const expression of ['take care-of',"don't"]){
    const target=expression.replace(/[^\s]/g,'_');
    assert.equal(insertReviewSpelling(target,'',0,0,expression).value,expression);
  }
});
test('IME commit is constrained as an edit; non-ASCII composition output is not normalized or discarded',()=>{
  assert.deepEqual(constrainReviewSpelling(shape,'compromise','coABCDEFomise'),{value:'coABComise',caret:5});
  assert.equal(constrainReviewSpelling(shape,'','拼写').value,'拼写');
  assert.equal(insertReviewSpelling('___','',0,0,'ＡＢＣabcde').value,'ＡＢＣ');
  assert.ok(spellingLetterCount(insertReviewSpelling(shape,'',0,0,'a'.repeat(400)).value)<=10);
});
const pending=()=>({version:1,owner:'alice',round:{session:{session_id:'round',total:1},cards:[{itemId:'one'}]},phase:'test',position:1,
  answers:{},deadlines:{},queue:[{id:'answer-id',action:'answer',itemId:'one'}],confirmed:0,revision:1});
test('first failure + retries 1 and 2 are silent; failing retry 3 shows an actionable error without deleting the queue',()=>{
  let local=pending();for(let failure=1;failure<=4;failure++){
    local=recordReviewSyncFailure(local,'同步暂未完成，记录已保留。',true,'Load failed');
    assert.equal(local.syncFailure.count,failure);assert.equal(Boolean(visibleReviewSyncError(local)),failure>3);
    assert.equal(local.syncFailure.detail,'Load failed');assert.equal(local.queue.length,1);assert.equal(local.confirmed,0);
  }
});
test('failure threshold and unsaved queue survive refresh; successful ACK clears the warning and resets consecutive failures',()=>{
  let local=pending();for(let n=0;n<4;n++)local=recordReviewSyncFailure(local,'保存失败',true);
  const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};
  saveLocalReview(storage,local);local=readLocalReview(storage,'alice','round');assert.equal(local.syncFailure.count,4);assert.equal(visibleReviewSyncError(local),'保存失败');
  assert.equal(readLocalReview(storage,'bob','round'),null);
  local=acknowledgeReview(local,local.queue[0]);assert.equal(local.confirmed,1);assert.equal(visibleReviewSyncError(local),'');assert.equal(local.syncFailure,undefined);
  local.queue=[{id:'advance-id',action:'advance',itemId:'one'}];local=recordReviewSyncFailure(local,'保存失败',true);assert.equal(local.syncFailure.count,1);assert.equal(visibleReviewSyncError(local),'');
});
test('auth/conflict errors honor the same silent threshold and retain an accurate intervention message after bounded retries',()=>{
  let local=pending();for(let n=1;n<=4;n++){
    local=recordReviewSyncFailure(local,'请重新登录。',false);
    assert.equal(visibleReviewSyncError(local),n>3?'请重新登录。':'');assert.equal(local.syncFailure.requiresIntervention,true);assert.equal(local.queue.length,1);
  }
});
test('review UI contains no normal sync status, reserves stable error space, uses existing orange tokens and scoped theme navigation',()=>{
  const ui=fs.readFileSync('components/student/WordbookReviewWorkspace.tsx','utf8'),css=fs.readFileSync('components/student/WordbookReviewWorkspace.module.css','utf8');
  assert.doesNotMatch(ui,/正在同步|项待保存|尚有.*未同步|本轮结果含未同步/);assert.match(ui,/pending > 0 && syncError/);assert.match(css,/\.syncSlot[^}]*height: 64px/);
  assert.doesNotMatch(css,/--review-wrong|color-mix/);assert.match(css,/border-color: var\(--student-error-border\)/);assert.match(css,/background: var\(--student-error-soft\)/);assert.match(css,/color: var\(--student-error\)/);
  const setup=fs.readFileSync('components/student/WordbookReviewSetup.module.css','utf8');assert.match(setup,/\.navigation a[^}]*min-height: 44px[^}]*border: 1px solid var\(--student-primary-border\)/);assert.match(setup,/\.navigation a:active/);
});
