const assert = require('node:assert/strict');
const {mkdir, mkdtemp, readFile, readdir, rm, writeFile, unlink} = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const {
  auditParallelAnnotationPlan, buildLexicalParallelPlan, balanceParallelBatches, checkParallelCoverage,
  nextParallelAnnotationBatch, acceptParallelAnnotationBatch, abortParallelAnnotationBatch, parallelAnnotationStatus,
  verifyParallelAnnotation, mergeParallelAnnotation
} = require('../lib/lexical/parallelAnnotation.ts');
const {prepareNextLexicalAgentBatch, acceptLexicalAgentBatch, lexicalAgentPaths} = require('../lib/lexical/agentProtocol.ts');

const OWNER = 'session_test_worker_0001';
const shardPath = (root, shard) => path.join(root, 'tmp/lexical-v1/parallel-v1', `shard-${String(shard).padStart(2, '0')}`);
const fileJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

async function fixture() {
  const base = path.join(process.cwd(), 'tmp');
  await mkdir(base, {recursive: true});
  const root = await mkdtemp(path.join(base, 'parallel-annotation-test-'));
  const output = path.join(root, 'tmp/lexical-v1');
  await mkdir(output, {recursive: true});
  const blocks = Array.from({length: 50}, (_, index) => ({
    source_type: 'ctw', source_item_id: `item-${index}`, content_block_id: 'paragraph',
    block_kind: 'ctw_paragraph', source_text_hash: `hash-${index}`, text: 'Alpha', anchors: []
  }));
  const tokens = blocks.map(block => ({
    candidateId: `ctw:${block.source_item_id}:paragraph:0:5`, sourceType: 'ctw', sourceItemId: block.source_item_id,
    contentBlockId: 'paragraph', blockKind: 'ctw_paragraph', sourceTextHash: block.source_text_hash,
    surfaceText: 'Alpha', normalizedSurface: 'alpha', startOffset: 0, endOffset: 5,
    sourceAnchorId: null, sentenceId: null, excluded: false, exclusionReason: null, sourceReviewReason: null
  }));
  await writeFile(path.join(output, 'canonical-blocks.jsonl'), blocks.map(JSON.stringify).join('\n') + '\n');
  await writeFile(path.join(output, 'token-candidates.jsonl'), tokens.map(JSON.stringify).join('\n') + '\n');
  await saveJson(path.join(output, 'generation-manifest.json'), {});
  const legacy = await prepareNextLexicalAgentBatch(root);
  const legacyInput = await fileJson(path.join(root, legacy.input_path));
  await saveJson(path.join(root, legacy.output_path), {
    protocol_version: legacy.protocol_version, batch_id: legacy.batch_id, stage: legacy.stage,
    provenance: legacy.provenance, input_signature: legacy.input_signature,
    blocks: legacyInput.blocks.map(block => ({block_key: `${block.source_type}:${block.source_item_id}:${block.content_block_id}`,
      tokens: block.eligible_tokens.map(token => annotation(token))}))
  });
  await acceptLexicalAgentBatch(legacy.batch_id, root);
  await saveJson(lexicalAgentPaths(root).batchPlan, {
    plan_version: 'lexical-agent-batch-plan-v2', annotation_accepted_prefix_batches: 1,
    accepted_annotation_batch_ids: [legacy.batch_id], max_tokens: 80, max_blocks: 6
  });
  const manifest = await fileJson(lexicalAgentPaths(root).manifest);
  manifest.agent_batch_plan_version = 'lexical-agent-batch-plan-v2';
  manifest.planned_annotation_batches = 9;
  await saveJson(lexicalAgentPaths(root).manifest, manifest);
  const result = await buildLexicalParallelPlan(root);
  return {root, ...result, legacy};
}
function annotation(token) {
  return {candidate_id: token.candidate_id, context_pos: 'noun', context_meaning_zh: '测试名词',
    context_definition_en: 'A named unit in this controlled sample.', canonical_expression: 'alpha', lemma: 'alpha',
    expression_type: 'word', needs_review: false, review_notes: null};
}
async function writeOutput(root, active, changes = {}) {
  const input = await fileJson(path.join(root, active.input_path));
  const output = {
    protocol_version: input.protocol_version, stage: input.stage, batch_id: input.batch_id,
    generation_version: input.generation_version, provenance: input.provenance,
    batch_plan_version: input.batch_plan_version, parallel_plan_version: input.parallel_plan_version,
    shard_id: input.shard_id, input_signature: input.input_signature,
    blocks: input.blocks.map(block => ({block_key: `${block.source_type}:${block.source_item_id}:${block.content_block_id}`,
      tokens: block.eligible_tokens.map(annotation)})), ...changes
  };
  await saveJson(path.join(root, active.output_path), output);
  return output;
}
async function acceptAll(root) {
  for (let shard = 0; shard < 8; shard++) {
    while (true) {
      const active = await nextParallelAnnotationBatch(shard, OWNER, root);
      if (!active) break;
      await writeOutput(root, active);
      await acceptParallelAnnotationBatch(shard, active.batch_id, OWNER, root);
    }
  }
}
async function withFixture(fn) {
  const state = await fixture();
  try { await fn(state); } finally { await rm(state.root, {recursive: true, force: true}); }
}

