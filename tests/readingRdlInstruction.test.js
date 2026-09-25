const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv } = require("../lib/reading/csvAdapter.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  buildReadingImportRows,
  prepareReadingPackageAtomicImport
} = require("../lib/reading/importer.ts");
const { validateReadingImportPackage } = require("../lib/reading/validation.ts");
const { attachIncomingOccurrencesToHistoricalPackage } = require("../lib/reading/historicalDedup.ts");
const { toStudentReadingPracticePayload } = require("../lib/reading/studentPractice.ts");
const {
  LEGACY_READ_IN_DAILY_LIFE_HEADERS,
  READ_IN_DAILY_LIFE_HEADERS
} = require("../lib/reading/csvSchemas.ts");
const {
  rdlDisplayInstruction,
  rdlMaterialInstruction
} = require("../lib/reading/materialTypes.ts");
const { detectQuestionType } = require("../lib/questionCsvSchemas.ts");

const projectRoot = path.join(__dirname, "..");
const templateDir = path.join(projectRoot, "data/reading/csv-templates");
const sql = fs.readFileSync(path.join(projectRoot, "supabase/reading_csv_import.sql"), "utf8");
const instructionMigration = fs.readFileSync(
  path.join(projectRoot, "supabase/reading_material_instruction.sql"),
  "utf8"
);

const baseMaterial = {
  materialId: "RDL-200",
  title: "Campus Event Program",
  materialType: "event_program",
  source: "fixture",
  sourceDate: "2026-01-01",
  yearMonth: "2026-01",
  bindingStatus: "bound",
  imageAssetPath: "reading/rdl/RDL-200/material_final.png",
  hitboxDataPath: "reading/rdl/RDL-200/selection_map.json"
};

function templateDocument() {
  return parseCsvDocument(
    fs.readFileSync(path.join(templateDir, "TOEFL_Read_in_Daily_Life_TEMPLATE.csv"), "utf8"),
    { trimValues: false }
  );
}

function rdlRows({ instruction = "Read an event program.", materialId = "RDL-200", materialType = "event_program" } = {}) {
  const document = templateDocument();
  for (const row of document.rows) {
    row.material_id = materialId;
    row.material_type = materialType;
    row.title = "Campus Event Program";
    if (instruction === null) delete row.instruction;
    else row.instruction = instruction;
  }
  return document.rows;
}

function rdlMaterial(overrides = {}) {
  return { ...baseMaterial, title: "Campus Event Program", ...overrides };
}

function adapt(rows, overrides = {}) {
  const material = overrides.material ?? rdlMaterial();
  return adaptReadingCsv({
    type: "read_in_daily_life",
    rows,
    sourceFile: "event-program.csv",
    materials: new Map([[material.materialId, material]]),
    requireInstructionForMaterialIds: overrides.requireInstructionForMaterialIds,
    allowRegisteredMaterialStorageKeys: true
  });
}

function rdlPackage(rows, overrides = {}) {
  return groupReadingSourceOccurrences(adapt(rows, overrides).candidates).packages[0];
}

test("new canonical RDL keeps the CSV instruction as canonical material data", () => {
  const adapted = adapt(rdlRows());
  assert.deepEqual(adapted.failures, []);
  assert.equal(adapted.candidates[0].materials[0].instruction, "Read an event program.");
  assert.equal(adapted.candidates[0].materials[0].materialType, "event_program");

  const packageData = groupReadingSourceOccurrences(adapted.candidates).packages[0];
  const rows = buildReadingImportRows(packageData);
  assert.equal(rows.reading_materials.length, 1);
  assert.deepEqual(rows.reading_materials[0], {
    material_id: "RDL-200",
    title: "Campus Event Program",
    material_type: "event_program",
    instruction: "Read an event program.",
    source: "fixture",
    source_date: "2026-01-01",
    year_month: "2026-01",
    binding_status: "bound",
    image_asset_path: "reading/rdl/RDL-200/material_final.png",
    hitbox_data_path: "reading/rdl/RDL-200/selection_map.json",
    catalog_search_text: ""
  });
  assert.equal(
    prepareReadingPackageAtomicImport(packageData).rows.reading_materials[0].instruction,
    "Read an event program."
  );
});

test("instruction is stored verbatim except for a surrounding trim and never rewritten", () => {
  const adapted = adapt(rdlRows({ instruction: "  Read a event program.  " }));
  assert.deepEqual(adapted.failures, []);
  assert.equal(adapted.candidates[0].materials[0].instruction, "Read a event program.");
});

test("instruction does not participate in RDL dedup identity", () => {
  const withoutInstruction = rdlRows({ instruction: null });
  const withInstruction = rdlRows({ instruction: "Read an event program." });
  const changedInstruction = rdlRows({ instruction: "Some other instruction." });
  const first = rdlPackage(withoutInstruction);
  const second = rdlPackage(withInstruction);
  const third = rdlPackage(changedInstruction);
  assert.equal(first.item.logicalItemId, second.item.logicalItemId);
  assert.equal(first.item.dedupFingerprint, second.item.dedupFingerprint);
  assert.equal(first.item.logicalItemId, third.item.logicalItemId);
  assert.equal(first.item.dedupFingerprint, third.item.dedupFingerprint);
});

test("new canonical RDL without instruction is rejected before any fallback or creation", () => {
  const adapted = adapt(
    rdlRows({ instruction: null }),
    {
      material: rdlMaterial({ instruction: null }),
      requireInstructionForMaterialIds: new Set(["RDL-200"])
    }
  );
  assert.equal(adapted.candidates.length, 0);
  assert.match(adapted.failures[0].reason, /Missing instruction/);
  assert.match(adapted.failures[0].reason, /RDL-200/);
});

