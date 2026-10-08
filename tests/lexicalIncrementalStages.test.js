const assert=require('node:assert/strict');
const test=require('node:test');
const path=require('node:path');
const { mkdir,mkdtemp,rm,writeFile,readFile }=require('node:fs/promises');
const { initStage,nextStageBatch,acceptStageBatch,loadStage,assertStageComplete,verifyStageCheckpoints }=require('../lib/lexical/incremental/stageRunner.ts');
const { applyIncrementalMweQaDecision,mweQaExpressionIdentity }=require('../lib/lexical/incremental/mweQaStage.ts');
const { baselineRowsSha256,normalizeBaselineRow }=require('../lib/lexical/incremental/baselineHash.ts');
const { sha256 }=require('../lib/lexical/incremental/artifacts.ts');
const { buildAnnotationStage,validateAnnotationStageOutput }=require('../lib/lexical/incremental/annotationStage.ts');
const { buildMweStage,validateMweStageOutput }=require('../lib/lexical/incremental/mweStage.ts');
const { buildMweQaStage,validateMweQaStageOutput }=require('../lib/lexical/incremental/mweQaStage.ts');
const { tokenizeCanonicalBlocks }=require('../lib/lexical/tokenize.ts');
const { applyReviewedEntryIdentities }=require('../lib/lexical/incremental/identityReview.ts');
const { incrementalAgentProvenance }=require('../lib/lexical/incremental/envelope.ts');
const { validateAnnotationBatch }=require('../lib/lexical/annotation.ts');
const { consolidateIncrementalDelta }=require('../lib/lexical/incremental/consolidation.ts');

async function workspace(fn,count=2) {
 const parent=path.join(__dirname,'..','tmp','lexical-incremental','fixtures');
 await mkdir(parent,{recursive:true});
 const root=await mkdtemp(path.join(parent,'stages-'));
 try {
  await initStage(root,'annotation',{sourcePlanSha256:null,batches:Array.from({length:count},(_,i)=>({sourceType:'ctw',inputSignature:`signature-${i}`,blockKeys:[`block-${i}`],input:{id:i},work:{id:i}}))});
  await fn(root);
 } finally { await rm(root,{recursive:true,force:true}); }
}
const validate=async(output,batch)=>({batch_id:batch.batch_id,value:output.value});

test('exclusive batch claims and resume preserve the exact in-progress batch',async()=>workspace(async root=>{
 const claims=await Promise.all(['worker-one','worker-two'].map(owner=>nextStageBatch(root,'annotation',owner)));
 assert.notEqual(claims[0].batch_id,claims[1].batch_id);
 const resumed=await nextStageBatch(root,'annotation','worker-one');
 assert.equal(resumed.batch_id,claims[0].batch_id);
 for(let i=0;i<claims.length;i++) {
  const claim=claims[i];await writeFile(claim.output_path,JSON.stringify({value:i}));
  await acceptStageBatch(root,'annotation',claim.batch_id,['worker-one','worker-two'][i],validate);
 }
 assert.equal((await assertStageComplete(root,'annotation')).accepted,2);
 assert.equal((await nextStageBatch(root,'annotation','worker-one')).done,true);
}));

test('receipts detect accepted output and checkpoint tampering',async()=>workspace(async root=>{
 const claim=await nextStageBatch(root,'annotation','worker-one');
 await writeFile(claim.output_path,JSON.stringify({value:1}));
 await acceptStageBatch(root,'annotation',claim.batch_id,'worker-one',validate);
 const { paths }=await loadStage(root,'annotation');
 await writeFile(paths.checkpointPath(claim.batch_id),JSON.stringify({batch_id:claim.batch_id,value:999}));
 await assert.rejects(loadStage(root,'annotation'),/output\/checkpoint changed/);
},1));

test('legacy partial checkpoint is not accepted and mismatched output cannot get a receipt',async()=>workspace(async root=>{
 const claim=await nextStageBatch(root,'annotation','worker-one');
 const { paths }=await loadStage(root,'annotation');
 await mkdir(path.dirname(paths.checkpointPath(claim.batch_id)),{recursive:true});
 await writeFile(paths.checkpointPath(claim.batch_id),JSON.stringify({batch_id:claim.batch_id,value:1}));
 assert.equal((await loadStage(root,'annotation')).accepted.size,0);
 await mkdir(path.dirname(paths.outputPath(claim.batch_id)),{recursive:true});
 await writeFile(paths.outputPath(claim.batch_id),JSON.stringify({value:2}));
 await assert.rejects(assertStageComplete(root,'annotation'),/requires revalidation/);
 await assert.rejects(verifyStageCheckpoints(root,'annotation',validate),/Revalidation changed/);
},1));