test('eight deterministic greedy shards balance weighted batches and preserve original batch order', () => {
  const items = Array.from({length: 40}, (_, index) => ({
    batch_id: `batch-${index}`, batch_index: index, source_type: 'ctw', input_signature: `${index}`,
    occurrence_count: index + 1, estimated_input_bytes: 100 + index, estimated_output_bytes: index * 1700 + 10,
    weight: index * 1700 + 110, input_sha256: '', work_sha256: ''
  }));
  const first = balanceParallelBatches(items);
  assert.deepEqual(balanceParallelBatches(items), first); // same input, same assignment
  assert.equal(first.shards.length, 8);
  assert.deepEqual(first.batches.map(b => b.batch_id), items.map(b => b.batch_id));
  assert.equal(new Set(first.shards.flatMap(s => s.assigned_batch_ids)).size, 40);
  assert.equal(Math.max(...first.shards.map(s => s.cumulative_weight)) / Math.min(...first.shards.map(s => s.cumulative_weight)) < 1.15, true);
});

test('coverage checker rejects accepted overlap, shard overlap, missing and duplicated occurrences/batches', () => {
  assert.deepEqual(checkParallelCoverage(['A'], ['A','B','C'], [
    {batch_id:'b', shard_id:0, candidate_ids:['B']}, {batch_id:'c', shard_id:1, candidate_ids:['C']}
  ]), {missing_occurrences:0, unexpected_occurrences:0, duplicate_occurrences:0,
    accepted_pending_overlap:0, pairwise_shard_overlap:0, duplicate_batches:0});
  const bad = checkParallelCoverage(['A'], ['A','B','C','D'], [
    {batch_id:'b',shard_id:0,candidate_ids:['A','B']},
    {batch_id:'b',shard_id:1,candidate_ids:['B','C']}
  ]);
  assert.equal(bad.accepted_pending_overlap, 1);
  assert.equal(bad.pairwise_shard_overlap, 1);
  assert.equal(bad.missing_occurrences, 1);
  assert.equal(bad.duplicate_occurrences, 2);
  assert.equal(bad.duplicate_batches, 1);
});

