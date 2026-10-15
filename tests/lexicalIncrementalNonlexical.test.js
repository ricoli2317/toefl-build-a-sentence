const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { canonicalSourceTextHash } = require('../lib/lexical/hash.ts');
const { hyphenatedCompounds } = require('../lib/lexical/hyphenated.ts');
const { tokenizeCanonicalBlocks } = require('../lib/lexical/tokenize.ts');
const { writeJsonAtomic, writeJsonlAtomic, sha256File } = require('../lib/lexical/incremental/artifacts.ts');
const { incrementalFile } = require('../lib/lexical/incremental/paths.ts');
const { incrementalAgentProvenance } = require('../lib/lexical/incremental/envelope.ts');
const { validateIncrementalNonlexicalReviews, incrementalHyphenatedCoverage, assertIncrementalHyphenatedCoverage,
  loadIncrementalNonlexicalReviews, NONLEXICAL_REVIEW_FILE } = require('../lib/lexical/incremental/nonlexicalReview.ts');
const { buildAnnotationStage, validateAnnotationStageOutput } = require('../lib/lexical/incremental/annotationStage.ts');
const { buildMweStage, validateMweStageOutput } = require('../lib/lexical/incremental/mweStage.ts');
const { buildMweQaStage, validateMweQaStageOutput } = require('../lib/lexical/incremental/mweQaStage.ts');
const { nextStageBatch, acceptStageBatch, readStageInput, loadStage } = require('../lib/lexical/incremental/stageRunner.ts');

const block = { sourceType: 'rdl', sourceItemId: 'fixture-item', contentBlockId: 'material:fixture', blockKind: 'rdl_material',
  text: 'Subject: update-student conference uses eco-friendly rooms.' };
const raw = hyphenatedCompounds(block);
const review = { ...raw[0], source_text_hash: canonicalSourceTextHash(block.text), decision: 'not_lexical_compound', reason: 'Subject delimiter, not a compound.' };

