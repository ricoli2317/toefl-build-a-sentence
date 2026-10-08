const assert = require("node:assert/strict");
const test = require("node:test");

const { canonicalSourceTextHash } = require("../lib/lexical/hash.ts");
const { lexicalEntryKey } = require("../lib/lexical/generationTypes.ts");
const { enumerateCtwBlocks } = require("../lib/lexical/enumerators/ctw.server.ts");
const { enumerateRapBlocks } = require("../lib/lexical/enumerators/rap.server.ts");
const { buildDeltaPlan, assertRapTitleCoverage } = require("../lib/lexical/incremental/deltaPlan.ts");
const { consolidateIncrementalDelta, deriveIncrementalOccurrence, occurrenceIdentityOf } = require("../lib/lexical/incremental/consolidation.ts");
const { assembleDeltaArtifacts } = require("../lib/lexical/incremental/assemble.ts");
const { productionId } = require("../lib/lexical/production.ts");
const { readFullProductionSnapshot, sortBlocks, sortEntries, sortOccurrences } = require("../lib/lexical/incremental/productionBaseline.server.ts");
const { fullSnapshotHashes } = require("../lib/lexical/incremental/importBaseline.ts");

function canonical(sourceType, sourceItemId, contentBlockId, blockKind, text) {
  return { sourceType, sourceItemId, contentBlockId, blockKind, text };
}

function productionBlock(block, text) {
  return {
    block_id: productionId("block", JSON.stringify([block.sourceType, block.sourceItemId, block.contentBlockId])),
    source_type: block.sourceType,
    source_item_id: block.sourceItemId,
    content_block_id: block.contentBlockId,
    block_kind: block.blockKind,
    source_text_hash: canonicalSourceTextHash(text),
    generation_status: "generated",
    generation_version: "lexical-v1",
    last_error: null
  };
}

function occurrence({ sourceType = "ctw", sourceItemId = "item", contentBlockId = "paragraph:p", start = 0, end = 5, surface = "alpha",
  canonicalExpression = "alpha", lemma = "alpha", expressionType = "word", layer = 1, canonicalBlockText = "alpha beta gamma" } = {}) {
  const normalized = canonicalExpression.toLowerCase();
  return {
    entry_key: lexicalEntryKey(normalized, expressionType),
    source_type: sourceType,
    source_item_id: sourceItemId,
    content_block_id: contentBlockId,
    sentence_id: null,
    source_anchor_id: null,
    surface_text: surface,
    normalized_surface: surface.toLowerCase(),
    start_offset: start,
    end_offset: end,
    context_pos: "noun",
    context_meaning_zh: "阿尔法",
    context_definition_en: `The alpha meaning for ${surface}.`,
    context_text: canonicalBlockText,
    review_status: "generated",
    generation_version: "lexical-v1",
    review_notes: null,
    layer,
    expression_type: expressionType,
    canonical_expression: canonicalExpression,
    normalized_expression: normalized,
    lemma
  };
}

function productionEntry(entryKey, canonicalExpression, expressionType, lemma, identityVariant = "") {
  const normalized = canonicalExpression.toLowerCase();
  return {
    entry_id: productionId("entry", entryKey),
    canonical_expression: canonicalExpression,
    normalized_expression: normalized,
    expression_type: expressionType,
    lemma,
    common_senses: [],
    derived_words: [],
    useful_patterns: [],
    review_status: "generated",
    generation_version: "lexical-v1",
    review_notes: null,
    identity_variant: identityVariant
  };
}

function keysetDb(tables, requests, error = null) {
  return { from(table) {
    const request = { table, cursor: null };
    const query = {
      select(columns) { request.columns = columns; return query; },
      order(column, options) { request.order = column; assert.equal(options.ascending, true); return query; },
      limit(size) { request.limit = size; return query; },
      gt(column, value) { assert.equal(column, request.order); request.cursor = value; return query; },
      then(resolve, reject) {
        requests.push({ ...request });
        const rows = (tables[table] ?? []).filter(row => request.cursor === null || row[request.order] > request.cursor).slice(0, request.limit);
        return Promise.resolve({ data: rows, error }).then(resolve, reject);
      }
    };
    return query;
  } };
}

