const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { matchLexicalSelection, parseLookupRequest } = require('../lib/lexical/lookup.ts');
const { authorizeLexicalSource, lookupAuthorizedSelection, LexicalAccessError } = require('../lib/lexical/lookup.server.ts');
const { canonicalSourceTextHash } = require('../lib/lexical/hash.ts');
const { rdlLexicalSelection } = require('../lib/lexical/selection.ts');
const { enumerateCtwBlocks } = require('../lib/lexical/enumerators/ctw.server.ts');
const { enumerateRapBlocks } = require('../lib/lexical/enumerators/rap.server.ts');
const { rapSentenceSelectionStem, rapSentenceInsertionInstruction } = require('../lib/reading/rapInteraction.ts');
const { readingLookupEnabled } = require('../lib/reading/lookupCapabilities.ts');
const attemptId = '11111111-1111-4111-8111-111111111111';
const request = (extra = {}) => ({ access: { kind: 'reading', attemptId }, sourceType: 'rap', sourceItemId: 'item', contentBlockId: 'question:q:stem',
  startOffset: 0, endOffset: 5, selectedText: 'green', blockText: 'green energy', ...extra });
const occurrence = (extra = {}) => ({ occurrence_id: 'occ', entry_id: 'entry', source_type: 'rap', source_item_id: 'item', content_block_id: 'question:q:stem',
  start_offset: 0, end_offset: 5, surface_text: 'green', context_pos: 'adjective', context_meaning_zh: '环保的', context_definition_en: 'Good for the environment.',
  lexical_entries: { entry_id: 'entry', canonical_expression: 'green', expression_type: 'word', lemma: 'green' }, ...extra });
