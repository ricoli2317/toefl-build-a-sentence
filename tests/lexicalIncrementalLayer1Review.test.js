const test=require('node:test');
const assert=require('node:assert/strict');
const {tokenizeCanonicalBlocks}=require('../lib/lexical/tokenize.ts');
const {validateAnnotationBatch}=require('../lib/lexical/annotation.ts');
const {incrementalAgentProvenance}=require('../lib/lexical/incremental/envelope.ts');
const {baselineRowsSha256}=require('../lib/lexical/incremental/baselineHash.ts');
const {canonicalSourceTextHash}=require('../lib/lexical/hash.ts');
const {occurrenceIdentityOf}=require('../lib/lexical/incremental/consolidation.ts');
const {applyLayer1SemanticReviews}=require('../lib/lexical/incremental/layer1Review.ts');
function fixture(){
 const block={sourceType:'bas',sourceItemId:'item',contentBlockId:'question:q01:prompt',blockKind:'bas_prompt',text:'I swim.'};
 const works=tokenizeCanonicalBlocks([block]);
 const tokens=works[0].tokens.filter(t=>!t.excluded).map(t=>({candidate_id:t.candidateId,context_pos:t.surfaceText==='I'?'pronoun':'verb',context_meaning_zh:t.surfaceText==='I'?'我':'游泳',context_definition_en:t.surfaceText==='I'?'The speaker referring to themself.':'Move through water using the body.',canonical_expression:t.surfaceText==='I'?'I':'swim',lemma:t.surfaceText==='I'?'I':'swim',expression_type:'word',needs_review:t.surfaceText==='I',review_notes:t.surfaceText==='I'?'Check pronoun.':null}));
 const occurrences=validateAnnotationBatch(works,{blocks:[{block_key:'bas:item:question:q01:prompt',tokens,expressions:[]}]});
 const row=occurrences[0];
 const review={source_occurrence_id:occurrenceIdentityOf(row),source_occurrence_sha256:baselineRowsSha256([row]),verdict:'confirm',concise_reason:'The explicit subject identifies the speaker.',evidence:[{block_key:'bas:item:question:q01:prompt',source_text_sha256:canonicalSourceTextHash(block.text),quote:'I swim.'}],provenance:incrementalAgentProvenance()};
 return {works,canonicalBlocks:[block],occurrences,reviews:[review],provenance:incrementalAgentProvenance()};
}
test('Layer-1 confirmation and correction replay without changing originals, identities or unaffected rows',()=>{
 const f=fixture(),before=JSON.stringify(f),r=applyLayer1SemanticReviews(f);
 assert.equal(r.summary.confirmed,1);assert.equal(r.summary.unresolved,0);
 assert.equal(r.occurrences[0].review_status,'generated');assert.match(r.occurrences[0].review_notes,/Original flag/);
 assert.deepEqual(r.occurrences[1],f.occurrences[1]);assert.equal(JSON.stringify(f),before);
 f.reviews[0]={...f.reviews[0],verdict:'correct',corrections:{context_definition_en:'The person speaking, used as the subject.'}};
 const c=applyLayer1SemanticReviews(f);assert.equal(c.summary.corrected,1);
 assert.equal(occurrenceIdentityOf(c.occurrences[0]),occurrenceIdentityOf(f.occurrences[0]));
 assert.equal(c.occurrences[0].entry_key,f.occurrences[0].entry_key);
});
test('Layer-1 review rejects missing, stale, duplicate, unflagged and Layer-2 decisions',()=>{
 const f=fixture();assert.throws(()=>applyLayer1SemanticReviews({...f,reviews:[]}));
 for(const patch of [{source_occurrence_sha256:'0'.repeat(64)},{provenance:{...f.provenance,model:'other'}},{verdict:'PASS'},{extra:true}]){
  assert.throws(()=>applyLayer1SemanticReviews({...f,reviews:[{...f.reviews[0],...patch}]}));
 }
 assert.throws(()=>applyLayer1SemanticReviews({...f,reviews:[...f.reviews,...f.reviews]}));
 for(const patch of [{layer:2},{review_status:'generated'}]){
  const row={...f.occurrences[0],...patch};
  assert.throws(()=>applyLayer1SemanticReviews({...f,occurrences:[row,...f.occurrences.slice(1)],reviews:[{...f.reviews[0],source_occurrence_sha256:baselineRowsSha256([row])}]}));
 }
});
test('Layer-1 review requires exact same-source canonical evidence and work',()=>{
 const f=fixture();assert.throws(()=>applyLayer1SemanticReviews({...f,works:[]}));
 for(const patch of [{quote:'not in source'},{quote:''},{source_text_sha256:'0'.repeat(64)},{block_key:'elsewhere'},{extra:true}]){
  assert.throws(()=>applyLayer1SemanticReviews({...f,reviews:[{...f.reviews[0],evidence:[{...f.reviews[0].evidence[0],...patch}]}]}));
 }
 const foreign={...f.canonicalBlocks[0],sourceItemId:'foreign'};
 assert.throws(()=>applyLayer1SemanticReviews({...f,canonicalBlocks:[...f.canonicalBlocks,foreign],reviews:[{...f.reviews[0],evidence:[{...f.reviews[0].evidence[0],block_key:'bas:foreign:question:q01:prompt'}]}]}));
});
test('Layer-1 correction cannot alter identity, boundaries or bypass semantic validators',()=>{
 const f=fixture();
 for(const corrections of [{start_offset:1},{canonical_expression:'we'},{lemma:'we'},{expression_type:'phrase'},{context_pos:'imaginary'},{context_meaning_zh:'English only'},{context_definition_en:'中文'},{context_definition_en:''},{}]){
  assert.throws(()=>applyLayer1SemanticReviews({...f,reviews:[{...f.reviews[0],verdict:'correct',corrections}]}));
 }
 const works=structuredClone(f.works);works[0].tokens[0].sourceReviewReason='Unresolved source issue';
 assert.throws(()=>applyLayer1SemanticReviews({...f,works}));
});