test("full baseline keyset pages read every row without OFFSET and preserve exact hash ordering and fields", async () => {
  const tables = { lexical_source_blocks: [], lexical_entries: [], lexical_occurrences: [] };
  for (let i = 0; i < 2105; i++) {
    const id = String(i).padStart(8, '0');
    const item = `item-${String(2105 - i).padStart(8, '0')}`;
    tables.lexical_source_blocks.push({ ...productionBlock(canonical('ctw', item, 'paragraph:p', 'ctw_paragraph', 'alpha'), 'alpha'), block_id: id });
    tables.lexical_entries.push({ ...productionEntry(item, item, 'word', item), entry_id: id, extra_json: { preserved: ['中文😀', null, ''] } });
    tables.lexical_occurrences.push({ ...occurrence({ sourceItemId: item }), occurrence_id: id, entry_id: id, context_text: 'alpha\n中文😀', created_at: '2026-10-08T00:00:00.123456+00:00' });
  }
  const expected = { blocks: sortBlocks(tables.lexical_source_blocks), entries: sortEntries(tables.lexical_entries), occurrences: sortOccurrences(tables.lexical_occurrences) };
  const requests = [];
  const actual = await readFullProductionSnapshot(keysetDb(tables, requests));
  assert.deepEqual(actual, expected);
  assert.deepEqual(fullSnapshotHashes(actual), fullSnapshotHashes(expected));
  assert.equal(requests.length, 9);
  for (const table of Object.keys(tables)) {
    const pages = requests.filter(request => request.table === table);
    assert.deepEqual(pages.map(page => page.cursor), [null, '00000999', '00001999']);
    assert.ok(pages.every(page => page.columns === '*' && page.limit === 1000));
  }
});

test("full baseline pagination rejects malformed, duplicate and backwards primary-key pages and read errors", async () => {
  for (const page of [[{}], [{ block_id: 'same' }, { block_id: 'same' }], [{ block_id: 'z' }, { block_id: 'a' }]]) {
    await assert.rejects(readFullProductionSnapshot(keysetDb({ lexical_source_blocks: page }, [])), /non-advancing/);
  }
  await assert.rejects(readFullProductionSnapshot(keysetDb({}, [], { message: 'statement timeout' })), /Failed to read lexical_source_blocks: statement timeout/);
});

test("delta plan classifies new / same / changed / removed block identities", () => {
  const blocks = [
    canonical("ctw", "item-a", "paragraph:p1", "ctw_paragraph", "Same text."),
    canonical("ctw", "item-a", "paragraph:p2", "ctw_paragraph", "New current text."),
    canonical("ctw", "item-b", "paragraph:p1", "ctw_paragraph", "Fresh block.")
  ];
  const existing = [
    productionBlock(blocks[0], "Same text."),
    productionBlock(blocks[1], "Old historical text."),
    productionBlock(canonical("ctw", "item-c", "paragraph:p9", "ctw_paragraph", "Removed text."), "Removed text.")
  ];
  const plan = buildDeltaPlan({ canonicalBlocks: blocks, productionBlocks: existing, productionBaseline: { counts: {} } });
  assert.equal(plan.unchanged_blocks.length, 1);
  assert.equal(plan.unchanged_blocks[0].content_block_id, "paragraph:p1");
  assert.deepEqual(plan.new_blocks.map((block) => [block.content_block_id, block.reason]), [["paragraph:p1", "missing_in_production"]]);
  assert.equal(plan.new_blocks[0].source_item_id, "item-b");
  assert.deepEqual(plan.changed_blocks.map((block) => [block.content_block_id, block.reason, Boolean(block.old_hash)]), [["paragraph:p2", "source_text_hash_changed", true]]);
  assert.deepEqual(plan.removed_blocks.map((block) => [block.source_item_id, block.reason, block.new_hash]), [["item-c", "missing_in_canonical", null]]);
  assert.deepEqual(plan.delta_items.new, ["ctw:item-b"]);
  assert.deepEqual(plan.delta_items.changed, ["ctw:item-a"]);
  assert.deepEqual(plan.delta_items.removed, ["ctw:item-c"]);
  assert.deepEqual(plan.per_source_counts.ctw.delta, { new: 1, changed: 1, removed: 1, unchanged: 1 });
  assert.equal(plan.canonical_current.total_blocks, 3);
});

test("RAP title coverage is a hard canonical contract and enumerates one stable block per passage", () => {
  const rap = enumerateRapBlocks({
    sourceItemId: "rap-item",
    passageId: "passage-1",
    passageTitle: "Canonical Title",
    paragraphs: [{ paragraphId: "p1", paragraphOrder: 1, paragraphText: "Sentence one.", sentences: [{ sentenceId: "s1", sentenceOrder: 1, sentenceText: "Sentence one." }] }],
    questions: []
  });
  assert.deepEqual(rap.map((block) => block.contentBlockId), ["passage:passage-1:title", "passage:passage-1:paragraph:p1"]);
  assert.equal(rap[0].blockKind, "rap_title");
  assertRapTitleCoverage(rap);
  assert.throws(() => assertRapTitleCoverage([rap[1]]), /exactly one rap_title block/);
  assert.throws(() => assertRapTitleCoverage([rap[0], rap[0]]), /Duplicate canonical block|exactly one rap_title block/);
});