test('durable accepted pair is recovered by validator replay without rewriting checkpoint bytes',async()=>workspace(async root=>{
 const claim=await nextStageBatch(root,'annotation','worker-one');
 const { paths }=await loadStage(root,'annotation');
 await mkdir(path.dirname(paths.outputPath(claim.batch_id)),{recursive:true});
 await mkdir(path.dirname(paths.checkpointPath(claim.batch_id)),{recursive:true});
 const bytes=JSON.stringify({batch_id:claim.batch_id,value:1});
 await writeFile(paths.outputPath(claim.batch_id),JSON.stringify({value:1}));
 await writeFile(paths.checkpointPath(claim.batch_id),bytes);
 await verifyStageCheckpoints(root,'annotation',validate);
 assert.equal(await readFile(paths.checkpointPath(claim.batch_id),'utf8'),bytes);
 assert.equal((await assertStageComplete(root,'annotation')).complete,true);
},1));

test('MWE QA correction rederives keys and preserves exact identity independent of JSON key order',()=>{
 const original={source_type:'ctw',source_item_id:'item',content_block_id:'paragraph:p',start_offset:0,end_offset:13,
  surface_text:'take off from',canonical_expression:'take off from',normalized_expression:'take off from',entry_key:'take off from\u0000phrase',
  expression_type:'phrase',lemma:'take off from',normalized_surface:'take off from',layer:2};
 const identity=mweQaExpressionIdentity(original);
 const record={expression_identity:Object.fromEntries(Object.entries(identity).reverse()),verdict:'ISSUE',recommended_action:'correct',
  issue_types:['wrong_expression_type'],corrections:{expression_type:'phrasal_verb'}};
 const corrected=applyIncrementalMweQaDecision(original,record);
 assert.equal(corrected.entry_key,'take off from\u0000phrasal_verb');
 assert.equal(corrected.surface_text,original.surface_text);
 assert.equal(corrected.start_offset,original.start_offset);
});

test('baseline protects null vs empty, nested JSON semantics, UTF-8 and microsecond timestamps',()=>{
 assert.notEqual(baselineRowsSha256([{lemma:null}]),baselineRowsSha256([{lemma:''}]));
 assert.notEqual(baselineRowsSha256([{common_senses:[]}]),baselineRowsSha256([{common_senses:[{meaning:'中文😀'}]}]));
 assert.deepEqual(normalizeBaselineRow({created_at:'2026-10-07T21:00:00.123456+08:00'}),{created_at:'2026-10-07T13:00:00.123456+00:00'});
 assert.equal(baselineRowsSha256([{updated_at:'2026-10-07T21:00:00.100000+08:00'}]),baselineRowsSha256([{updated_at:'2026-10-07T13:00:00.1+00:00'}]));
});

test('explicit identity review replays full validators, preserves original and rejects stale or semantic-changing resolutions',()=>{
 const works=tokenizeCanonicalBlocks([{sourceType:'bas',sourceItemId:'item',contentBlockId:'question:q01:prompt',blockKind:'bas_prompt',text:'Q'}]);
 const token=works[0].tokens.find(value=>!value.excluded);
 const blocks=[{block_key:'bas:item:question:q01:prompt',tokens:[{candidate_id:token.candidateId,context_pos:'noun',context_meaning_zh:'提问',context_definition_en:'An abbreviation for questions',canonical_expression:'q',lemma:'q',expression_type:'word',needs_review:false,review_notes:null}],expressions:[]}];
 const occurrences=validateAnnotationBatch(works,{blocks});
 const original=JSON.stringify(occurrences);
 const entry={entry_id:'existing-Q',canonical_expression:'Q',normalized_expression:'q',expression_type:'word',lemma:'Q',identity_variant:''};
 const provenance=incrementalAgentProvenance({});
 const resolution={source_occurrence_id:'bas:item:question:q01:prompt:0:1',source_occurrence_sha256:baselineRowsSha256([occurrences[0]]),entry_id:entry.entry_id,identity_variant:'',concise_reason:'Reviewed question abbreviation; preserve uppercase production convention.',provenance};
 const args={works,occurrences,productionEntries:[entry],resolutions:[resolution],provenance};
 const applied=applyReviewedEntryIdentities(args);
 assert.equal(applied.occurrences[0].canonical_expression,'Q');
 assert.equal(applied.occurrences[0].context_meaning_zh,occurrences[0].context_meaning_zh);
 assert.equal(JSON.stringify(occurrences),original);
 assert.throws(()=>applyReviewedEntryIdentities({...args,resolutions:[{...resolution,source_occurrence_sha256:'0'.repeat(64)}]}),/stale/);
 assert.throws(()=>applyReviewedEntryIdentities({...args,productionEntries:[{...entry,lemma:'question'}]}),/semantic identity/);
 assert.throws(()=>applyReviewedEntryIdentities({...args,resolutions:[resolution,resolution]}),/duplicate/);
});

