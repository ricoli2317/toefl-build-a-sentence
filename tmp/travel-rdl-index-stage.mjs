#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { parseRdlSelectionMap } from "../lib/reading/rdlSelection.ts";
import { readingRdlObjectKeys } from "../lib/reading/assets.ts";
import { buildRdlAssetManifest } from "../lib/reading/r2Manifest.ts";

const READING_ROOT = "/Users/rico/Desktop/真题/阅读";
const PRODUCTION_RDL = join(READING_ROOT, "production/rdl");
const MANIFEST_ROOT = join(READING_ROOT, "production/manifests");
const OUTPUT_ROOT = process.argv[2] ?? join(process.cwd(), "tmp/travel-rdl-index-staging");
const HARNESS_ROOT = process.argv[3] ?? "/private/tmp/travel-rdl-index-builder-harness-20260912";
const HISTORICAL_REUSED_IDS = [
  "RDL-009", "RDL-010", "RDL-015", "RDL-017", "RDL-018", "RDL-020",
  "RDL-026", "RDL-032", "RDL-034", "RDL-043", "RDL-048", "RDL-056",
  "RDL-058", "RDL-070", "RDL-077", "RDL-078", "RDL-079", "RDL-082",
  "RDL-086",
];
const EXPECTED_WORK_IDS = [
  ...Array.from({ length: 18 }, (_, index) => `RDL-${String(87 + index).padStart(3, "0")}`),
  ...Array.from({ length: 3 }, (_, index) => `RDL-${String(106 + index).padStart(3, "0")}`),
  ...Array.from({ length: 25 }, (_, index) => `RDL-${String(110 + index).padStart(3, "0")}`),
];
const RETIRED_IDS = new Set(["RDL-105", "RDL-109"]);

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function mustNotExist(path) {
  try {
    await stat(path);
    throw new Error(`refusing to overwrite existing path: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function pngDimensions(bytes, label) {
  assert(bytes.length >= 24 && bytes.toString("ascii", 1, 4) === "PNG", `${label}: invalid PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function occurrenceId(row) {
  return `${row.source_label}-${row.module}-RDL-${String(row.rdl_index).padStart(2, "0")}`;
}

function resolveReading(path) {
  return join(READING_ROOT, path);
}

async function validateHistorical(material, selectionAsset) {
  const id = material.asset_id;
  assert(material.legacy_active_location_exception === true, `${id}: legacy exception missing`);
  assert(selectionAsset?.asset_id === id, `${id}: selection catalog entry missing`);
  assert(material.selection_map === selectionAsset.selection_map, `${id}: index/catalog selection paths differ`);
  const imagePath = resolveReading(material.material_final);
  const selectionPath = resolveReading(material.selection_map);
  const [imageBytes, selectionBytes] = await Promise.all([readFile(imagePath), readFile(selectionPath)]);
  const selection = JSON.parse(selectionBytes.toString("utf8"));
  const parsed = parseRdlSelectionMap(selection);
  const dimensions = pngDimensions(imageBytes, id);
  const imageHash = sha256(imageBytes);
  assert(selectionAsset.final_image === material.material_final, `${id}: active image paths differ`);
  assert(selectionAsset.sha256 === imageHash, `${id}: selection catalog image SHA mismatch`);
  assert(selection.image_sha256 === imageHash, `${id}: selection/image SHA binding mismatch`);
  assert(selectionAsset.width === dimensions.width && selectionAsset.height === dimensions.height, `${id}: dimensions mismatch`);
  assert(parsed.canvasWidth === dimensions.width && parsed.canvasHeight === dimensions.height, `${id}: parser canvas mismatch`);
  return {
    material_id: id,
    legacy_active_location_exception: true,
    image_path: material.material_final,
    selection_path: material.selection_map,
    image_sha256: imageHash,
    selection_sha256: sha256(selectionBytes),
    tps_parser: "PASS",
    r2_binding: "PASS",
  };
}

async function main() {
  await mustNotExist(OUTPUT_ROOT);
  await mustNotExist(HARNESS_ROOT);
  const materialIndexPath = join(MANIFEST_ROOT, "material-index.json");
  const selectionAssetsPath = join(MANIFEST_ROOT, "selection-assets.json");
  const incrementalPath = join(MANIFEST_ROOT, "RDL_WORK_INCREMENTAL_MANIFEST.travel-local.json");
  const releasePath = join(MANIFEST_ROOT, "RDL_FINAL_RELEASE_MAP.travel-local.json");
  const [materialIndexBytes, selectionAssetsBytes, materialIndex, selectionAssets, incremental, release] = await Promise.all([
    readFile(materialIndexPath),
    readFile(selectionAssetsPath),
    loadJson(materialIndexPath),
    loadJson(selectionAssetsPath),
    loadJson(incrementalPath),
    loadJson(releasePath),
  ]);
  assert(materialIndex.schema_version === "rdl-material-index-production-v1", "unexpected material-index schema");
  assert(selectionAssets.schema_version === "rdl-selection-catalog-production-v1", "unexpected selection-assets schema");
  assert(materialIndex.materials.length === 86 && selectionAssets.assets.length === 86, "historical indexes are not 86/86");
  const historicalMaterials = new Map(materialIndex.materials.map((row) => [row.asset_id, row]));
  const historicalSelections = new Map(selectionAssets.assets.map((row) => [row.asset_id, row]));
  assert(historicalMaterials.size === 86 && historicalSelections.size === 86, "historical index contains duplicate IDs");

  const historicalResolution = [];
  for (const id of HISTORICAL_REUSED_IDS) {
    const material = historicalMaterials.get(id);
    assert(material, `${id}: absent from historical material-index`);
    historicalResolution.push(await validateHistorical(material, historicalSelections.get(id)));
  }

  const incrementalIds = incremental.materials.map((row) => row.canonical_asset_id);
  const releaseIds = release.work_created_assets.map((row) => row.canonical_asset_id);
  assert(JSON.stringify(incrementalIds) === JSON.stringify(EXPECTED_WORK_IDS), "incremental Work-created ID set mismatch");
  assert(JSON.stringify(releaseIds) === JSON.stringify(EXPECTED_WORK_IDS), "release Work-created ID set mismatch");
  assert(!EXPECTED_WORK_IDS.some((id) => RETIRED_IDS.has(id)), "retired ID in Work-created set");
  const releaseOccurrences = new Map(release.occurrences.map((row) => [occurrenceId(row), row]));
  assert(releaseOccurrences.size === release.occurrences.length, "release map occurrence IDs are not unique");

  const materialAdditions = [];
  const selectionAdditions = [];
  const workAudit = [];
  const uploadInventory = [];
  for (const source of incremental.materials) {
    const id = source.canonical_asset_id;
    assert(!historicalMaterials.has(id) && !historicalSelections.has(id), `${id}: already exists in a historical index`);
    const packageRoot = join(PRODUCTION_RDL, id);
    const files = (await readdir(packageRoot)).sort();
    assert(JSON.stringify(files) === JSON.stringify(["asset.json", "material_final.png", "selection_map.json"]), `${id}: production bundle contract failed`);
    const [assetBytes, imageBytes, selectionBytes] = await Promise.all([
      readFile(join(packageRoot, "asset.json")),
      readFile(join(packageRoot, "material_final.png")),
      readFile(join(packageRoot, "selection_map.json")),
    ]);
    const asset = JSON.parse(assetBytes.toString("utf8"));
    const selection = JSON.parse(selectionBytes.toString("utf8"));
    const parsed = parseRdlSelectionMap(selection);
    const dimensions = pngDimensions(imageBytes, id);
    const imageHash = sha256(imageBytes);
    const selectionHash = sha256(selectionBytes);
    assert(asset.material_id === id, `${id}: asset identity mismatch`);
    assert(asset.image_sha256 === imageHash && asset.selection_image_sha256 === imageHash, `${id}: asset image binding mismatch`);
    assert(asset.selection_sha256 === selectionHash, `${id}: asset selection SHA mismatch`);
    assert(asset.width === dimensions.width && asset.height === dimensions.height, `${id}: asset dimensions mismatch`);
    assert(selection.image_sha256 === imageHash && parsed.canvasWidth === dimensions.width && parsed.canvasHeight === dimensions.height, `${id}: selection binding mismatch`);
    assert(source.material_final_path === `production/rdl/${id}/material_final.png`, `${id}: incremental image path mismatch`);
    assert(source.selection_map_path === `production/rdl/${id}/selection_map.json`, `${id}: incremental selection path mismatch`);
    const releaseAsset = release.work_created_assets.find((row) => row.canonical_asset_id === id);
    assert(releaseAsset?.status === "FROZEN_SELECTION_QA_PASS", `${id}: release acceptance missing`);
    const occurrences = source.source_occurrences.map((row) => {
      const released = releaseOccurrences.get(row.occurrenceId);
      assert(released?.canonical_asset_id === id, `${id}/${row.occurrenceId}: release occurrence mismatch`);
      assert(JSON.stringify(released.question_range) === JSON.stringify(row.questionRange), `${id}/${row.occurrenceId}: question range mismatch`);
      return {
        occurrence_id: row.occurrenceId,
        set: row.set,
        ...(row.sourceSet ? { source_set: row.sourceSet } : {}),
        ...(row.sourceDate ? { source_date: row.sourceDate } : {}),
        question_range: row.questionRange,
        ...(row.rdlType ? { rdl_type: row.rdlType } : {}),
        ...(row.mapping_basis ? { mapping_basis: row.mapping_basis } : {}),
        ...(row.source_occurrence_key ? { source_occurrence_key: row.source_occurrence_key } : {}),
      };
    });
    const materialRow = {
      asset_id: id,
      first_seen: source.source_labels[0],
      occurrences,
      occurrence_count: occurrences.length,
      material_identifying_text: source.canonical_title,
      material_final: source.material_final_path,
      hd_status: asset.hd_status,
      final_status: asset.final_status,
      provenance: "travel_work_final_release",
      selection_status: asset.selection_status,
      selection_map: source.selection_map_path,
      metadata: `production/rdl/${id}/asset.json`,
      material_final_sha256: imageHash,
      material_final_width: dimensions.width,
      material_final_height: dimensions.height,
      ...(asset.canonical_source ? { canonical_source: asset.canonical_source } : {}),
    };
    const selectionRow = {
      asset_id: id,
      set_id: source.source_labels[0],
      final_image: source.material_final_path,
      width: dimensions.width,
      height: dimensions.height,
      sha256: imageHash,
      selection_map: source.selection_map_path,
      selection_status: asset.selection_status,
    };
    materialAdditions.push(materialRow);
    selectionAdditions.push(selectionRow);
    workAudit.push({ material_id: id, image_sha256: imageHash, selection_sha256: selectionHash, parser: "PASS", files: "PASS" });
    const keys = readingRdlObjectKeys(id);
    uploadInventory.push(
      { material_id: id, kind: "image", canonical_path: source.material_final_path, object_key: keys.imageObjectKey, sha256: imageHash, size: imageBytes.length, content_type: "image/png" },
      { material_id: id, kind: "selection_map", canonical_path: source.selection_map_path, object_key: keys.selectionMapObjectKey, sha256: selectionHash, size: selectionBytes.length, content_type: "application/json" },
    );
  }

  const mergedMaterialIndex = structuredClone(materialIndex);
  mergedMaterialIndex.materials = [...mergedMaterialIndex.materials, ...materialAdditions].sort((a, b) => a.asset_id.localeCompare(b.asset_id));
  const indexedOccurrenceCount = mergedMaterialIndex.materials.reduce((sum, row) => sum + row.occurrence_count, 0);
  mergedMaterialIndex.statistics.unique_materials = mergedMaterialIndex.materials.length;
  mergedMaterialIndex.statistics.occurrence_total = indexedOccurrenceCount;
  mergedMaterialIndex.statistics.duplicate_occurrences = indexedOccurrenceCount - mergedMaterialIndex.materials.length;
  mergedMaterialIndex.statistics.selection = {
    ...mergedMaterialIndex.statistics.selection,
    canonical_assets_total: mergedMaterialIndex.materials.length,
    passed: mergedMaterialIndex.materials.filter((row) => row.selection_status === "passed").length,
  };
  mergedMaterialIndex.statistics.travel_work_created_patch = {
    canonical_assets: materialAdditions.length,
    indexed_occurrences: materialAdditions.reduce((sum, row) => sum + row.occurrence_count, 0),
    source: "RDL_WORK_INCREMENTAL_MANIFEST.travel-local.json",
  };
  const mergedSelectionAssets = structuredClone(selectionAssets);
  mergedSelectionAssets.assets = [...mergedSelectionAssets.assets, ...selectionAdditions].sort((a, b) => a.asset_id.localeCompare(b.asset_id));

  const mergedMaterialIds = mergedMaterialIndex.materials.map((row) => row.asset_id);
  const mergedSelectionIds = mergedSelectionAssets.assets.map((row) => row.asset_id);
  assert(mergedMaterialIds.length === 132 && new Set(mergedMaterialIds).size === 132, "material merged preview is not 132 unique IDs");
  assert(mergedSelectionIds.length === 132 && new Set(mergedSelectionIds).size === 132, "selection merged preview is not 132 unique IDs");
  assert(JSON.stringify(mergedMaterialIds) === JSON.stringify(mergedSelectionIds), "merged preview index ID sets differ");
  assert(!mergedMaterialIds.some((id) => RETIRED_IDS.has(id)), "retired ID in merged preview");
  assert([...historicalMaterials].every(([id]) => mergedMaterialIds.includes(id)), "historical ID lost from merged preview");

  const mergedById = new Map(mergedMaterialIndex.materials.map((row) => [row.asset_id, row]));
  let occurrenceResolutionPassed = 0;
  const occurrenceResolution = [];
  for (const occurrence of release.occurrences) {
    const id = occurrence.canonical_asset_id;
    assert(typeof id === "string" && !id.startsWith("RDL-CAND-"), `${occurrenceId(occurrence)}: invalid canonical ID`);
    assert(!RETIRED_IDS.has(id), `${occurrenceId(occurrence)}: retired canonical ID`);
    const material = mergedById.get(id);
    assert(material, `${occurrenceId(occurrence)}: canonical ID absent from merged preview`);
    await Promise.all([readFile(resolveReading(material.material_final)), readFile(resolveReading(material.selection_map))]);
    const category = EXPECTED_WORK_IDS.includes(id) ? "work_created_production_bundle" : "historical_active_location";
    if (category === "work_created_production_bundle") assert(material.material_final.startsWith(`production/rdl/${id}/`), `${id}: Work path is not production/rdl`);
    occurrenceResolutionPassed += 1;
    occurrenceResolution.push({ occurrence_id: occurrenceId(occurrence), canonical_asset_id: id, resolution: category, status: "PASS" });
  }

  await mkdir(OUTPUT_ROOT);
  const materialPatch = {
    schema_version: "rdl-material-index-travel-patch-v1",
    base_schema_version: materialIndex.schema_version,
    base_sha256: sha256(materialIndexBytes),
    add_count: materialAdditions.length,
    materials: materialAdditions,
  };
  const selectionPatch = {
    schema_version: "rdl-selection-catalog-travel-patch-v1",
    base_schema_version: selectionAssets.schema_version,
    base_sha256: sha256(selectionAssetsBytes),
    add_count: selectionAdditions.length,
    assets: selectionAdditions,
  };
  await Promise.all([
    writeJson(join(OUTPUT_ROOT, "material-index.travel-patch.json"), materialPatch),
    writeJson(join(OUTPUT_ROOT, "selection-assets.travel-patch.json"), selectionPatch),
    writeJson(join(OUTPUT_ROOT, "material-index.merged-preview.json"), mergedMaterialIndex),
    writeJson(join(OUTPUT_ROOT, "selection-assets.merged-preview.json"), mergedSelectionAssets),
  ]);

  await mkdir(join(HARNESS_ROOT, "data"), { recursive: true });
  await Promise.all([
    writeJson(join(HARNESS_ROOT, "data/material-index.json"), mergedMaterialIndex),
    writeJson(join(HARNESS_ROOT, "data/selection-assets.json"), mergedSelectionAssets),
    symlink(join(READING_ROOT, "production"), join(HARNESS_ROOT, "production"), "dir"),
    symlink(join(READING_ROOT, "rdl-image-hitbox-prototype"), join(HARNESS_ROOT, "rdl-image-hitbox-prototype"), "dir"),
  ]);
  const builderManifest = await buildRdlAssetManifest({ canonicalRoot: HARNESS_ROOT, generatedAt: "DRY_RUN", integrityStatus: "COMPLETE" });
  assert(builderManifest.materialCount === 132 && builderManifest.objectCount === 264, "R2 builder merged-preview validation failed");
  const historicalBuilderIds = new Set(builderManifest.materials.map((row) => row.materialId));
  assert(HISTORICAL_REUSED_IDS.every((id) => historicalBuilderIds.has(id)), "R2 builder omitted a historical reused ID");

  assert(uploadInventory.length === 92, "future upload inventory is not 92 objects");
  assert(uploadInventory.filter((row) => row.kind === "image").length === 46, "future image inventory is not 46");
  assert(uploadInventory.filter((row) => row.kind === "selection_map").length === 46, "future selection inventory is not 46");
  assert(uploadInventory.every((row) => EXPECTED_WORK_IDS.includes(row.material_id)), "historical object entered future upload inventory");
  assert(uploadInventory.every((row) => /\/material_final\.png$|\/selection_map\.json$/.test(row.object_key)), "non-runtime object entered inventory");

  const report = {
    schema_version: "travel-rdl-index-staging-qa-v1",
    status: "PASS",
    output_root: OUTPUT_ROOT,
    formal_indexes_modified: false,
    historical_reused_resolution: { passed: historicalResolution.length, total: HISTORICAL_REUSED_IDS.length, status: "PASS", materials: historicalResolution },
    canonical_resolution_invariant: "PASS",
    schema_audit: {
      material_index_schema: materialIndex.schema_version,
      material_index_r2_required_fields: ["asset_id", "material_final", "selection_map", "selection_status"],
      material_index_r2_optional_fields: ["canonical_source", "provenance"],
      selection_assets_schema: selectionAssets.schema_version,
      selection_assets_r2_required_fields: ["asset_id", "final_image", "selection_map", "sha256", "selection_status"],
      retained_integrity_fields: ["width", "height"],
      intentionally_not_fabricated: ["slug", "source_original", "source file", "page", "render_dpi"],
    },
    patches: { material_index: materialAdditions.length, selection_assets: selectionAdditions.length },
    merged_preview: {
      material_count: mergedMaterialIds.length,
      selection_asset_count: mergedSelectionIds.length,
      duplicate_material_ids: mergedMaterialIds.length - new Set(mergedMaterialIds).size,
      duplicate_selection_ids: mergedSelectionIds.length - new Set(mergedSelectionIds).size,
      historical_86_preserved: true,
      retired_ids_absent: true,
      work_created_files_and_hashes: "PASS",
      work_created_tps_parser: `${workAudit.filter((row) => row.parser === "PASS").length}/46 PASS`,
      current_r2_builder: `${builderManifest.materialCount}/132 PASS`,
    },
    release_map_occurrence_resolution: { passed: occurrenceResolutionPassed, total: release.occurrences.length, status: "PASS", occurrences: occurrenceResolution },
    r2_future_upload_inventory: {
      status: "DRY_RUN_ONLY",
      image_count: uploadInventory.filter((row) => row.kind === "image").length,
      selection_map_count: uploadInventory.filter((row) => row.kind === "selection_map").length,
      object_count: uploadInventory.length,
      historical_objects_included: 0,
      excluded: ["asset.json", "metadata.json", "preview.jpg", "source_original.png"],
      objects: uploadInventory,
    },
  };
  await writeJson(join(OUTPUT_ROOT, "index-qa-report.json"), report);
  const outputFiles = (await readdir(OUTPUT_ROOT)).sort();
  assert(JSON.stringify(outputFiles) === JSON.stringify([
    "index-qa-report.json",
    "material-index.merged-preview.json",
    "material-index.travel-patch.json",
    "selection-assets.merged-preview.json",
    "selection-assets.travel-patch.json",
  ]), "index staging output file contract failed");
  console.log(JSON.stringify({
    status: report.status,
    historical_reused_resolution: report.historical_reused_resolution.status,
    historical_reused_passed: report.historical_reused_resolution.passed,
    material_patch: report.patches.material_index,
    selection_patch: report.patches.selection_assets,
    merged_count: report.merged_preview.material_count,
    duplicate_ids: report.merged_preview.duplicate_material_ids,
    occurrence_resolution: `${occurrenceResolutionPassed}/${release.occurrences.length}`,
    r2_future_objects: report.r2_future_upload_inventory.object_count,
    r2_builder: report.merged_preview.current_r2_builder,
    output_root: OUTPUT_ROOT,
  }, null, 2));
}

await main();