test("the same first-use material imports cleanly once the CSV supplies instruction", () => {
  const adapted = adapt(
    rdlRows({ instruction: "Read an event program." }),
    {
      material: rdlMaterial({ instruction: null }),
      requireInstructionForMaterialIds: new Set(["RDL-200"])
    }
  );
  assert.deepEqual(adapted.failures, []);
  assert.equal(adapted.candidates[0].materials[0].instruction, "Read an event program.");
});

test("established canonical materials keep their stored instruction on reuse", () => {
  const legacyRows = rdlRows({ instruction: null });
  const adaptedWithoutInstruction = adapt(legacyRows, {
    material: rdlMaterial({ instruction: "Read an email." })
  });
  assert.deepEqual(adaptedWithoutInstruction.failures, []);
  assert.equal(adaptedWithoutInstruction.candidates[0].materials[0].instruction, "Read an email.");

  const adaptedWithChangedSource = adapt(rdlRows({ instruction: "Read a different notice." }), {
    material: rdlMaterial({ instruction: "Read an email." })
  });
  assert.deepEqual(adaptedWithChangedSource.failures, []);
  assert.equal(
    adaptedWithChangedSource.candidates[0].materials[0].instruction,
    "Read an email.",
    "canonical instruction wins over a later occurrence value"
  );

  const historical = rdlPackage(rdlRows({ instruction: "Read a different notice." }), {
    material: rdlMaterial({ instruction: "Read an email." })
  });
  const incoming = structuredClone(historical);
  incoming.materials[0].instruction = "Read a different notice.";
  const attached = attachIncomingOccurrencesToHistoricalPackage(historical, incoming);
  assert.equal(attached.materials[0].instruction, "Read an email.");
});

test("instructions that conflict within one source group fail the whole group", () => {
  const rows = rdlRows({ instruction: "Read an event program." });
  rows[1].instruction = "Read a different instruction.";
  const adapted = adapt(rows);
  assert.equal(adapted.candidates.length, 0);
  assert.match(adapted.failures[0].reason, /instruction\/title conflicts/);
});

test("legacy RDL CSV headers remain detectable and importable without instruction", () => {
  assert.equal(detectQuestionType(READ_IN_DAILY_LIFE_HEADERS), "read_in_daily_life");
  assert.equal(detectQuestionType([...LEGACY_READ_IN_DAILY_LIFE_HEADERS]), "read_in_daily_life");
  const adapted = adapt(rdlRows({ instruction: null }));
  assert.deepEqual(adapted.failures, []);
  assert.equal(adapted.candidates[0].materials[0].instruction, null);
});

test("student runtime prefers the canonical instruction and keeps the legacy mapping fallback", () => {
  // The student query loads the canonical instruction with the material row.
  const studentPracticeSource = fs.readFileSync(
    path.join(projectRoot, "lib/reading/studentPractice.ts"),
    "utf8"
  );
  assert.match(studentPracticeSource, /select\("material_id,title,material_type,instruction,binding_status/);

  // A material_type outside the fixed 33-entry map still displays exactly.
  assert.equal(
    rdlDisplayInstruction({ instruction: "Read an event program.", materialType: "event_program" }),
    "Read an event program."
  );
  assert.equal(
    rdlDisplayInstruction({ instruction: "  Read an event program.  ", materialType: null }),
    "Read an event program."
  );
  // Legacy fallback for historical instruction = NULL rows.
  assert.equal(rdlDisplayInstruction({ instruction: null, materialType: "email" }), "Read an email.");
  assert.equal(rdlDisplayInstruction({ instruction: null, materialType: "email" }), rdlMaterialInstruction("email"));
  assert.equal(rdlDisplayInstruction({ instruction: null, materialType: null }), "Reading material instruction unavailable.");
  assert.equal(rdlDisplayInstruction({ instruction: null, materialType: "future_authoritative_type_2" }), "Read the material.");
});

test("student payload carries instruction from the canonical material", () => {
  const packageData = rdlPackage(rdlRows({ instruction: "Read an event program." }), {
    material: rdlMaterial({ instruction: "Read an event program." })
  });
  const payload = toStudentReadingPracticePayload(packageData, "https://assets.example.com");
  assert.equal(payload.material.materialId, "RDL-200");
  assert.equal(payload.material.instruction, "Read an event program.");
  assert.equal(payload.material.materialType, "event_program");
});

test("package validation normalizes and trims instruction without generating it from material_type", () => {
  const packageData = rdlPackage(rdlRows({ instruction: "  Read an event program.  " }));
  const validated = validateReadingImportPackage(packageData);
  assert.equal(validated.materials[0].instruction, "Read an event program.");

  const withoutInstruction = rdlPackage(rdlRows({ instruction: null }));
  delete withoutInstruction.materials[0].instruction;
  const normalized = validateReadingImportPackage(withoutInstruction);
  assert.equal(normalized.materials[0].instruction, null);
  assert.equal(normalized.materials[0].materialType, "event_program");

  const blankInstruction = rdlPackage(rdlRows({ instruction: "Read an event program." }));
  blankInstruction.materials[0].instruction = "   ";
  assert.equal(validateReadingImportPackage(blankInstruction).materials[0].instruction, null);
});

test("atomic RPC requires instruction only for a material's first canonical question set", () => {
  assert.match(instructionMigration, /add column if not exists instruction text/);
  assert.match(sql, /READING_RDL_MATERIAL_INSTRUCTION_REQUIRED/);
  assert.match(sql, /material_id, title, material_type, instruction, source/);
  assert.match(sql, /question\.material_id = x\.material_id/);
  assert.match(sql, /reading_materials\.instruction is not null then reading_materials\.instruction/);
  assert.match(sql, /question\.material_id = reading_materials\.material_id/);
  assert.doesNotMatch(sql, /instruction = excluded\.instruction/);
});