test("CTW canonical corpus is paragraphs only: no instruction or stem block is ever enumerated", () => {
  const blocks = enumerateCtwBlocks({
    sourceItemId: "ctw-item",
    paragraphs: [{ paragraphId: "p1", paragraphOrder: 1 }],
    segments: [{ paragraphId: "p1", segmentOrder: 1, segmentType: "text", textContent: "Fixed instruction stays UI-only. Missing ", slotId: null },
      { paragraphId: "p1", segmentOrder: 2, segmentType: "blank", textContent: null, slotId: "slot-1" }],
    slots: [{ slotId: "slot-1", paragraphId: "p1", answer: "word" }]
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].contentBlockId, "paragraph:p1");
  assert.ok(blocks.every((block) => block.blockKind === "ctw_paragraph"));
  assert.ok(blocks.every((block) => !/stem|instruction/.test(block.contentBlockId)));
});

test("consolidation reuses an existing production entry instead of recreating it", () => {
  const entryKey = lexicalEntryKey("alpha", "word");
  const production = [productionEntry(entryKey, "Alpha", "word", "alpha")];
  const delta = occurrence({ canonicalExpression: "Alpha", lemma: "alpha" });
  const result = consolidateIncrementalDelta({ occurrences: [delta], productionEntries: production });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.newEntries.length, 0);
  assert.deepEqual(result.reusedEntries, [{ entry_key: entryKey, entry_id: production[0].entry_id }]);
  assert.equal(result.assignments.get(occurrenceIdentityOf(delta)).entry_id, production[0].entry_id);
  assert.equal(result.assignments.get(occurrenceIdentityOf(delta)).reused, true);
});

test("consolidation creates a deterministic new entry only when production lacks the identity", () => {
  const delta = occurrence({ canonicalExpression: "Beta", lemma: "beta" });
  const result = consolidateIncrementalDelta({ occurrences: [delta], productionEntries: [] });
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.newEntries.length, 1);
  assert.equal(result.newEntries[0].entry_id, productionId("entry", lexicalEntryKey("beta", "word")));
  assert.equal(result.assignments.get(occurrenceIdentityOf(delta)).reused, false);
});

test("consolidation withholds canonical/lemma conflicts and homograph collisions instead of guessing", () => {
  const conflicted = [
    occurrence({ canonicalExpression: "Gamma", lemma: "gamma" }),
    occurrence({ canonicalExpression: "gamma", lemma: "gamma", start: 6, end: 12, surface: "gamma" })
  ];
  const conflictResult = consolidateIncrementalDelta({ occurrences: conflicted, productionEntries: [] });
  assert.equal(conflictResult.conflicts.length, 1);
  assert.deepEqual(conflictResult.conflicts[0].reasons, ["incompatible_canonicalization"]);
  assert.equal(conflictResult.newEntries.length, 0);

  const production = [productionEntry(
    `${lexicalEntryKey("delta", "word")}\u0000review-target:delta-2`, "Delta", "word", "delta", "delta-2")];
  const homograph = consolidateIncrementalDelta({
    occurrences: [occurrence({ canonicalExpression: "Delta", lemma: "delta" })],
    productionEntries: production
  });
  assert.equal(homograph.conflicts.length, 1);
  assert.deepEqual(homograph.conflicts[0].reasons, ["homograph_identity_requires_review"]);
  assert.equal(homograph.newEntries.length, 0);
});

test("production entry convention mismatches are unresolved conflicts, never silent overwrites", () => {
  const entryKey = lexicalEntryKey("alpha", "word");
  const production = [productionEntry(entryKey, "Alpha", "word", "alpha")];
  const result = consolidateIncrementalDelta({
    occurrences: [occurrence({ canonicalExpression: "ALPHA", lemma: "alpha" })],
    productionEntries: production
  });
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].reasons, ["production_entry_convention_mismatch"]);
});

