const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  acceptLexicalAgentBatch,
  LEXICAL_AGENT_BATCH_PLAN_V2,
  buildLexicalAgentWorkBatchSpecs,
  lexicalAgentBatchIdFromArgs,
  lexicalAgentCheckpointCounts,
  lexicalAgentPaths,
  loadLexicalAgentBatchPlan,
  loadLexicalAgentCorpus,
  prepareNextLexicalAgentBatch
} = require("../lib/lexical/agentProtocol.ts");
const { LEXICAL_AGENT_PROVENANCE, lexicalSemanticProvenanceMatches } = require("../lib/lexical/provenance.ts");
const { classifySemanticCacheForQuarantine } = require("../lib/lexical/quarantine.ts");

async function createCorpus(words = ["Alpha", "Beta", "Gamma", "Delta"]) {
  await mkdir(path.join(process.cwd(), "tmp"), { recursive: true });
  const root = await mkdtemp(path.join(process.cwd(), "tmp", "lexical-agent-test-"));
  const output = path.join(root, "tmp", "lexical-v1");
  await mkdir(output, { recursive: true });
  const blocks = words.map((word, index) => ({
    source_type: "ctw",
    source_item_id: `item-${index}`,
    content_block_id: "paragraph",
    block_kind: "ctw_paragraph",
    source_text_hash: `hash-${index}`,
    text: word,
    anchors: []
  }));
  const tokens = words.map((word, index) => ({
    candidateId: `ctw:item-${index}:paragraph:0:${word.length}`,
    sourceType: "ctw",
    sourceItemId: `item-${index}`,
    contentBlockId: "paragraph",
    blockKind: "ctw_paragraph",
    sourceTextHash: `hash-${index}`,
    surfaceText: word,
    normalizedSurface: word.toLowerCase(),
    startOffset: 0,
    endOffset: word.length,
    sourceAnchorId: null,
    sentenceId: null,
    excluded: false,
    exclusionReason: null,
    sourceReviewReason: null
  }));
  await writeFile(path.join(output, "canonical-blocks.jsonl"), `${blocks.map(JSON.stringify).join("\n")}\n`);
  await writeFile(path.join(output, "token-candidates.jsonl"), `${tokens.map(JSON.stringify).join("\n")}\n`);
  await writeFile(path.join(output, "generation-manifest.json"), "{}\n");
  return root;
}

async function writeAgentOutput(root, active, payload) {
  await writeFile(path.join(root, active.output_path), `${JSON.stringify({
    protocol_version: active.protocol_version,
    batch_id: active.batch_id,
    stage: active.stage,
    provenance: active.provenance,
    input_signature: active.input_signature,
    ...(active.batch_plan_version ? { batch_plan_version: active.batch_plan_version } : {}),
    ...payload
  }, null, 2)}\n`);
}

async function annotationPayload(root, active) {
  const input = JSON.parse(await readFile(path.join(root, active.input_path), "utf8"));
  return {
    blocks: input.blocks.map((block) => ({
      block_key: `${block.source_type}:${block.source_item_id}:${block.content_block_id}`,
      tokens: block.eligible_tokens.map((token) => ({
        candidate_id: token.candidate_id,
        context_pos: "noun",
        context_meaning_zh: "测试词",
        context_definition_en: "A term used in this test context.",
        canonical_expression: token.surface_text.toLowerCase(),
        lemma: token.surface_text.toLowerCase(),
        expression_type: "word",
        needs_review: false,
        review_notes: null
      }))
    }))
  };
}

test("semantic cache quarantine classifies DeepSeek, OpenRouter, and unknown provenance", () => {
  assert.equal(classifySemanticCacheForQuarantine("annotation", { model: "deepseek-flash" }).group, "deepseek-flash");
  assert.equal(classifySemanticCacheForQuarantine("annotation", {
    model: "openai/gpt-oss-20b",
    recovered_by_lexeme: true
  }).group, "openrouter-gpt-oss-20b");
  assert.equal(classifySemanticCacheForQuarantine("enrichment", {}).group, "unknown");
  assert.equal(classifySemanticCacheForQuarantine("annotation", {
    provenance: LEXICAL_AGENT_PROVENANCE
  }).group, null);
  assert.equal(classifySemanticCacheForQuarantine("annotation", {
    provenance: { ...LEXICAL_AGENT_PROVENANCE, model: "different-model" }
  }).group, "unknown");
});

