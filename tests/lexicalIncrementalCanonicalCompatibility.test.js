const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { assertCanonicalPlanCompatibility } = require("../lib/lexical/incremental/canonicalCompatibility.ts");

const block = (item = "planned", id = "paragraph:p1") => ({
  sourceType: "rap", sourceItemId: item, contentBlockId: id,
  blockKind: "rap_paragraph", text: "Exact text.",
  anchors: [{ anchorId: "s1", anchorKind: "rap_sentence", startOffset: 0, endOffset: 11,
    expectedText: "Exact text.", metadata: { note: "中文", needsReview: 0 } }]
});

test("planned canonical blocks stay exact, independent new source items are deferred and inputs remain immutable", () => {
  const expected = [block(), block("other-planned")];
  const current = [block("new-item", "title"), block("other-planned"), block(), block("new-item"), block("second-new-item")];
  const before = JSON.stringify({ expected, current });
  assert.deepEqual(assertCanonicalPlanCompatibility(expected, current), {
    compatible: true, planned_blocks_verified: 2, deferred_new_item_blocks: 3,
    deferred_new_items: ['["rap","new-item"]', '["rap","second-new-item"]']
  });
  assert.equal(JSON.stringify({ expected, current }), before);
  assert.equal(assertCanonicalPlanCompatibility(expected, [...expected].reverse()).deferred_new_item_blocks, 0);
});

test("original identity, kind, exact text, and nested anchors cannot change even alongside independent additions", () => {
  const mutations = [
    b => { b.sourceType = "ctw"; },
    b => { b.sourceItemId = "replacement"; },
    b => { b.contentBlockId = "paragraph:replacement"; },
    b => { b.blockKind = "rap_title"; },
    b => { b.text += " "; },
    b => { b.anchors[0].anchorId = "different-sentence"; },
    b => { b.anchors[0].anchorKind = "canonical_question"; },
    b => { b.anchors[0].endOffset = 10; delete b.anchors[0].expectedText; },
    b => { b.anchors[0].metadata.needsReview = 1; },
    b => { b.anchors[0].metadata.note = "changed"; },
    b => { delete b.anchors; }
  ];
  for (const mutate of mutations) {
    const changed = block();
    mutate(changed);
    assert.throws(() => assertCanonicalPlanCompatibility([block()], [changed, block("independent")]),
      /Canonical source drifted|does not slice/);
  }
});

test("planned block deletion cannot be disguised by an equal number of new blocks", () => {
  assert.throws(() => assertCanonicalPlanCompatibility([block(), block("other")], [block(), block("new")]), /drifted/);
});

test("extra blocks within a planned source item are forbidden even with independent new items", () => {
  assert.throws(() => assertCanonicalPlanCompatibility([block()], [block(), block("planned", "paragraph:p2"), block("new")]),
    /extra block in planned source item/);
});

test("duplicate and conflicting identities in either complete set fail closed before filtering", () => {
  const conflicting = { ...block(), text: "Conflicting text." };
  for (const current of [[block(), block()], [block(), conflicting], [block(), block("new"), block("new")]]) {
    assert.throws(() => assertCanonicalPlanCompatibility([block()], current), /Duplicate canonical lexical block/);
  }
  assert.throws(() => assertCanonicalPlanCompatibility([block(), block()], [block()]), /Duplicate canonical lexical block/);
});

test("invalid independent additions are validated, not silently ignored", () => {
  const malformed = [
    { ...block("new"), text: "" },
    { ...block("new"), sourceItemId: "" },
    { ...block("new"), sourceType: "unknown" },
    { ...block("new"), anchors: [block("new").anchors[0], block("new").anchors[0]] }
  ];
  for (const extra of malformed) {
    assert.throws(() => assertCanonicalPlanCompatibility([block()], [block(), extra]), /Canonical lexical block/);
  }
});

test("anchor object key order is immaterial, but anchor sequence and values remain exact", () => {
  const original = block();
  original.anchors.push({ anchorId: "question", anchorKind: "canonical_question", metadata: { z: null, a: "" } });
  const same = structuredClone(original);
  same.anchors[0].metadata = { needsReview: 0, note: "中文" };
  assert.equal(assertCanonicalPlanCompatibility([original], [same]).compatible, true);
  same.anchors.reverse();
  assert.throws(() => assertCanonicalPlanCompatibility([original], [same]), /drifted/);
});

test("finalize and import share the plan-scoped gate without changing baseline or transaction safety", () => {
  const script = fs.readFileSync(path.join(__dirname, "../scripts/lexical-incremental.ts"), "utf8");
  assert.match(script, /return assertCanonicalPlanCompatibility\(expected, current\)/);
  assert.match(script, /await verifyLiveCanonical\(db, canonicalBlocks\)/);
  assert.match(script, /const canonicalPreflight = await verifyLiveCanonical\(db, await readCanonicalBlocksArtifact\(\)\)/);
  assert.match(script, /const preflight = preflightIncrementalImport\(dataset, baseline, await readFullProductionSnapshot\(db\)\)/);
  assert.match(script, /const liveHashes = fullSnapshotHashes\(liveSnapshot\)/);
});