function database(tables) {
  const calls = [];
  return { calls, from(table) {
    const filters = []; let limit = Infinity; let single = false;
    calls.push({ table, filters });
    const q = {
      select(columns) { calls.at(-1).columns = columns; return q; },
      eq(k,v) { filters.push([k,'eq',v]); return q; },
      neq(k,v) { filters.push([k,'neq',v]); return q; },
      in(k,v) { filters.push([k,'in',v]); return q; },
      lte(k,v) { filters.push([k,'lte',v]); return q; },
      gte(k,v) { filters.push([k,'gte',v]); return q; },
      order() { return q; }, limit(v) { limit = v; return q; }, maybeSingle() { single = true; return q; },
      then(resolve, reject) {
        const result = (tables[table] ?? []).filter(row => filters.every(([k,op,v]) => {
          const value = k.split('.').reduce((r,k) => r?.[k], row);
          return op === 'eq' ? value === v : op === 'neq' ? value !== v : op === 'in' ? v.includes(value) : op === 'lte' ? value <= v : value >= v;
        })).slice(0, limit);
        return Promise.resolve({ data: single ? result[0] ?? null : result, error: null }).then(resolve,reject);
      }
    }; return q;
  }};
}
const readers = {
  fullSetAttempt: async () => ({ attempt: { status: 'completed', completedAt: 'now' }, error: null }),
  writingAttempt: async () => ({ data: { task_type: 'email', question_id: 'raw', status: 'submitted' }, error: null }),
  writingQuestion: async () => ({ data: { scenario: 'green energy' }, questionSource: 'question_bank', error: null }),
  basFinalVisible: (_a, answer) => answer.is_correct === true
};
function readingTables(status = 'submitted') {
  return { reading_attempts: [{ attempt_id: attemptId, student_id: 'student', logical_item_id: 'item', task_type: 'rap', status, submitted_at: status === 'submitted' ? 'now' : null }],
    reading_logical_items: [{ logical_item_id: 'item', module: 'rap' }],
    reading_questions: [{ question_id: 'q', logical_item_id: 'item', module: 'rap', question_type: 'rap_multiple_choice', stem: 'green energy' }] };
}
test('exact phrase > exact token > bounded complete-token parent supplement > unmatched', () => {
  const phrase = occurrence({ occurrence_id: 'phrase', end_offset: 12, surface_text: 'green energy', lexical_entries: { entry_id: 'p', canonical_expression: 'green energy', expression_type: 'phrase', lemma: 'green energy' } });
  assert.equal(matchLexicalSelection([phrase, occurrence()], request({ endOffset: 12, selectedText: 'green energy' })).match, 'exact_phrase');
  assert.equal(matchLexicalSelection([phrase, occurrence()], request()).match, 'exact_token');
  assert.equal(matchLexicalSelection([phrase], request()).match, 'supplement_parent');
  assert.equal(matchLexicalSelection([phrase], request({ endOffset: 3, selectedText: 'gre' })).status, 'unmatched');
  assert.equal(matchLexicalSelection([], request()).status, 'unmatched');
  assert.equal(matchLexicalSelection([occurrence()], request({ sourceItemId: 'wrong' })).status, 'unmatched');
  assert.equal(matchLexicalSelection([occurrence()], request({ contentBlockId: 'wrong' })).status, 'unmatched');
});
test('request requires exact UTF-16 span, bounded block, known source and owned-page proof shape', () => {
  assert.ok(parseLookupRequest(request()));
  for (const extra of [{ selectedText: 'other' }, { startOffset: -1 }, { endOffset: 999 }, { blockText: 'x'.repeat(32001) }, { sourceType: 'web' }, { access: { kind: 'active', attemptId } }]) assert.equal(parseLookupRequest(request(extra)), null);
});
test('unauthorized, wrong source, wrong block and active Reading are rejected before any lexical table read', async () => {
  for (const [user, r, status] of [['stranger',request(),'submitted'], ['student',request({ sourceItemId: 'other' }),'submitted'], ['student',request({ contentBlockId: 'question:invisible:stem' }),'submitted'], ['student',request(),'in_progress']]) {
    const db = database(readingTables(status));
    await assert.rejects(authorizeLexicalSource(db,db,user,r,readers), LexicalAccessError);
    assert.equal(db.calls.some(c => c.table.startsWith('lexical_')), false);
  }
  for (const type of ['ctw','rdl','rap']) assert.equal(readingLookupEnabled('active', type), false);
});
test('result/review/history authorization uses owned submitted source; one bounded occurrence join returns minimal payload', async () => {
  const tables = readingTables();
  tables.lexical_source_blocks = [{ source_type: 'rap', source_item_id: 'item', content_block_id: 'question:q:stem', generation_status: 'generated', source_text_hash: canonicalSourceTextHash('green energy') }];
  tables.lexical_occurrences = [occurrence({ review_status: 'generated' })];
  const db = database(tables);
  const authorized = await authorizeLexicalSource(db,db,'student',request(),readers);
  const response = await lookupAuthorizedSelection(db,request(),authorized);
  assert.equal(response.status, 'matched'); assert.equal(response.occurrence.context_meaning_zh, '环保的');
  assert.deepEqual(Object.keys(response.entry), ['entry_id','canonical_expression','expression_type','lemma']);
  assert.equal(db.calls.filter(c => c.table === 'lexical_occurrences').length, 1);
  assert.ok(db.calls.find(c => c.table === 'lexical_occurrences').columns.includes('lexical_entries!inner'));
  assert.doesNotMatch(JSON.stringify(response), /context_text|common_senses|derived_words|useful_patterns/);
  const noisy = matchLexicalSelection([occurrence({ context_text:'full passage',generation_version:'lexical-v1',review_notes:'private audit',lexical_entries:{ ...occurrence().lexical_entries,common_senses:['unused'] } })],request());
  assert.doesNotMatch(JSON.stringify(noisy), /context_text|generation_version|review_notes|common_senses/);
  assert.equal((await lookupAuthorizedSelection(db,request({ blockText: 'changed snapshot' }), authorized)).status, 'unavailable');
  tables.lexical_source_blocks[0].source_text_hash = 'changed';
  assert.equal((await lookupAuthorizedSelection(db,request(),authorized)).status, 'unavailable');
});
test('Full Set reuses internal item identity and excludes questions outside the completed attempt', async () => {
  const db = database({ ...readingTables(), reading_full_set_module_attempts: [{ attempt_id: attemptId, module_attempt_id: 'm1' }, { attempt_id: attemptId, module_attempt_id: 'm2' }],
    reading_full_set_answers: [{ module_attempt_id: 'm1', logical_item_id: 'item', question_id: 'q', answer_id: 'answer' }] });
  const r = request({ access: { kind: 'full_set', attemptId } });
  assert.equal((await authorizeLexicalSource(db,db,'student',r,readers)).sourceItemId, 'item');
  await assert.rejects(authorizeLexicalSource(db,db,'student',request({ ...r, contentBlockId: 'question:outside:stem' }),readers), LexicalAccessError);
  await assert.rejects(authorizeLexicalSource(db,db,'student',r,{ ...readers, fullSetAttempt: async () => ({ attempt: { status: 'active' }, error: null }) }), e => e.status === 409);
});
test('CTW canonical reconstruction and UTF-16 offsets do not use student errors', async () => {
  const text = 'A 😀 green world.';
  const block = enumerateCtwBlocks({ sourceItemId: 'item', paragraphs: [{ paragraphId: 'p', paragraphOrder: 1 }],
    segments: [{ paragraphId: 'p', segmentOrder: 1, segmentType: 'text', textContent: 'A 😀 ', slotId: null }, { paragraphId: 'p', segmentOrder: 2, segmentType: 'blank', textContent: null, slotId: 'slot' }, { paragraphId: 'p', segmentOrder: 3, segmentType: 'text', textContent: ' world.', slotId: null }],
    slots: [{ slotId: 'slot', paragraphId: 'p', answer: 'green' }] })[0];
  assert.equal(block.text, text); assert.equal(block.anchors[0].startOffset, 5); assert.equal(block.anchors[0].endOffset, 10);
  const db = database({ reading_attempts: [{ attempt_id: attemptId, student_id: 'student', logical_item_id: 'item', task_type: 'ctw', status: 'submitted', submitted_at: 'now' }],
    reading_logical_items: [{ logical_item_id: 'item', module: 'ctw' }], reading_ctw_paragraphs: [{ paragraph_id: 'p', question_id: 'q' }],
    reading_questions: [{ question_id: 'q', logical_item_id: 'item', module: 'ctw' }], reading_ctw_segments: [
      { paragraph_id: 'p', segment_type: 'text', text_content: 'A 😀 ' }, { paragraph_id: 'p', segment_type: 'blank', slot_id: 'slot' }, { paragraph_id: 'p', segment_type: 'text', text_content: ' world.' }],
    reading_ctw_slots: [{ paragraph_id: 'p', slot_id: 'slot', answer: 'green' }] });
  assert.equal((await authorizeLexicalSource(db,db,'student',request({ sourceType: 'ctw', contentBlockId: 'paragraph:p', blockText: text, startOffset: 5, endOffset: 10 }),readers)).text, text);
});
test('RDL uses existing flattened selection-map character identities to produce canonical UTF-16 span', () => {
  const chars = (text, wordId, start) => Array.from(text).map((char,i) => ({ id: `${wordId}-${i}`, char, charIndex: i, globalIndex: start+i, needsReview: false }));
  const map = { lines: [{ lineIndex: 0, breakAfter: 'space', words: [{ id:'w1', wordIndex:0, characters: chars('😀','w1',0) }, { id:'w2', wordIndex:1, characters: chars('green','w2',1) }] },
    { lineIndex:1, breakAfter:'end', words:[{ id:'w3', wordIndex:0, characters:chars('world','w3',6) }] }] };
  assert.deepEqual(rdlLexicalSelection(map,{ startIndex:1, endIndex:5 }), { blockText:'😀 green world', startOffset:3, endOffset:8, selectedText:'green' });
  map.lines[0].breakAfter = 'unknown'; map.lines[1].breakAfter = 'unknown';
  assert.equal(rdlLexicalSelection(map,{ startIndex:6, endIndex:10 }).selectedText, 'world');
});
test('RAP sentence-selection visible stem transformation matches production block, not raw hidden text', async () => {
  const raw = 'Select the sentence in the passage that best expresses the main idea.';
  const transformed = rapSentenceSelectionStem(raw);
  const blocks = enumerateRapBlocks({ sourceItemId:'item',passageId:'p',paragraphs:[{ paragraphId:'paragraph',paragraphOrder:1,paragraphText:'A 😀 green world. It thrives.',sentences:[
    { sentenceId:'s1',sentenceOrder:1,sentenceText:'A 😀 green world.' }, { sentenceId:'s2',sentenceOrder:2,sentenceText:'It thrives.' }] }],
    questions:[{ questionId:'q',questionOrder:1,questionType:'rap_sentence_selection',stem:raw,options:[] }] });
  assert.equal(blocks.find(b => b.contentBlockId === 'question:q:stem').text, transformed);
  assert.equal(blocks[0].anchors[1].startOffset, 'A 😀 green world. '.length);
  const tables = readingTables(); tables.reading_questions[0] = { ...tables.reading_questions[0], question_type:'rap_sentence_selection',stem:raw };
  const db = database(tables);
  assert.equal((await authorizeLexicalSource(db,db,'student',request(),readers)).text, transformed);
  await assert.rejects(authorizeLexicalSource(db,db,'student',request({ contentBlockId:'question:q:option:hidden' }),readers),LexicalAccessError);
  assert.ok(rapSentenceInsertionInstruction().includes('\n\n'));
});
test('RDL/RAP stems and visible option blocks resolve by question and option identity, not text search', async () => {
  for (const type of ['rdl','rap']) {
    const tables = readingTables(); tables.reading_attempts[0].task_type = type; tables.reading_logical_items[0].module = type;
    tables.reading_questions[0].module = type; tables.reading_questions[0].question_type = type === 'rdl' ? 'rdl' : 'rap_multiple_choice';
    tables.reading_question_options = [{ question_id:'q',option_id:'option',option_text:'green energy' }];
    const db = database(tables); const r = request({ sourceType:type,contentBlockId:'question:q:option:option' });
    assert.equal((await authorizeLexicalSource(db,db,'student',r,readers)).text,'green energy');
    await assert.rejects(authorizeLexicalSource(db,db,'student',{ ...r,contentBlockId:'question:q:option:wrong' },readers),LexicalAccessError);
  }
});
test('Email/AD canonical blocks only: stale snapshots become unavailable, withdrawn drafts/custom assignments/student response are rejected', async () => {
  const db = database({ practice_item_sources:[{ task_type:'email',source_question_id:'raw',is_canonical:true,item_id:'canonical' }] });
  const r = request({ access:{ kind:'writing',attemptId },sourceType:'write_email',sourceItemId:undefined,contentBlockId:'scenario' });
  assert.equal((await authorizeLexicalSource(db,db,'student',r,readers)).sourceItemId,'canonical');
  for (const block of ['student-response','closing-instruction','ui-chrome']) await assert.rejects(authorizeLexicalSource(db,db,'student',{ ...r,contentBlockId:block },readers),LexicalAccessError);
  await assert.rejects(authorizeLexicalSource(db,db,'student',r,{ ...readers, writingQuestion:async () => ({ data:{},questionSource:'custom' }) }),LexicalAccessError);
  await assert.rejects(authorizeLexicalSource(db,db,'student',r,{ ...readers,writingAttempt:async () => ({ data:{ task_type:'email',question_id:'raw',status:'draft' } }),writingQuestion:async () => ({ data:{},questionSource:'question_bank',assignmentAvailable:false }) }),LexicalAccessError);
  const stale = await authorizeLexicalSource(db,db,'student',r,{ ...readers,writingQuestion:async () => ({ data:{ scenario:'old snapshot' },questionSource:'question_bank' }) });
  assert.equal((await lookupAuthorizedSelection(db,r,stale)).status,'unavailable');
  const adDb = database({ practice_item_sources:[{ task_type:'academic_discussion',source_question_id:'raw',is_canonical:true,item_id:'ad' }] });
  const adReaders = { ...readers,writingAttempt:async () => ({ data:{ task_type:'academic_discussion',question_id:'raw',status:'submitted' } }),writingQuestion:async () => ({ data:{ student_1_response:'green energy' },questionSource:'question_bank' }) };
  assert.equal((await authorizeLexicalSource(adDb,adDb,'student',{ ...r,sourceType:'academic_discussion',contentBlockId:'student-response:1' },adReaders)).text,'green energy');
});
test('BAS routes only owned question prompt/final-sentence to canonical logical Q order, never student answers', async () => {
  const db = database({ attempts:[{ attempt_id:attemptId,student_id:'student',set_id:'set',submitted_at:'now' }],attempt_answers:[{ attempt_id:attemptId,question_id:'raw' }],
    questions:[{ question_id:'raw',set_id:'set',prompt:'green energy',final_sentence:'A green world.' }],
    practice_item_sources:[{ source_id:'source',item_id:'bas-item',task_type:'build_sentence',source_set_id:'set',is_canonical:true }],
    practice_item_question_map:[{ source_id:'source',source_question_id:'raw',logical_question_order:2 }] });
  const r = request({ access:{ kind:'bas',attemptId,questionId:'raw' },sourceType:'bas',sourceItemId:undefined,contentBlockId:'prompt' });
  assert.deepEqual(await authorizeLexicalSource(db,db,'student',r,readers), { sourceItemId:'bas-item',contentBlockId:'question:q02:prompt',text:'green energy' });
  await assert.rejects(authorizeLexicalSource(db,db,'stranger',r,readers),LexicalAccessError);
  await assert.rejects(authorizeLexicalSource(db,db,'student',{ ...r,contentBlockId:'student-answer' },readers),LexicalAccessError);
  await assert.rejects(authorizeLexicalSource(db,db,'student',{ ...r,contentBlockId:'final-sentence' },readers),LexicalAccessError);
  assert.equal((await authorizeLexicalSource(db,db,'student',{ ...r,contentBlockId:'final-sentence' },{ ...readers,basFinalVisible:() => true })).text,'A green world.');
  const active = { ...r, access:{ kind:'bas_prompt',setId:'set',questionId:'raw' } };
  assert.equal((await authorizeLexicalSource(db,db,'student',active,readers)).contentBlockId,'question:q02:prompt');
  await assert.rejects(authorizeLexicalSource(db,db,'student',{ ...active,contentBlockId:'final-sentence' },readers),LexicalAccessError);
  await assert.rejects(authorizeLexicalSource(db,db,'student',{ ...active,access:{ ...active.access,setId:'other-set' } },readers),LexicalAccessError);
});
test('RDL material authorization is bounded and reuses the registered material, without per-selection asset downloads', async () => {
  const tables = readingTables(); tables.reading_attempts[0].task_type = 'rdl'; tables.reading_logical_items[0].module = 'rdl';
  tables.reading_questions[0] = { ...tables.reading_questions[0],module:'rdl',material_id:'RDL-001' };
  tables.reading_materials = [{ material_id:'RDL-001',binding_status:'bound',image_asset_path:'reading/image.png',hitbox_data_path:'reading/selection_map.json' }];
  const db = database(tables); const r = request({ sourceType:'rdl',contentBlockId:'material:RDL-001' });
  assert.deepEqual(await authorizeLexicalSource(db,db,'student',r,readers),{ sourceItemId:'item',contentBlockId:'material:RDL-001',text:r.blockText });
  await assert.rejects(authorizeLexicalSource(db,db,'student',{ ...r,contentBlockId:'material:OTHER' },readers),LexicalAccessError);
  tables.reading_materials[0].binding_status = 'unbound';
  await assert.rejects(authorizeLexicalSource(db,db,'student',r,readers),LexicalAccessError);
});
test('submitted Reading corrections reuse canonical source and reject active corrections or invisible question blocks', async () => {
  const tables = readingTables();
  tables.reading_wrongbook_attempts = [{ attempt_id:attemptId,student_id:'student',logical_item_id:'item',task_type:'rap',status:'submitted',submitted_at:'now',targets:[{ questionId:'q' }] }];
  const db = database(tables); const r = request({ access:{ kind:'reading_wrongbook',attemptId } });
  assert.equal((await authorizeLexicalSource(db,db,'student',r,readers)).sourceItemId,'item');
  await assert.rejects(authorizeLexicalSource(db,db,'student',{ ...r,contentBlockId:'question:hidden:stem' },readers),LexicalAccessError);
  tables.reading_wrongbook_attempts[0].status = 'in_progress';
  await assert.rejects(authorizeLexicalSource(db,db,'student',r,readers),e => e.status === 409);
});
test('all six source types resolve the production row contract using small offline fixtures, without tmp artifacts or runtime generation', async () => {
  for (const type of ['ctw','rdl','rap','bas','write_email','academic_discussion']) {
    const o = occurrence({ source_type:type });
    const e = o.lexical_entries;
    const b = { source_type:type,source_item_id:o.source_item_id,content_block_id:o.content_block_id,
      text:'green energy',source_text_hash:canonicalSourceTextHash('green energy') };
    const r = request({ sourceType:type,sourceItemId:o.source_item_id,contentBlockId:o.content_block_id,startOffset:o.start_offset,endOffset:o.end_offset,selectedText:o.surface_text,blockText:b.text });
    const db = database({ lexical_source_blocks:[{ ...b,generation_status:'generated' }],lexical_occurrences:[{ ...o,lexical_entries:e }] });
    const result = await lookupAuthorizedSelection(db,r,{ sourceItemId:o.source_item_id,contentBlockId:o.content_block_id,text:b.text });
    assert.equal(result.status,'matched',type); assert.equal(result.entry.entry_id,o.entry_id); assert.equal(result.occurrence.context_definition_en,o.context_definition_en);
  }
});
test('runtime API/browser boundary contains no direct client corpus access or semantic models', () => {
  const read = p => fs.readFileSync(path.join(__dirname,'..',p),'utf8');
  const client = read('components/lexical/LexicalLookup.tsx');
  const api = read('app/api/lexical/lookup/route.ts');
  const server = read('lib/lexical/lookup.server.ts');
  assert.match(api,/requireReadingAttemptStudent/); assert.ok(api.indexOf('authorizeLexicalSource(client') < api.indexOf('lookupAuthorizedSelection(db'));
  assert.match(client,/\/api\/lexical\/lookup/); assert.doesNotMatch(client,/\.from\("lexical_|common_senses|derived_words|useful_patterns|生词本/);
  assert.doesNotMatch(api+server,/deepseek|openai|generateSemantic|provider\.server|\.insert\(|\.upsert\(/i);
});