test("agent accept CLI tolerates the package-runner argument separator", () => {
  assert.equal(lexicalAgentBatchIdFromArgs(["--", "annotation-batch-id"]), "annotation-batch-id");
  assert.equal(lexicalAgentBatchIdFromArgs(["annotation-batch-id"]), "annotation-batch-id");
  assert.equal(lexicalAgentBatchIdFromArgs(["--"]), null);
});

test("agent batch identity is deterministic and changes with semantic provenance", async () => {
  const root = await createCorpus();
  try {
    const works = await loadLexicalAgentCorpus(root);
    const first = buildLexicalAgentWorkBatchSpecs(works, "annotation");
    const second = buildLexicalAgentWorkBatchSpecs(works, "annotation");
    assert.deepEqual(first.map((value) => value.batchId), second.map((value) => value.batchId));
    const changed = buildLexicalAgentWorkBatchSpecs(works, "annotation", {
      ...LEXICAL_AGENT_PROVENANCE,
      model: "different-model"
    });
    assert.notEqual(first[0].batchId, changed[0].batchId);
    assert.equal(lexicalSemanticProvenanceMatches(LEXICAL_AGENT_PROVENANCE), true);
    assert.equal(lexicalSemanticProvenanceMatches({ ...LEXICAL_AGENT_PROVENANCE, model: "different-model" }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v2 plan preserves accepted prefix and deterministically repacks only complete pending blocks", async () => {
  const root = await createCorpus(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa"]);
  try {
    const works = await loadLexicalAgentCorpus(root);
    const legacy = buildLexicalAgentWorkBatchSpecs(works, "annotation");
    const plan = {
      version: LEXICAL_AGENT_BATCH_PLAN_V2,
      annotationAcceptedPrefixBatches: 1,
      acceptedAnnotationBatchIds: [legacy[0].batchId],
      maxTokens: 80,
      maxBlocks: 6
    };
    const first = buildLexicalAgentWorkBatchSpecs(works, "annotation", LEXICAL_AGENT_PROVENANCE, plan);
    const second = buildLexicalAgentWorkBatchSpecs(works, "annotation", LEXICAL_AGENT_PROVENANCE, plan);
    assert.equal(legacy.length, 4);
    assert.equal(first.length, 3);
    assert.equal(first[0].batchId, legacy[0].batchId);
    assert.equal(first[0].inputSignature, legacy[0].inputSignature);
    assert.notEqual(first[1].batchId, legacy[1].batchId);
    assert.equal(first[1].planVersion, LEXICAL_AGENT_BATCH_PLAN_V2);
    assert.equal(first[1].works.length, 6);
    assert.deepEqual(first.map((spec) => spec.batchId), second.map((spec) => spec.batchId));
    const acceptedCandidates = new Set(first[0].works.flatMap((work) => work.tokens.map((token) => token.candidateId)));
    const pendingCandidates = first.slice(1).flatMap((spec) =>
      spec.works.flatMap((work) => work.tokens.map((token) => token.candidateId))
    );
    assert.equal(new Set(pendingCandidates).size, pendingCandidates.length);
    assert.equal(pendingCandidates.some((candidateId) => acceptedCandidates.has(candidateId)), false);
    assert.equal(acceptedCandidates.size + pendingCandidates.length, works.length);
    for (const spec of first.slice(1)) {
      for (const work of spec.works) {
        assert.equal(work.block.text, wordsFromWork(work));
      }
    }
    const mwe = buildLexicalAgentWorkBatchSpecs(works, "mwe", LEXICAL_AGENT_PROVENANCE, plan);
    assert.deepEqual(
      mwe.map((spec) => spec.works.map((work) => work.block.contentBlockId)),
      first.map((spec) => spec.works.map((work) => work.block.contentBlockId))
    );
    const planPath = lexicalAgentPaths(root).batchPlan;
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, `${JSON.stringify({
      plan_version: LEXICAL_AGENT_BATCH_PLAN_V2,
      annotation_accepted_prefix_batches: 1,
      accepted_annotation_batch_ids: [legacy[0].batchId],
      max_tokens: 80,
      max_blocks: 6
    })}\n`);
    assert.deepEqual(await loadLexicalAgentBatchPlan(root), plan);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function wordsFromWork(work) {
  return work.tokens[0].surfaceText;
}

test("v2 interrupted resume keeps a legacy accepted checkpoint and requires plan identity on new output", async () => {
  const root = await createCorpus(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa"]);
  try {
    let active = await prepareNextLexicalAgentBatch(root);
    await writeAgentOutput(root, active, await annotationPayload(root, active));
    await acceptLexicalAgentBatch(active.batch_id, root);
    const paths = lexicalAgentPaths(root);
    await writeFile(paths.batchPlan, `${JSON.stringify({
      plan_version: LEXICAL_AGENT_BATCH_PLAN_V2,
      annotation_accepted_prefix_batches: 1,
      accepted_annotation_batch_ids: [active.batch_id],
      max_tokens: 80,
      max_blocks: 6
    })}\n`);
    assert.deepEqual((await lexicalAgentCheckpointCounts(root)).annotation, { completed: 1, total: 3, pending: 2 });
    active = await prepareNextLexicalAgentBatch(root);
    assert.equal(active.index, 1);
    assert.equal(active.batch_plan_version, LEXICAL_AGENT_BATCH_PLAN_V2);
    assert.equal(active.batch_id, buildLexicalAgentWorkBatchSpecs(
      await loadLexicalAgentCorpus(root), "annotation", LEXICAL_AGENT_PROVENANCE, await loadLexicalAgentBatchPlan(root)
    )[1].batchId);
    assert.equal(active.provenance.model, "gpt-6-sol");
    assert.equal(JSON.parse(await readFile(path.join(root, active.input_path), "utf8")).provenance.model, "gpt-6-sol");
    assert.equal((await prepareNextLexicalAgentBatch(root)).batch_id, active.batch_id);
    const payload = await annotationPayload(root, active);
    await writeFile(path.join(root, active.output_path), `${JSON.stringify({
      protocol_version: active.protocol_version,
      batch_id: active.batch_id,
      stage: active.stage,
      provenance: LEXICAL_AGENT_PROVENANCE,
      input_signature: active.input_signature,
      ...payload
    })}\n`);
    await assert.rejects(() => acceptLexicalAgentBatch(active.batch_id, root), /batch_plan_version mismatch/);
    await writeFile(path.join(root, active.output_path), `${JSON.stringify({
      protocol_version: active.protocol_version,
      batch_id: active.batch_id,
      stage: active.stage,
      provenance: LEXICAL_AGENT_PROVENANCE,
      input_signature: active.input_signature,
      batch_plan_version: active.batch_plan_version,
      ...payload
    })}\n`);
    await assert.rejects(() => acceptLexicalAgentBatch(active.batch_id, root), /provenance mismatch/);
    await writeAgentOutput(root, active, payload);
    await acceptLexicalAgentBatch(active.batch_id, root);
    assert.deepEqual((await lexicalAgentCheckpointCounts(root)).annotation, { completed: 2, total: 3, pending: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent protocol rejects wrong provenance, checkpoints successful batches, and resumes contiguous frontier", async () => {
  const root = await createCorpus();
  try {
    await writeFile(lexicalAgentPaths(root).manifest, `${JSON.stringify({
      completed_source_types: ["rdl", "rap"],
      remaining_work: ["stale-provider-work"]
    })}\n`);
    let active = await prepareNextLexicalAgentBatch(root);
    assert.equal(active.stage, "annotation");
    assert.equal(active.index, 0);
    let manifest = JSON.parse(await readFile(lexicalAgentPaths(root).manifest, "utf8"));
    assert.deepEqual(manifest.completed_source_types, []);
    assert.deepEqual(manifest.remaining_work, [
      "ctw",
      "mwe",
      "consolidation",
      "enrichment",
      "qa",
      "artifacts"
    ]);
    assert.deepEqual(manifest.prompt_schema_versions, {
      annotation: "lexical-agent-annotation-v1",
      mwe: "lexical-agent-mwe-v1",
      enrichment: "lexical-agent-enrichment-v1"
    });
    assert.equal(manifest.generation.annotation_batches_completed, 0);
    assert.equal(manifest.generation.annotation_batches_cached, 0);
    const payload = await annotationPayload(root, active);
    await writeFile(path.join(root, active.output_path), `${JSON.stringify({
      protocol_version: active.protocol_version,
      batch_id: active.batch_id,
      stage: active.stage,
      provenance: { ...LEXICAL_AGENT_PROVENANCE, model: "deepseek-flash" },
      input_signature: active.input_signature,
      ...payload
    })}\n`);
    await assert.rejects(() => acceptLexicalAgentBatch(active.batch_id, root), /provenance mismatch/);
    assert.equal((await prepareNextLexicalAgentBatch(root)).batch_id, active.batch_id);

    await writeAgentOutput(root, active, payload);
    await acceptLexicalAgentBatch(active.batch_id, root);
    manifest = JSON.parse(await readFile(lexicalAgentPaths(root).manifest, "utf8"));
    assert.equal(manifest.phase, "agent_annotation_checkpointed");
    assert.equal(manifest.current_batch_index, null);
    assert.deepEqual(manifest.agent_progress, {
      stage: "annotation",
      active_batch_id: null,
      completed_batches: 1,
      pending_batches: 1,
      next_batch_index: 1,
      source_type: "ctw"
    });
    active = await prepareNextLexicalAgentBatch(root);
    assert.equal(active.stage, "annotation");
    assert.equal(active.index, 1);
    await writeAgentOutput(root, active, await annotationPayload(root, active));
    await acceptLexicalAgentBatch(active.batch_id, root);
    assert.deepEqual((await lexicalAgentCheckpointCounts(root)).annotation, { completed: 2, total: 2, pending: 0 });

    for (let index = 0; index < 2; index += 1) {
      active = await prepareNextLexicalAgentBatch(root);
      assert.equal(active.stage, "mwe");
      const input = JSON.parse(await readFile(path.join(root, active.input_path), "utf8"));
      await writeAgentOutput(root, active, {
        blocks: input.blocks.map((block) => ({
          block_key: `${block.source_type}:${block.source_item_id}:${block.content_block_id}`,
          expressions: []
        }))
      });
      await acceptLexicalAgentBatch(active.batch_id, root);
    }
    assert.deepEqual((await lexicalAgentCheckpointCounts(root)).mwe, { completed: 2, total: 2, pending: 0 });

    active = await prepareNextLexicalAgentBatch(root);
    assert.equal(active.stage, "enrichment");
    const enrichmentInput = JSON.parse(await readFile(path.join(root, active.input_path), "utf8"));
    await writeAgentOutput(root, active, {
      entries: enrichmentInput.entries.map((entry) => ({
        entry_key: entry.entry_key,
        canonical_expression: entry.proposed_canonical_expression,
        lemma: entry.proposed_lemma,
        common_senses: [{ pos: "noun", definition_en: "A term used in the test corpus.", meaning_zh: "测试词" }],
        derived_words: [],
        useful_patterns: [],
        needs_review: false,
        review_notes: null
      }))
    });
    await acceptLexicalAgentBatch(active.batch_id, root);
    assert.equal(await prepareNextLexicalAgentBatch(root), null);
    manifest = JSON.parse(await readFile(lexicalAgentPaths(root).manifest, "utf8"));
    assert.equal(manifest.phase, "agent_finalize_ready");
    assert.equal(manifest.provenance.model, "gpt-6-sol");
    assert.deepEqual(manifest.completed_source_types, ["ctw"]);
    assert.deepEqual(manifest.remaining_work, ["qa", "artifacts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy generator fails before any external semantic provider fallback", () => {
  const result = spawnSync(process.execPath, [
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
    "--experimental-strip-types",
    "scripts/generate-lexical-v1.ts"
  ], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /External-provider lexical semantic generation is disabled/);
});