test('frozen accepted prefix is excluded, each pending occurrence and batch belongs to exactly one shard', async () => withFixture(async ({root, plan, coverage, legacy}) => {
  assert.deepEqual(plan.accepted_batch_ids_excluded, [legacy.batch_id]);
  assert.equal(plan.batches.length, 8);
  assert.equal(plan.full_workload_occurrences, 50);
  assert.equal(plan.total_accepted_occurrences, 3);
  assert.equal(plan.total_pending_occurrences, 47);
  assert.deepEqual(Object.values(coverage), [0,0,0,0,0,0]);
  assert.equal(plan.shards.flatMap(s => s.assigned_batch_ids).length, 8);
  assert.equal(new Set(plan.shards.flatMap(s => s.assigned_batch_ids)).size, 8);
  assert.equal(plan.shards.every(s => s.batch_count === 1), true);
  assert.equal((await auditParallelAnnotationPlan(root)).missing_occurrences, 0);
  assert.equal((await fileJson(lexicalAgentPaths(root).manifest)).phase, 'agent_annotation_parallel_ready');
  for (let id = 0; id < 8; id++) {
    const manifest = await fileJson(path.join(shardPath(root, id), 'manifest.json'));
    assert.equal(manifest.active_batch_id, null);
    assert.equal(manifest.shard_id, id);
    assert.equal(await readdir(path.join(shardPath(root, id), 'outputs')).then(x => x.length), 0);
  }
  await assert.rejects(() => prepareNextLexicalAgentBatch(root), /parallel coordinator/);
}));

test('wrong shard next/accept and wrong output shard or parallel plan are rejected', async () => withFixture(async ({root, plan}) => {
  const a = await nextParallelAnnotationBatch(0, OWNER, root);
  const b = await nextParallelAnnotationBatch(1, 'session_test_worker_0002', root);
  assert.equal(plan.shards[0].assigned_batch_ids.includes(a.batch_id), true);
  assert.equal(plan.shards[1].assigned_batch_ids.includes(a.batch_id), false);
  await assert.rejects(() => acceptParallelAnnotationBatch(0, b.batch_id, OWNER, root), /Wrong shard|active frontier/);
  await writeOutput(root, a, {shard_id: 1});
  await assert.rejects(() => acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root), /Wrong-shard output/);
  const noShard = await writeOutput(root, a);
  delete noShard.shard_id;
  await saveJson(path.join(root, a.output_path), noShard);
  await assert.rejects(() => acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root), /Invalid structured output/);
  await writeOutput(root, a, {parallel_plan_version: 'stale-plan'});
  await assert.rejects(() => acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root), /Wrong-shard output/);
  await writeOutput(root, a, {batch_plan_version: 'stale-batch', generation_version: 'stale-generation'});
  await assert.rejects(() => acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root), /Wrong-shard output/);
  await writeOutput(root, a, {input_signature: 'wrong-signature'});
  await assert.rejects(() => acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root), /Wrong-shard output/);
  await writeOutput(root, a, {provenance: {...plan.provenance, model:'deepseek'}});
  await assert.rejects(() => acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root), /Wrong-shard output/);
  await writeOutput(root, a, {recovered_by_lexeme: true});
  await assert.rejects(() => acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root), /Invalid structured output/);
  await writeOutput(root, a);
  await acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root);
  assert.equal((await fileJson(lexicalAgentPaths(root).manifest)).generation.annotation_batches_completed, 1);
}));

test('shard-local locks allow different shards, reject duplicate owners and resume after interruption', async () => withFixture(async ({root}) => {
  const a = await nextParallelAnnotationBatch(0, OWNER, root);
  const b = await nextParallelAnnotationBatch(1, 'session_test_worker_0002', root);
  assert.notEqual(a.batch_id, b.batch_id);
  await assert.rejects(() => nextParallelAnnotationBatch(0, 'session_other_worker', root), /another active writer/);
  assert.deepEqual(await nextParallelAnnotationBatch(0, OWNER, root), a);
  await writeOutput(root, a);
  await acceptParallelAnnotationBatch(0, a.batch_id, OWNER, root);
  assert.equal((await fileJson(path.join(shardPath(root, 0), 'manifest.json'))).active_batch_id, null);
  const oldLock = path.join(shardPath(root, 0), 'active-batch.json');
  await saveJson(oldLock, a); // Simulate process death after manifest flush but before unlink.
  assert.equal(await nextParallelAnnotationBatch(0, OWNER, root), null);
  await assert.rejects(() => readFile(oldLock), /ENOENT/);
}));