test('exact adjudication excludes only the reviewed punctuation span; genuine and repeated compounds remain mandatory', () => {
  const result = incrementalHyphenatedCoverage([block], [raw[1]], [review]);
  assert.equal(result.raw_total, 2);
  assert.equal(result.reviewed_nonlexical, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(result.missing, []);
  assert.throws(() => assertIncrementalHyphenatedCoverage([block], [], [review]), /Missing complete/);
  assert.throws(() => assertIncrementalHyphenatedCoverage([block], raw, [review]), /must not be published/);
  const repeated = { ...block, contentBlockId: 'other', text: block.text + ' More eco-friendly rooms.' };
  assert.equal(incrementalHyphenatedCoverage([repeated], [], []).missing.length, 3);
  assert.equal(incrementalHyphenatedCoverage([block], [], []).missing.length, 2);
});

test('duplicate, stale, unknown, changed-identity and extra-field adjudications fail closed', () => {
  for (const reviews of [[review, review], [{ ...review, source_text_hash: '0'.repeat(64) }], [{ ...review, context_text: block.text + 'x' }],
    [{ ...review, start_offset: 10 }], [{ ...review, content_block_id: 'other' }], [{ ...review, surface_text: 'student' }],
    [{ ...review, decision: 'skip' }], [{ ...review, reason: '' }], [{ ...review, bypass: true }]]) {
    assert.throws(() => validateIncrementalNonlexicalReviews([block], reviews), /Invalid, duplicate, or stale/);
  }
});

test('hash-bound review crosses Annotation → MWE → QA without changing tokens; removal/tampering is rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lexical-nonlexical-fixture-'));
  const previous = process.env.LEXICAL_INCREMENTAL_RUN;
  process.env.LEXICAL_INCREMENTAL_RUN = 'fixture';
  try {
    const file = name => incrementalFile(root, name);
    await writeJsonAtomic(file('delta-plan.json'), { new_blocks: [review], changed_blocks: [] });
    await writeJsonlAtomic(file('canonical-blocks.jsonl'), [{ source_type: block.sourceType, source_item_id: block.sourceItemId,
      content_block_id: block.contentBlockId, block_kind: block.blockKind, text: block.text }]);
    await writeJsonAtomic(file('independent-nonlexical-review.json'), { ...review, verdict: 'not_lexical_compound', rationale: review.reason, provenance: incrementalAgentProvenance() });
    const artifact = { version: 'lexical-incremental-nonlexical-review-v1', delta_plan_sha256: await sha256File(file('delta-plan.json')),
      canonical_blocks_sha256: await sha256File(file('canonical-blocks.jsonl')), independent_review_sha256: await sha256File(file('independent-nonlexical-review.json')),
      provenance: incrementalAgentProvenance(), reviews: [review] };
    await writeJsonAtomic(file(NONLEXICAL_REVIEW_FILE), artifact);
    const works = tokenizeCanonicalBlocks([block]);
    const planSha = await sha256File(file('delta-plan.json'));
    await buildAnnotationStage(root, works, planSha);
    const claim = await nextStageBatch(root, 'annotation', 'fixture-owner');
    const input = await readStageInput(root, 'annotation', claim.batch_id);
    const envelope = value => Object.fromEntries(['protocol_version', 'stage', 'batch_id', 'generation_version', 'provenance', 'input_signature', 'schema_version'].map(key => [key, value[key]]));
    await writeJsonAtomic(claim.output_path, { ...envelope(input), blocks: [{ block_key: `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`,
      tokens: input.blocks[0].eligible_tokens.map(token => ({ candidate_id: token.candidate_id, context_pos: 'noun', context_meaning_zh: '测试含义',
        context_definition_en: 'A test fixture concept in the sentence.', canonical_expression: token.surface_text.toLowerCase(), lemma: token.surface_text.toLowerCase(),
        expression_type: 'word', needs_review: false, review_notes: null })), expressions: [] }] });
    await acceptStageBatch(root, 'annotation', claim.batch_id, 'fixture-owner', (output, batch) => validateAnnotationStageOutput(root, claim.batch_id, batch, output));
    await buildMweStage(root, planSha);
    const mwe = await nextStageBatch(root, 'mwe', 'fixture-owner');
    const mweInput = await readStageInput(root, 'mwe', mwe.batch_id);
    assert.deepEqual(mweInput.blocks[0].required_hyphenated_compounds.map(span => span.surface_text), ['eco-friendly']);
    assert.equal(mweInput.blocks[0].reviewed_nonlexical_spans.length, 1);
    const expression = { start_offset: raw[1].start_offset, end_offset: raw[1].end_offset, surface_text: 'eco-friendly', context_pos: 'adjective',
      context_meaning_zh: '环保的', context_definition_en: 'Not harmful to the environment.', canonical_expression: 'eco-friendly', lemma: 'eco-friendly',
      expression_type: 'phrase', learning_value: 'fixed_expression', needs_review: false, review_notes: null };
    const fakeNonlexical = { ...expression, start_offset: raw[0].start_offset, end_offset: raw[0].end_offset, surface_text: raw[0].surface_text,
      canonical_expression: raw[0].surface_text, lemma: raw[0].surface_text };
    const mwePlan = (await loadStage(root, 'mwe')).plan;
    await assert.rejects(validateMweStageOutput(root, mwe.batch_id, mwePlan.batches[0], { ...envelope(mweInput),
      blocks: [{ block_key: `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`, expressions: [expression, fakeNonlexical] }] }), /must not be published/);
    await writeJsonAtomic(mwe.output_path, { ...envelope(mweInput), blocks: [{ block_key: `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`, expressions: [expression] }] });
    await acceptStageBatch(root, 'mwe', mwe.batch_id, 'fixture-owner', (output, batch) => validateMweStageOutput(root, mwe.batch_id, batch, output));
    await buildMweQaStage(root, planSha);
    const qa = await nextStageBatch(root, 'mwe-qa', 'fixture-owner');
    const qaInput = await readStageInput(root, 'mwe-qa', qa.batch_id);
    const qaPlan = (await loadStage(root, 'mwe-qa')).plan;
    await assert.rejects(validateMweQaStageOutput(root, qa.batch_id, qaPlan.batches[0], { ...envelope(qaInput),
      records: qaInput.expressions.map(value => ({ expression_identity: value.expression_identity, verdict: 'ISSUE', issue_types: ['over_collected'],
        concise_reason: 'Fixture attempts to remove genuine compound.', recommended_action: 'remove' })) }), /Missing complete/);
    await writeJsonAtomic(qa.output_path, { ...envelope(qaInput), records: qaInput.expressions.map(value => ({ expression_identity: value.expression_identity, verdict: 'PASS' })) });
    await acceptStageBatch(root, 'mwe-qa', qa.batch_id, 'fixture-owner', (output, batch) => validateMweQaStageOutput(root, qa.batch_id, batch, output));
    await fs.unlink(file(NONLEXICAL_REVIEW_FILE));
    await assert.rejects(loadStage(root, 'mwe'), /nonlexical review changed/);
    await writeJsonAtomic(file(NONLEXICAL_REVIEW_FILE), { ...artifact, reviews: [{ ...review, reason: 'Changed after stage freeze.' }] });
    await assert.rejects(loadStage(root, 'mwe-qa'), /nonlexical review changed/);
    await writeJsonAtomic(file(NONLEXICAL_REVIEW_FILE), artifact);
    await loadStage(root, 'mwe-qa');
    await writeJsonAtomic(file('delta-plan.json'), { new_blocks: [], changed_blocks: [] });
    await assert.rejects(loadIncrementalNonlexicalReviews(root), /binding\/provenance mismatch/);
    await writeJsonAtomic(file('delta-plan.json'), { new_blocks: [review], changed_blocks: [] });
    await writeJsonAtomic(file(NONLEXICAL_REVIEW_FILE), { ...artifact, reviews: [{ ...review, source_text_hash: '0'.repeat(64) }] });
    await assert.rejects(loadIncrementalNonlexicalReviews(root), /Invalid, duplicate, or stale/);
    await writeJsonAtomic(file(NONLEXICAL_REVIEW_FILE), artifact);
    await writeJsonAtomic(file('independent-nonlexical-review.json'), { verdict: 'lexical_compound' });
    await assert.rejects(loadIncrementalNonlexicalReviews(root), /binding\/provenance mismatch/);
  } finally {
    if (previous === undefined) delete process.env.LEXICAL_INCREMENTAL_RUN; else process.env.LEXICAL_INCREMENTAL_RUN = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('finalize and import bind the adjudication artifacts and independently recompute reviewed coverage', async () => {
  const source = await fs.readFile(path.join(__dirname, '../scripts/lexical-incremental.ts'), 'utf8');
  assert.match(source, /nonlexicalReviews: nonlexical\.reviews/);
  assert.match(source, /artifactNames\.push\(NONLEXICAL_REVIEW_FILE, "independent-nonlexical-review.json"\)/);
  assert.match(source, /requiredArtifacts\.push\(NONLEXICAL_REVIEW_FILE, "independent-nonlexical-review.json"\)/);
  assert.match(source, /manifest\.nonlexical_review_sha256/);
  assert.match(source, /assertIncrementalHyphenatedCoverage\(plannedBlocks/);
});
