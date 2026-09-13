const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRdlImportGroupDecision } = require("../lib/reading/rdlImportDecision.ts");

function prepared(existingItem = null) {
  return {
    packageData: {
      item: { module: "rdl" },
      materials: [{ materialId: "RDL-087" }],
      occurrences: [{
        sourceLabel: "7.1A",
        sourceModule: "m1",
        sourceOrder: 3,
        sourceQuestionStart: 21,
        sourceQuestionEnd: 22
      }]
    },
    existingItem,
    materialMatchKind: "exact_material",
    possibleDuplicateLogicalItemIds: []
  };
}

test("registered material without a historical logical item is explained as a first question set", () => {
  assert.deepEqual(buildRdlImportGroupDecision(prepared()), {
    sourceLabel: "7.1A",
    sourceModule: "m1",
    sourceOrder: 3,
    sourceQuestionStart: 21,
    sourceQuestionEnd: 22,
    materialId: "RDL-087",
    materialMatchKind: "exact_material",
    matchedMaterialId: "RDL-087",
    materialAction: "reuse_existing",
    logicalItemAction: "create_new",
    matchedLogicalItemId: null,
    reasonCode: "registered_material_first_question_set",
    reason: "素材已在 reading_materials 注册，但尚无历史 RDL logical item 使用该 material_id；本次首次创建题组。"
  });
});

test("registered material with a historical logical item reports reuse for both layers", () => {
  const decision = buildRdlImportGroupDecision(prepared({ logicalItemId: "reading-rdl-existing" }));
  assert.equal(decision.materialAction, "reuse_existing");
  assert.equal(decision.logicalItemAction, "reuse_existing");
  assert.equal(decision.matchedLogicalItemId, "reading-rdl-existing");
  assert.equal(decision.reasonCode, "reuse_existing_logical_item");
});