test('deterministic full annotation → MWE → corrected QA flow keeps frozen Layer-1 byte-identical',async()=>{
 const parent=path.join(__dirname,'..','tmp','lexical-incremental','fixtures');
 await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'flow-'));
 try {
  const deltaPath=path.join(root,'tmp','lexical-incremental','delta-plan.json');
  await mkdir(path.dirname(deltaPath),{recursive:true});await writeFile(deltaPath,'{}');
  const signature=sha256('{}');
  const works=tokenizeCanonicalBlocks([{sourceType:'ctw',sourceItemId:'item',contentBlockId:'paragraph:p',blockKind:'ctw_paragraph',text:'They make progress.'}]);
  await buildAnnotationStage(root,works,signature);
  const claim=await nextStageBatch(root,'annotation','fixture-worker');
  const input=JSON.parse(await readFile(claim.input_path,'utf8'));
  const semantics={they:['pronoun','他们','The people already mentioned'],make:['verb','取得','Bring about a particular result'],progress:['noun','进展','Improvement toward a goal']};
  const envelope=stageInput=>Object.fromEntries(['protocol_version','batch_id','stage','provenance','generation_version','schema_version','input_signature'].map(key=>[key,stageInput[key]]));
  const block_key='ctw:item:paragraph:p';
  const tokens=input.blocks[0].eligible_tokens.map(token=>{
   const word=token.surface_text.toLowerCase(); const [pos,zh,en]=semantics[word];
   return {candidate_id:token.candidate_id,context_pos:pos,context_meaning_zh:zh,context_definition_en:en,canonical_expression:word,lemma:word,expression_type:'word',needs_review:false,review_notes:null};
  });
  await writeFile(claim.output_path,JSON.stringify({...envelope(input),blocks:[{block_key,tokens}]}));
  await acceptStageBatch(root,'annotation',claim.batch_id,'fixture-worker',(output,batch)=>validateAnnotationStageOutput(root,batch.batch_id,batch,output));
  const annotationPaths=(await loadStage(root,'annotation')).paths;
  const originalAnnotation=await readFile(annotationPaths.checkpointPath(claim.batch_id),'utf8');
  await buildMweStage(root,signature);
  const mweClaim=await nextStageBatch(root,'mwe','fixture-worker');const mweInput=JSON.parse(await readFile(mweClaim.input_path,'utf8'));
  const expression={start_offset:5,end_offset:18,surface_text:'make progress',context_pos:'verb',context_meaning_zh:'取得进展',context_definition_en:'Advance toward a goal',
   canonical_expression:'make progress',lemma:'make progress',expression_type:'phrase',learning_value:'common_collocation',needs_review:false,review_notes:null};
  await writeFile(mweClaim.output_path,JSON.stringify({...envelope(mweInput),blocks:[{block_key,expressions:[expression]}]}));
  await acceptStageBatch(root,'mwe',mweClaim.batch_id,'fixture-worker',(output,batch)=>validateMweStageOutput(root,batch.batch_id,batch,output));
  await buildMweQaStage(root,signature);
  const qaClaim=await nextStageBatch(root,'mwe-qa','fixture-worker');const qaInput=JSON.parse(await readFile(qaClaim.input_path,'utf8'));
  const decision={expression_identity:qaInput.expressions[0].expression_identity,verdict:'ISSUE',issue_types:['wrong_definition_en'],concise_reason:'Make the contextual action definition more precise.',recommended_action:'correct',corrections:{context_definition_en:'Advance toward an intended outcome'}};
  await writeFile(qaClaim.output_path,JSON.stringify({...envelope(qaInput),records:[decision]}));
  await acceptStageBatch(root,'mwe-qa',qaClaim.batch_id,'fixture-worker',(output,batch)=>validateMweQaStageOutput(root,batch.batch_id,batch,output));
  assert.equal((await assertStageComplete(root,'mwe-qa')).complete,true);
  assert.equal(await readFile(annotationPaths.checkpointPath(claim.batch_id),'utf8'),originalAnnotation);
  const invalid={...decision,corrections:{context_definition_en:'取得进展'}};
  await assert.rejects(validateMweQaStageOutput(root,qaClaim.batch_id,{input_signature:qaInput.input_signature},{...envelope(qaInput),records:[invalid]}),/definition|Chinese|semantic/i);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('identity replay is independent of finalized lexical offset ordering and requires canonical work',()=>{
 const works=tokenizeCanonicalBlocks([{sourceType:'bas',sourceItemId:'item',contentBlockId:'question:q01:prompt',blockKind:'bas_prompt',text:'Q Q Q Q Q Q'}]);
 const tokens=works[0].tokens.filter(value=>!value.excluded).map(token=>({candidate_id:token.candidateId,context_pos:'noun',context_meaning_zh:'提问',context_definition_en:'An abbreviation for questions',canonical_expression:'q',lemma:'q',expression_type:'word',needs_review:false,review_notes:null}));
 const occurrences=validateAnnotationBatch(works,{blocks:[{block_key:'bas:item:question:q01:prompt',tokens,expressions:[]}]}).sort((left,right)=>String(left.start_offset).localeCompare(String(right.start_offset)));
 assert.deepEqual(occurrences.map(row=>row.start_offset),[0,10,2,4,6,8]);
 const entry={entry_id:'existing-Q',canonical_expression:'Q',normalized_expression:'q',expression_type:'word',lemma:'Q',identity_variant:''};
 const provenance=incrementalAgentProvenance({});
 const resolutions=occurrences.map(row=>({source_occurrence_id:`bas:item:question:q01:prompt:${row.start_offset}:${row.end_offset}`,source_occurrence_sha256:baselineRowsSha256([row]),entry_id:entry.entry_id,identity_variant:'',concise_reason:'Reviewed uppercase abbreviation convention.',provenance}));
 const args={works,occurrences,productionEntries:[entry],resolutions,provenance};
 const result=applyReviewedEntryIdentities(args);
 assert.equal(result.reviewed,6);
 assert.deepEqual(result.occurrences.map(row=>row.start_offset),[0,10,2,4,6,8]);
 assert.ok(result.occurrences.every(row=>row.canonical_expression==='Q'));
 assert.throws(()=>applyReviewedEntryIdentities({...args,works:[]}),/no canonical work/);
});

test('hash-bound homograph review chooses the exact existing variant without overwriting entry semantics',()=>{
 const works=tokenizeCanonicalBlocks([{sourceType:'bas',sourceItemId:'item',contentBlockId:'question:q01:prompt',blockKind:'bas_prompt',text:'A'}]);
 const token=works[0].tokens.find(value=>!value.excluded);
 const occurrences=validateAnnotationBatch(works,{blocks:[{block_key:'bas:item:question:q01:prompt',tokens:[{candidate_id:token.candidateId,context_pos:'noun',context_meaning_zh:'答案',context_definition_en:'An abbreviation for answers',canonical_expression:'a',lemma:'a',expression_type:'word',needs_review:false,review_notes:null}],expressions:[]}]});
 const base={entry_id:'base-a',canonical_expression:'a',normalized_expression:'a',expression_type:'word',lemma:'a',identity_variant:'',common_senses:[{meaning:'一个'}]};
 const variant={...base,entry_id:'answer-A',canonical_expression:'A',lemma:'A',identity_variant:'answer-in-qa',common_senses:[{meaning:'答案'}]};
 const productionEntries=[base,variant];const before=JSON.stringify(productionEntries);
 const provenance=incrementalAgentProvenance({});
 const resolution={source_occurrence_id:'bas:item:question:q01:prompt:0:1',source_occurrence_sha256:baselineRowsSha256(occurrences),entry_id:variant.entry_id,identity_variant:variant.identity_variant,concise_reason:'Explicitly reviewed answer abbreviation, not the indefinite article.',provenance};
 const args={works,occurrences,productionEntries,resolutions:[resolution],provenance};
 const reviewed=applyReviewedEntryIdentities(args);
 const consolidated=consolidateIncrementalDelta({occurrences:reviewed.occurrences,productionEntries,identityVariantAssignments:reviewed.identityVariantAssignments});
 assert.equal(consolidated.conflicts.length,0);
 assert.equal(consolidated.newEntries.length,0);
 assert.equal(consolidated.assignments.get(resolution.source_occurrence_id).entry_id,variant.entry_id);
 assert.equal(JSON.stringify(productionEntries),before);
 assert.throws(()=>applyReviewedEntryIdentities({...args,resolutions:[{...resolution,identity_variant:''}]}),/identity-changing/);
 const explicitBase=applyReviewedEntryIdentities({...args,resolutions:[{...resolution,entry_id:base.entry_id,identity_variant:''}]});
 assert.equal(explicitBase.identityVariantAssignments.has(resolution.source_occurrence_id),true);
 assert.equal(explicitBase.identityVariantAssignments.get(resolution.source_occurrence_id),'');
});
