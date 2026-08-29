const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RDL_MATERIAL_TYPE_INSTRUCTIONS,
  rdlMaterialInstruction,
  rdlMaterialTypeFromInstruction
} = require("../lib/reading/materialTypes.ts");
const { recoverMaterialTypes } = require("../scripts/backfill-rdl-material-types.ts");

test("RDL material types preserve official source instructions", () => {
  assert.equal(rdlMaterialInstruction("instructions"), "Read some instructions.");
  assert.equal(rdlMaterialInstruction("text_message_chain"), "Read a text-message chain.");
  assert.equal(rdlMaterialInstruction("social_media_post"), "Read a social media post.");
  assert.equal(rdlMaterialTypeFromInstruction(" Read an announcement. "), "announcement");
  assert.equal(rdlMaterialTypeFromInstruction("Read an invented item."), null);
  assert.equal(Object.keys(RDL_MATERIAL_TYPE_INSTRUCTIONS).length, 31);
});

test("material-index recovery uses only stable IDs and authoritative occurrence instructions", () => {
  const rows = recoverMaterialTypes({
    materials: [
      { asset_id: "RDL-002", occurrences: [{ rdl_type: "Read some instructions." }] },
      {
        asset_id: "RDL-003",
        occurrences: [
          { rdl_type: "Read a text-message chain." },
          { rdl_type: "Read a text-message chain." }
        ]
      },
      { asset_id: "RDL-037", occurrences: [{ rdl_type: "Read a social media post." }] }
    ]
  });
  assert.deepEqual(rows, [
    { materialId: "RDL-002", materialType: "instructions" },
    { materialId: "RDL-003", materialType: "text_message_chain" },
    { materialId: "RDL-037", materialType: "social_media_post" }
  ]);
  assert.throws(() => recoverMaterialTypes({
    materials: [{
      asset_id: "RDL-003",
      occurrences: [
        { rdl_type: "Read a text-message chain." },
        { rdl_type: "Read a notice." }
      ]
    }]
  }), /conflicting rdl_type/);
});