test("full homograph identity requires explicit review and reuses the exact production variant", () => {
  const key=lexicalEntryKey('delta','word');
  const base=productionEntry(key,'Delta','word','delta');
  const variant=productionEntry(key+'\u0000variant','Delta','word','delta','other-sense');
  const delta=occurrence({canonicalExpression:'Delta',lemma:'delta'});
  const unresolved=consolidateIncrementalDelta({occurrences:[delta],productionEntries:[base,variant]});
  assert.equal(unresolved.conflicts.length,1);
  const decisions=new Map([[occurrenceIdentityOf(delta),'other-sense']]);
  const result=consolidateIncrementalDelta({occurrences:[delta],productionEntries:[base,variant],identityVariantAssignments:decisions});
  assert.equal(result.conflicts.length,0);
  assert.equal(result.newEntries.length,0);
  assert.equal(result.assignments.get(occurrenceIdentityOf(delta)).entry_id,variant.entry_id);
  decisions.set(occurrenceIdentityOf(delta),'');
  const baseResult=consolidateIncrementalDelta({occurrences:[delta],productionEntries:[base,variant],identityVariantAssignments:decisions});
  assert.equal(baseResult.assignments.get(occurrenceIdentityOf(delta)).entry_id,base.entry_id);
});

test("assemble artifacts never carry unchanged identities and count changed/removed replacements exactly", () => {
  const sameBlock = canonical("ctw", "item-a", "paragraph:p1", "ctw_paragraph", "Same text.");
  const changedBlock = canonical("ctw", "item-a", "paragraph:p2", "ctw_paragraph", "New text.");
  const newBlock = canonical("ctw", "item-b", "paragraph:p1", "ctw_paragraph", "Fresh text.");
  const removedBlock = canonical("ctw", "item-c", "paragraph:p9", "ctw_paragraph", "Gone text.");
  const plan = buildDeltaPlan({
    canonicalBlocks: [sameBlock, changedBlock, newBlock],
    productionBlocks: [
      productionBlock(sameBlock, sameBlock.text),
      productionBlock(changedBlock, "Old text."),
      productionBlock(removedBlock, removedBlock.text)
    ],
    productionBaseline: { counts: { entries: 1, blocks: 3, occurrences: 3 } }
  });
  const deltaOccurrence = occurrence({
    sourceItemId: "item-b", contentBlockId: "paragraph:p1", start: 0, end: 5, surface: "Fresh", canonicalExpression: "fresh", canonicalBlockText: "Fresh text."
  });
  const consolidation = consolidateIncrementalDelta({ occurrences: [deltaOccurrence], productionEntries: [] });
  const liveOccurrences = [{
    occurrence_id: productionId("occurrence", "ctw:item-a:paragraph:p2:0:3"),
    entry_id: "entry-x", source_type: "ctw", source_item_id: "item-a", content_block_id: "paragraph:p2",
    sentence_id: null, source_anchor_id: null, surface_text: "Old", normalized_surface: "old", start_offset: 0, end_offset: 3,
    context_pos: "noun", context_meaning_zh: "旧", context_definition_en: "Old.", review_status: "generated",
    generation_version: "lexical-v1", review_notes: null
  }];
  const assembled = assembleDeltaArtifacts({
    plan, consolidation, baselineCounts: { entries: 1, blocks: 3, occurrences: 3 },
    unrelated: { blocks_sha256: "b".repeat(32), occurrences_sha256: "o".repeat(32) },
    entriesUnrelatedSha256: "e".repeat(32), liveOccurrences
  });
  const artifactKeys = assembled.blockRows.map((row) => `${row.source_type}:${row.source_item_id}:${row.content_block_id}`);
  assert.ok(!artifactKeys.includes("ctw:item-a:paragraph:p1"), "unchanged block must never enter the artifacts");
  assert.ok(artifactKeys.includes("ctw:item-a:paragraph:p2"));
  assert.ok(artifactKeys.includes("ctw:item-b:paragraph:p1"));
  assert.equal(assembled.deltaRows.filter((row) => row.action === "removed").length, 1);
  // 3 existing occurrences - 1 replaced + 1 delta occurrence
  assert.equal(assembled.meta.final_occurrences_count, String(3 + 1 - 1));
  assert.equal(assembled.meta.final_blocks_count, String(3 + 1 - 1));
  assert.equal(assembled.meta.final_entries_count, String(1 + 1));
  assert.equal(assembled.mappingRows.length, 1);
  assert.equal(assembled.mappingRows[0].reused_production_entry, false);
});

test("layer-2 derivation recomputes stale canonical keys while layer-1 identities stay their own derivation", () => {
  const base = occurrence({ layer: 2, canonicalExpression: "Rotating", lemma: "rotate", expressionType: "phrase", surface: "rotating" });
  const derived = deriveIncrementalOccurrence({ ...base, entry_key: "stale\u0000phrase", normalized_expression: "stale" });
  assert.equal(derived.entry_key, lexicalEntryKey("rotating", "phrase"));
  assert.throws(() => deriveIncrementalOccurrence({ ...occurrence(), entry_key: "tampered\u0000word" }), /Layer-1 occurrence identity/);
});
