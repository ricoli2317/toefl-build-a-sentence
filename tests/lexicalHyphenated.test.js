const assert = require('node:assert/strict');
const test = require('node:test');
const { hyphenatedCompounds, hyphenatedCoverage, assertHyphenatedCoverage } = require('../lib/lexical/hyphenated.ts');
const { tokenizeCanonicalBlock } = require('../lib/lexical/tokenize.ts');
const { qaLexicalBlock } = require('../lib/lexical/qa.ts');
const { matchLexicalSelection } = require('../lib/lexical/lookup.ts');
const { validateAnnotationBatch } = require('../lib/lexical/annotation.ts');
const { buildDeltaPlan } = require('../lib/lexical/incremental/deltaPlan.ts');
const { consolidateIncrementalDelta } = require('../lib/lexical/incremental/consolidation.ts');
const { runDeltaQa } = require('../lib/lexical/incremental/deltaQa.ts');
const { annotationStageInput, incrementalAgentProvenance } = require('../lib/lexical/incremental/envelope.ts');
const block = text => ({sourceType:'rdl',sourceItemId:'item',contentBlockId:'material:RDL-test',blockKind:'rdl_material',text});
const span = (b, start, end) => ({source_type:b.sourceType,source_item_id:b.sourceItemId,content_block_id:b.contentBlockId,
  start_offset:start,end_offset:end,surface_text:b.text.slice(start,end)});

test('enumeration preserves maximal hyphen compounds, repeated uses, case, Unicode and UTF-16', () => {
  const b=block('😀 Eco-friendly eco-friendly fun-filled state-of-the-art well\u2011being blue\u2010light; Monday - Friday, long—term, 555-0168, 2026-10-13, X1-test.');
  const found=hyphenatedCompounds(b);
  assert.deepEqual(found.map(x=>x.surface_text),['Eco-friendly','eco-friendly','fun-filled','state-of-the-art','well\u2011being','blue\u2010light']);
  assert.equal(found[0].start_offset,3);
  for (const o of found) assert.equal(b.text.slice(o.start_offset,o.end_offset),o.surface_text);
  assert.deepEqual(hyphenatedCompounds(block('partly-hyphenated2 -not-a-word-')).map(x=>x.surface_text),[]);
});

test('excluded person names stay excluded, but uncertain source spans still require coverage', () => {
  const b={...block('Mary-Jane uses eco-friendly bags.'),anchors:[{anchorId:'name',anchorKind:'coverage_exclusion',startOffset:0,endOffset:9,metadata:{reason:'person_name'}}]};
  assert.deepEqual(hyphenatedCompounds(b).map(x=>x.surface_text),['eco-friendly']);
  b.anchors=[];
  assert.equal(hyphenatedCompounds(b).length,2);
});

test('separate components and larger containing expressions cannot satisfy exact compound coverage', () => {
  const b=block('eco-friendly products and eco-friendly packaging');
  const compounds=hyphenatedCompounds(b);
  const components=tokenizeCanonicalBlock(b).tokens.map(t=>({...span(b,t.startOffset,t.endOffset),layer:1}));
  assert.equal(hyphenatedCoverage([b],components).missing.length,2);
  assert.throws(()=>assertHyphenatedCoverage([b],[...components,span(b,0,21)]),/Missing complete hyphenated/);
  assert.equal(hyphenatedCoverage([b],[...components,compounds[0]]).missing.length,1);
  assert.equal(assertHyphenatedCoverage([b],[...components,...compounds]).missing.length,0);
  assert.equal(qaLexicalBlock(tokenizeCanonicalBlock(b),components).generationStatus,'failed');
  assert.equal(qaLexicalBlock(tokenizeCanonicalBlock(b),components).missingHyphenatedOccurrences,2);
});