test('blocked worker releases only its shard lock and preserves the pending frontier and error', async () => withFixture(async ({root}) => {
  const a = await nextParallelAnnotationBatch(0, OWNER, root);
  const b = await nextParallelAnnotationBatch(1, 'session_test_worker_0002', root);
  await assert.rejects(() => abortParallelAnnotationBatch(0, 'session_other_worker', 'bad', root), /Wrong owner/);
  await abortParallelAnnotationBatch(0, OWNER, 'validator unavailable', root);
  const state = await fileJson(path.join(shardPath(root, 0), 'manifest.json'));
  assert.equal(state.next_batch, a.batch_id);
  assert.equal(state.active_batch_id, null);
  assert.match(state.errors[0], /validator unavailable/);
  assert.equal((await fileJson(path.join(shardPath(root, 1), 'active-batch.json'))).batch_id, b.batch_id);
  assert.equal((await nextParallelAnnotationBatch(0, 'session_new_worker_0003', root)).batch_id, a.batch_id);
}));

test('worker hot path cannot change immutable plan, accepted output or another shard; stale plan fails closed', async () => withFixture(async ({root, plan}) => {
  const planFile = path.join(root, 'tmp/lexical-v1/parallel-v1/plan.json');
  const before = await readFile(planFile);
  const active = await nextParallelAnnotationBatch(0, OWNER, root);
  await writeOutput(root, active);
  await acceptParallelAnnotationBatch(0, active.batch_id, OWNER, root);
  assert.deepEqual(await readFile(planFile), before);
  await assert.rejects(() => acceptParallelAnnotationBatch(0, active.batch_id, OWNER, root));
  const outputFile = path.join(shardPath(root, 0), 'outputs', `${active.batch_id}.output.json`);
  const output = await fileJson(outputFile);
  output.blocks[0].tokens[0].context_meaning_zh = '改动';
  await saveJson(outputFile, output);
  await assert.rejects(() => verifyParallelAnnotation(root), /incomplete|checkpoint|changed/);
  await writeFile(planFile, before);
  const changed = {...plan, model:'corrupted'};
  await saveJson(planFile, changed);
  await assert.rejects(() => nextParallelAnnotationBatch(1, 'session_test_worker_0002', root), /Stale or modified parallel plan/);
  await writeFile(planFile, before);
  const batchPlanFile = lexicalAgentPaths(root).batchPlan;
  const batchPlan = await readFile(batchPlanFile);
  await writeFile(batchPlanFile, `${batchPlan.toString()} `);
  await assert.rejects(() => nextParallelAnnotationBatch(1, 'session_test_worker_0002', root), /Stale or modified parallel plan/);
  await writeFile(batchPlanFile, batchPlan);
}));

test('merge refuses incomplete or active shards and missing semantic occurrences', async () => withFixture(async ({root}) => {
  await assert.rejects(() => mergeParallelAnnotation(root), /incomplete/);
  await acceptAll(root);
  const lock = path.join(shardPath(root, 0), 'active-batch.json');
  await saveJson(lock, {batch_id:'stale'});
  await assert.rejects(() => mergeParallelAnnotation(root), /active shard lock/);
  await unlink(lock);
  const id = (await fileJson(path.join(shardPath(root, 0), 'manifest.json'))).last_checkpoint;
  const outputFile = path.join(shardPath(root, 0), 'outputs', `${id}.output.json`);
  const old = await readFile(outputFile);
  const output = JSON.parse(old);
  output.blocks[0].tokens = [];
  await saveJson(outputFile, output);
  await assert.rejects(() => mergeParallelAnnotation(root), /missing|Invalid|annotation/i);
  await writeFile(outputFile, old);
  assert.equal((await verifyParallelAnnotation(root)).shards_complete, 8);
}));