test('eco-friendly, fun-filled and RAP meat-eating have exact full matches; friendly/filled retain exact token matches', () => {
  for (const [type,text,term,part] of [['rdl','Enjoy a fun-filled day.','fun-filled','filled'],['rdl','Use eco-friendly products.','eco-friendly','friendly'],['rap','A small, meat-eating dinosaur.','meat-eating','eating']]) {
    const b={...block(text),sourceType:type};
    const compound=hyphenatedCompounds(b)[0];
    const parts=tokenizeCanonicalBlock(b).tokens.map(t=>({...span(b,t.startOffset,t.endOffset),context_pos:'adjective',context_meaning_zh:'语境词义',context_definition_en:'A contextual component meaning.'}));
    const rows=[...parts,compound].map((o,i)=>({...o,occurrence_id:`o${i}`,entry_id:`e${i}`,context_pos:o.context_pos??'adjective',
      context_meaning_zh:o.context_meaning_zh??'完整复合词义',context_definition_en:o.context_definition_en??'A definition of the whole compound.',
      lexical_entries:{entry_id:`e${i}`,canonical_expression:o.surface_text,lemma:o.surface_text,expression_type:o===compound?'phrase':'word'}}));
    const request = (word) => {const start=text.indexOf(word);return {sourceType:type,sourceItemId:'item',contentBlockId:b.contentBlockId,startOffset:start,endOffset:start+word.length,selectedText:word}};
    assert.equal(matchLexicalSelection(rows,request(term)).match,'exact_phrase');
    assert.equal(matchLexicalSelection(rows,request(part)).match,'exact_token');
    assert.equal(matchLexicalSelection(rows,request(part)).occurrence.surface_text,part);
    assert.equal(matchLexicalSelection(rows,request(part)).containingPhrases[0].occurrence.surface_text,term);
    assert.equal(matchLexicalSelection(rows,request(part.slice(1))).status,'unmatched');
  }
});

test('coverage is source/block scoped, not a global expression inventory', () => {
  const b=block('eco-friendly');
  const [o]=hyphenatedCompounds(b);
  assert.equal(hyphenatedCoverage([b],[{...o,source_type:'rap'}]).missing.length,1);
  assert.equal(hyphenatedCoverage([b],[{...o,content_block_id:'other'}]).missing.length,1);
  assert.equal(hyphenatedCoverage([b],[{...o,surface_text:'Eco-friendly'}]).missing.length,1);
});

test('incremental publication fails closed on full token coverage but missing hyphen compound', () => {
  const b=block('eco-friendly');const work=tokenizeCanonicalBlock(b);
  const block_key=`${b.sourceType}:${b.sourceItemId}:${b.contentBlockId}`;
  const tokens=work.tokens.map(t=>({candidate_id:t.candidateId,context_pos:'adjective',context_meaning_zh:'组成词义',context_definition_en:'The contextual component meaning.',
    canonical_expression:t.surfaceText,lemma:t.surfaceText,expression_type:'word',needs_review:false,review_notes:null}));
  const compound={start_offset:0,end_offset:12,surface_text:'eco-friendly',context_pos:'adjective',context_meaning_zh:'环保的',
    context_definition_en:'Designed to cause little harm to the environment.',canonical_expression:'eco-friendly',lemma:'eco-friendly',expression_type:'phrase',learning_value:'fixed_expression',needs_review:false,review_notes:null};
  const plan=buildDeltaPlan({canonicalBlocks:[b],productionBlocks:[],productionBaseline:{}});
  const health=Object.fromEntries(['orphan_occurrences','missing_blocks','duplicate_spans','duplicate_entry_identity','invalid_block_hash_format','non_generated_blocks'].map(k=>[k,0]));
  const qa=expressions=>{const occurrences=validateAnnotationBatch([work],{blocks:[{block_key,tokens,expressions}]});return runDeltaQa({deltaPlan:plan,works:[work],occurrences,
    consolidation:consolidateIncrementalDelta({occurrences,productionEntries:[]}),artifactBlockKeys:[block_key],productionHealth:health,baselineDrift:null,
    layer2Qa:{removed:0,corrected:0,pass:expressions.length,status:'applied'},productionOccurrences:[],productionEntries:[],productionBlocks:[]})};
  assert.throws(()=>qa([]),/missing_hyphenated_occurrence.*1/);
  const report=qa([compound]);assert.equal(report.import_ready,true);assert.equal(report.delta_coverage.hyphenated_compounds,1);assert.equal(report.delta_coverage.missing_hyphenated_occurrence,0);
  assert.deepEqual(annotationStageInput([work],'batch','sig',incrementalAgentProvenance()).blocks[0].required_hyphenated_compounds,[{start_offset:0,end_offset:12,surface_text:'eco-friendly'}]);
});