test('8/8 complete passes verification; merge is stable, idempotent and leaves semantic content intact', async () => withFixture(async ({root, plan}) => {
  await acceptAll(root);
  const status = await parallelAnnotationStatus(root);
  assert.equal(status.finished_shards, 8);
  assert.equal(status.remaining_batches, 0);
  assert.equal(status.remaining_occurrences, 0);
  assert.equal(status.shards.every(s => !s.active && s.next_batch === null), true);
  const check = await verifyParallelAnnotation(root);
  assert.equal(Object.values(check).every(value => value === 0 || value === 8), true);
  const before = plan.batches.map(b => readFile(path.join(shardPath(root, b.shard_id), 'checkpoints', `${b.batch_id}.json`)));
  await mergeParallelAnnotation(root);
  const once = await Promise.all(plan.batches.map(b => readFile(path.join(lexicalAgentPaths(root).checkpointRoot, 'annotation', `${b.batch_id}.json`))));
  assert.deepEqual(once, await Promise.all(before));
  await mergeParallelAnnotation(root);
  assert.deepEqual(once, await Promise.all(plan.batches.map(b => readFile(path.join(lexicalAgentPaths(root).checkpointRoot, 'annotation', `${b.batch_id}.json`)))));
  const manifest = await fileJson(lexicalAgentPaths(root).manifest);
  assert.equal(manifest.phase, 'agent_annotation_merged');
  assert.equal(manifest.generation.annotation_batches_completed, 9);
  assert.equal(manifest.complete, false);
  assert.equal(manifest.import_ready, false);
}));

test('verify rejects corrupted provenance, signature, missing checkpoint, and duplicate assignment', async () => withFixture(async ({root, plan}) => {
  await acceptAll(root);
  const batch = plan.batches[0];
  const outputFile = path.join(shardPath(root, batch.shard_id), 'outputs', `${batch.batch_id}.output.json`);
  const original = await readFile(outputFile);
  const output = JSON.parse(original);
  output.provenance.model = 'other-model';
  await saveJson(outputFile, output);
  await assert.rejects(() => verifyParallelAnnotation(root), /Wrong-shard output/);
  await writeFile(outputFile, original);
  output.provenance = plan.provenance;
  output.input_signature = 'not-original';
  await saveJson(outputFile, output);
  await assert.rejects(() => verifyParallelAnnotation(root), /Wrong-shard output/);
  await writeFile(outputFile, original);
  const checkpointFile = path.join(shardPath(root, batch.shard_id), 'checkpoints', `${batch.batch_id}.json`);
  const checkpoint = await readFile(checkpointFile);
  await unlink(checkpointFile);
  await assert.rejects(() => verifyParallelAnnotation(root), /missing|ENOENT/);
  await writeFile(checkpointFile, checkpoint);
  const planFile = path.join(root, 'tmp/lexical-v1/parallel-v1/plan.json');
  const oldPlan = await readFile(planFile);
  const mutated = JSON.parse(oldPlan);
  mutated.shards[1].assigned_batch_ids.push(batch.batch_id);
  await saveJson(planFile, mutated);
  await assert.rejects(() => verifyParallelAnnotation(root), /Stale or modified parallel plan/);
  await writeFile(planFile, oldPlan);
}));

test('verify rejects an extra output assigned to the wrong shard', async () => withFixture(async ({root, plan}) => {
  await acceptAll(root);
  const foreign = plan.shards[1].assigned_batch_ids[0];
  await writeFile(path.join(shardPath(root, 0), 'outputs', `${foreign}.output.json`), '{}\n');
  await assert.rejects(() => verifyParallelAnnotation(root), /wrong-shard output files/);
}));

test('merge refuses a duplicated occurrence in a completed shard output', async () => withFixture(async ({root, plan}) => {
  await acceptAll(root);
  const batch = plan.batches[0];
  const file = path.join(shardPath(root, batch.shard_id), 'outputs', `${batch.batch_id}.output.json`);
  const output = await fileJson(file);
  output.blocks[0].tokens.push({...output.blocks[0].tokens[0]});
  await saveJson(file, output);
  await assert.rejects(() => mergeParallelAnnotation(root), /duplicate token annotation/);
}));
