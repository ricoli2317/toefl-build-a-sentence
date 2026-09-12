#!/usr/bin/env node

/**
 * Deterministically converts the Travel Work RDL selection-map v1 bundles to
 * the current TPS v2 runtime contract and builds a non-production staging tree.
 *
 * This script never runs OCR and never changes material_final.png bytes or any
 * source selection text/character geometry.
 */

import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import {
  calculateRdlContainRect,
  flattenRdlCharacters,
  hitTestRdlCharacter,
  normalizeRdlSelectionRange,
  parseRdlSelectionMap,
  rdlSelectedText,
  rdlWordRangeAt,
  validateRdlImageBinding,
} from "../lib/reading/rdlSelection.ts";

const READING_ROOT = "/Users/rico/Desktop/真题/阅读";
const WORK_RDL_ROOT = join(READING_ROOT, "work-output/production/rdl");
const WORK_MANIFEST_ROOT = join(READING_ROOT, "work-output/manifests");
const OUTPUT_ROOT = process.argv[2] ?? join(process.cwd(), "tmp/travel-rdl-local-merge-staging");
const RETIRED_IDS = new Set(["RDL-105", "RDL-109"]);
const EXPECTED_IDS = [
  ...Array.from({ length: 18 }, (_, index) => `RDL-${String(87 + index).padStart(3, "0")}`),
  ...Array.from({ length: 3 }, (_, index) => `RDL-${String(106 + index).padStart(3, "0")}`),
  ...Array.from({ length: 25 }, (_, index) => `RDL-${String(110 + index).padStart(3, "0")}`),
];
const GENERIC_REQUIRED_FIELDS = [
  "schema_version",
  "material_id",
  "active_image",
  "active_selection",
  "image_sha256",
  "selection_sha256",
  "width",
  "height",
  "hd_status",
  "final_status",
  "selection_status",
  "selection_image_sha256",
  "material_final",
  "source_reference",
  "release_acceptance",
];
const CONVERSION_RECORD = {
  from_schema: 1,
  to_schema: 2,
  method: "deterministic_structure_conversion",
  content_geometry_changed: false,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pngDimensions(bytes, label) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  assert(bytes.length >= 24 && signature.every((value, index) => bytes[index] === value), `${label}: invalid PNG`);
  assert(bytes.subarray(12, 16).toString("ascii") === "IHDR", `${label}: missing PNG IHDR`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert(width > 0 && height > 0, `${label}: invalid PNG dimensions`);
  return { width, height };
}

function normalizedBbox(input, label) {
  assert(input && typeof input === "object" && !Array.isArray(input), `${label}: bbox must be an object`);
  const bbox = Object.fromEntries(["x", "y", "width", "height"].map((key) => {
    const value = input[key];
    assert(typeof value === "number" && Number.isFinite(value), `${label}.${key}: must be finite`);
    return [key, value];
  }));
  assert(
    bbox.x >= 0 && bbox.y >= 0 && bbox.width > 0 && bbox.height > 0
      && bbox.x + bbox.width <= 1.000001 && bbox.y + bbox.height <= 1.000001,
    `${label}: bbox outside normalized image bounds`,
  );
  return bbox;
}

function sourceWordCharacters(line, word, label) {
  if (Array.isArray(word.characters)) {
    assert(word.characters.length > 0, `${label}: empty word.characters`);
    return word.characters;
  }
  assert(Number.isInteger(word.character_start) && word.character_start >= 0, `${label}: invalid character_start`);
  assert(Number.isInteger(word.character_end) && word.character_end >= word.character_start, `${label}: invalid character_end`);
  assert(Array.isArray(line.characters) && word.character_end < line.characters.length, `${label}: unresolved line character range`);
  const characters = line.characters.slice(word.character_start, word.character_end + 1);
  assert(characters.length > 0, `${label}: empty resolved characters`);
  return characters;
}

function convertSelection(source, materialId, imageSha256, dimensions) {
  assert(source.schema_version === 1, `${materialId}: source selection is not schema v1`);
  assert((source.asset_id ?? source.canonical_asset_id) === materialId, `${materialId}: source selection identity mismatch`);
  assert(source.image?.sha256 === imageSha256, `${materialId}: source selection image SHA mismatch`);
  assert(source.image?.width === dimensions.width && source.image?.height === dimensions.height, `${materialId}: source selection dimensions mismatch`);
  assert(Array.isArray(source.lines) && source.lines.length > 0, `${materialId}: no source lines`);
  assert(typeof source.visible_text === "string" && source.visible_text.length > 0, `${materialId}: missing visible_text`);

  let globalIndex = 0;
  let wordCount = 0;
  const sourceCharacterSemantics = [];
  const convertedCharacterSemantics = [];
  const lines = source.lines.map((line, lineIndex) => {
    assert(line.line_index === lineIndex, `${materialId}: nonsequential line index`);
    assert(Array.isArray(line.words) && line.words.length > 0, `${materialId}: line ${lineIndex} has no words`);
    const words = line.words.map((word, wordIndex) => {
      const label = `${materialId}.lines[${lineIndex}].words[${wordIndex}]`;
      const sourceCharacters = sourceWordCharacters(line, word, label);
      const wordId = `l${lineIndex}w${wordIndex}`;
      const chars = sourceCharacters.map((sourceCharacter, charIndex) => {
        assert(typeof sourceCharacter.character === "string" && sourceCharacter.character.length > 0, `${label}: empty character`);
        const bbox = normalizedBbox(sourceCharacter.bbox, `${label}.characters[${charIndex}]`);
        sourceCharacterSemantics.push({ char: sourceCharacter.character, bbox: structuredClone(bbox) });
        const converted = {
          id: `${wordId}c${charIndex}`,
          line_index: lineIndex,
          word_index: wordIndex,
          char_index: charIndex,
          global_index: globalIndex,
          char: sourceCharacter.character,
          bbox: structuredClone(bbox),
        };
        convertedCharacterSemantics.push({ char: converted.char, bbox: structuredClone(converted.bbox) });
        globalIndex += 1;
        return converted;
      });
      assert(typeof word.text === "string" && word.text.length > 0, `${label}: empty word text`);
      assert(chars.map((character) => character.char).join("") === word.text, `${label}: word text/characters mismatch`);
      wordCount += 1;
      return {
        id: wordId,
        line_index: lineIndex,
        word_index: wordIndex,
        text: word.text,
        bbox: normalizedBbox(word.bbox, label),
        chars,
      };
    });
    assert(typeof line.text === "string" && line.text.length > 0, `${materialId}: line ${lineIndex} has empty text`);
    return {
      line_index: lineIndex,
      text: line.text,
      bbox: normalizedBbox(line.bbox, `${materialId}.lines[${lineIndex}]`),
      words,
    };
  });
  assert(JSON.stringify(sourceCharacterSemantics) === JSON.stringify(convertedCharacterSemantics), `${materialId}: character text/bbox changed`);
  assert(
    JSON.stringify([...sourceCharacterSemantics].reverse()) === JSON.stringify([...convertedCharacterSemantics].reverse()),
    `${materialId}: reverse character order changed`,
  );
  const joinedLineText = lines.map((line) => line.text).join("\n");
  assert(
    source.visible_text.replaceAll(/\s/g, "") === joinedLineText.replaceAll(/\s/g, ""),
    `${materialId}: visible_text differs from line text beyond whitespace`,
  );
  return {
    map: {
      schema_version: 2,
      image_file: "material_final.png",
      image_sha256: imageSha256,
      canvas_width: dimensions.width,
      canvas_height: dimensions.height,
      coordinate_space: "normalized_top_left_xywh_0_1",
      visible_text: source.visible_text,
      lines,
    },
    audit: {
      source_identity_field: Object.hasOwn(source, "asset_id") ? "asset_id" : "canonical_asset_id",
      line_count: lines.length,
      word_count: wordCount,
      character_count: sourceCharacterSemantics.length,
      visible_text_exactly_preserved: true,
      joined_line_text_whitespace_insensitive_match: true,
      character_text_preserved: true,
      character_bbox_preserved: true,
      forward_reverse_order_preserved: true,
      normalized_bbox_validation: "PASS",
    },
  };
}

function localize(value) {
  if (typeof value === "string") return value.replaceAll("work-output/production/rdl/", "production/rdl/");
  if (Array.isArray(value)) return value.map(localize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, localize(child)]));
  }
  return value;
}

async function validateGenericAsset(packageRoot, asset) {
  for (const field of GENERIC_REQUIRED_FIELDS) assert(Object.hasOwn(asset, field), `${basename(packageRoot)}: asset missing ${field}`);
  const materialId = basename(packageRoot);
  const [imageBytes, selectionBytes] = await Promise.all([
    readFile(join(packageRoot, "material_final.png")),
    readFile(join(packageRoot, "selection_map.json")),
  ]);
  const dimensions = pngDimensions(imageBytes, materialId);
  const imageHash = sha256(imageBytes);
  assert(asset.schema_version === "rdl-production-asset-v1", `${materialId}: invalid asset schema`);
  assert(asset.material_id === materialId, `${materialId}: invalid asset identity`);
  assert(asset.active_image === "material_final.png" && asset.active_selection === "selection_map.json", `${materialId}: invalid active files`);
  assert(asset.image_sha256 === imageHash && asset.selection_image_sha256 === imageHash, `${materialId}: asset image binding mismatch`);
  assert(asset.selection_sha256 === sha256(selectionBytes), `${materialId}: asset selection hash mismatch`);
  assert(asset.width === dimensions.width && asset.height === dimensions.height, `${materialId}: asset dimensions mismatch`);
  assert(asset.hd_status === "passed" && asset.final_status === "passed" && asset.selection_status === "passed", `${materialId}: asset release status mismatch`);
  assert(
    asset.material_final?.file === "material_final.png"
      && asset.material_final?.sha256 === imageHash
      && asset.material_final?.frozen === true,
    `${materialId}: material_final freeze binding mismatch`,
  );
  assert(
    asset.source_reference?.manifest === "RDL_WORK_INCREMENTAL_MANIFEST.local.json"
      && asset.source_reference?.canonical_asset_id === materialId,
    `${materialId}: authoritative source reference mismatch`,
  );
  assert(
    asset.release_acceptance?.manifest === "RDL_FINAL_RELEASE_MAP.local.json"
      && asset.release_acceptance?.status === "FROZEN_SELECTION_QA_PASS",
    `${materialId}: release acceptance mismatch`,
  );
}

function runInteractionQa(materialId, map) {
  const characters = flattenRdlCharacters(map);
  assert(characters.length > 0, `${materialId}: no parsed characters`);
  for (const word of map.lines.flatMap((line) => line.words)) {
    const firstIndex = characters.findIndex((character) => character.wordId === word.id);
    const wordRange = rdlWordRangeAt(map, firstIndex);
    assert(wordRange && rdlSelectedText(map, wordRange) === word.text, `${materialId}: whole-word selection failed`);
    if (word.characters.length > 1) {
      const partialRange = normalizeRdlSelectionRange(firstIndex, firstIndex + 1);
      const expected = word.characters.slice(0, 2).map((character) => character.char).join("");
      assert(rdlSelectedText(map, partialRange) === expected, `${materialId}: partial-word selection failed`);
    }
  }
  let multiWordChecks = 0;
  for (const line of map.lines) {
    if (line.words.length < 2) continue;
    const [first, second] = line.words;
    const start = characters.findIndex((character) => character.wordId === first.id);
    const end = characters.map((character) => character.wordId).lastIndexOf(second.id);
    assert(rdlSelectedText(map, normalizeRdlSelectionRange(start, end)) === `${first.text} ${second.text}`, `${materialId}: multi-word selection failed`);
    multiWordChecks += 1;
  }
  assert(multiWordChecks > 0, `${materialId}: no multi-word check executed`);
  let crossLineChecks = 0;
  for (let index = 0; index < map.lines.length - 1; index += 1) {
    const left = map.lines[index].words.at(-1);
    const right = map.lines[index + 1].words[0];
    const start = characters.findIndex((character) => character.wordId === left.id);
    const end = characters.map((character) => character.wordId).lastIndexOf(right.id);
    const forward = rdlSelectedText(map, normalizeRdlSelectionRange(start, end));
    const reverse = rdlSelectedText(map, normalizeRdlSelectionRange(end, start));
    assert(forward === `${left.text} ${right.text}` && reverse === forward, `${materialId}: cross-line/reverse selection failed`);
    crossLineChecks += 1;
  }
  assert(crossLineChecks > 0, `${materialId}: no cross-line check executed`);
  const sample = characters[Math.floor(characters.length / 2)];
  const normalizedX = sample.bbox.x + sample.bbox.width / 2;
  const normalizedY = sample.bbox.y + sample.bbox.height / 2;
  for (const [containerWidth, containerHeight] of [[600, 600], [320, 900]]) {
    const rect = calculateRdlContainRect(containerWidth, containerHeight, map.canvasWidth, map.canvasHeight);
    const pixelX = rect.left + normalizedX * rect.width;
    const pixelY = rect.top + normalizedY * rect.height;
    const roundTripX = (pixelX - rect.left) / rect.width;
    const roundTripY = (pixelY - rect.top) / rect.height;
    assert(Math.abs(roundTripX - normalizedX) < 1e-12 && Math.abs(roundTripY - normalizedY) < 1e-12, `${materialId}: scaled coordinate round trip failed`);
    assert(hitTestRdlCharacter(map, roundTripX, roundTripY, true) !== null, `${materialId}: scaled hit test failed`);
  }
  return {
    whole_word: "PASS",
    partial_word: "PASS",
    multi_word: "PASS",
    cross_line: "PASS",
    reverse: "PASS",
    scaled_display: "PASS",
  };
}

async function main() {
  try {
    await stat(OUTPUT_ROOT);
    throw new Error(`refusing to overwrite existing staging root: ${OUTPUT_ROOT}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const [incremental, finalMap, currentGlobal] = await Promise.all([
    json(join(WORK_MANIFEST_ROOT, "RDL_WORK_INCREMENTAL_MANIFEST.json")),
    json(join(WORK_MANIFEST_ROOT, "RDL_FINAL_RELEASE_MAP.json")),
    json(join(WORK_MANIFEST_ROOT, "RDL_CURRENT_GLOBAL_MANIFEST.json")),
  ]);
  const ids = incremental.materials.map((material) => material.canonical_asset_id);
  assert(JSON.stringify(ids) === JSON.stringify(EXPECTED_IDS), "Work incremental ID list differs from expected 46 IDs");
  assert(!ids.some((id) => RETIRED_IDS.has(id)), "retired ID present in incremental manifest");
  assert(
    JSON.stringify(finalMap.work_created_assets.map((material) => material.canonical_asset_id)) === JSON.stringify(ids),
    "final release Work asset list differs from incremental manifest",
  );
  const finalAssetById = new Map(finalMap.work_created_assets.map((material) => [material.canonical_asset_id, material]));

  await mkdir(OUTPUT_ROOT, { recursive: false });
  const conversionResults = [];
  for (const material of incremental.materials) {
    const materialId = material.canonical_asset_id;
    const sourcePackage = join(WORK_RDL_ROOT, materialId);
    const packageRoot = join(OUTPUT_ROOT, materialId);
    await mkdir(packageRoot);
    const [imageBytes, sourceSelection, sourceSelectionBytes] = await Promise.all([
      readFile(join(sourcePackage, "material_final.png")),
      json(join(sourcePackage, "selection_map.json")),
      readFile(join(sourcePackage, "selection_map.json")),
    ]);
    const imageHash = sha256(imageBytes);
    const dimensions = pngDimensions(imageBytes, materialId);
    const { map, audit } = convertSelection(sourceSelection, materialId, imageHash, dimensions);
    await cp(join(sourcePackage, "material_final.png"), join(packageRoot, "material_final.png"), { errorOnExist: true });
    assert(sha256(await readFile(join(packageRoot, "material_final.png"))) === imageHash, `${materialId}: PNG bytes changed in staging`);
    await writeJson(join(packageRoot, "selection_map.json"), map);
    const convertedSelectionBytes = await readFile(join(packageRoot, "selection_map.json"));
    const convertedSelectionHash = sha256(convertedSelectionBytes);
    const finalAsset = finalAssetById.get(materialId);
    assert(material.asset_status === "frozen_verified_selection_qa_pass", `${materialId}: incremental status is not accepted`);
    assert(finalAsset?.status === "FROZEN_SELECTION_QA_PASS", `${materialId}: final release status is not accepted`);
    const asset = {
      schema_version: "rdl-production-asset-v1",
      material_id: materialId,
      active_image: "material_final.png",
      active_selection: "selection_map.json",
      image_sha256: imageHash,
      selection_sha256: convertedSelectionHash,
      width: dimensions.width,
      height: dimensions.height,
      hd_status: "passed",
      final_status: "passed",
      selection_status: "passed",
      selection_image_sha256: imageHash,
      material_final: {
        file: "material_final.png",
        sha256: imageHash,
        frozen: true,
      },
      source_reference: {
        manifest: "RDL_WORK_INCREMENTAL_MANIFEST.local.json",
        canonical_asset_id: materialId,
      },
      release_acceptance: {
        manifest: "RDL_FINAL_RELEASE_MAP.local.json",
        status: finalAsset.status,
      },
    };
    try {
      const metadata = await json(join(sourcePackage, "metadata.json"));
      if (metadata.canonical_source && typeof metadata.canonical_source === "object") {
        asset.canonical_source = metadata.canonical_source;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeJson(join(packageRoot, "asset.json"), asset);
    await validateGenericAsset(packageRoot, asset);
    const files = (await readdir(packageRoot)).sort();
    assert(JSON.stringify(files) === JSON.stringify(["asset.json", "material_final.png", "selection_map.json"]), `${materialId}: staging bundle has non-contract files`);

    const parsedMap = parseRdlSelectionMap(map);
    assert(validateRdlImageBinding(parsedMap, {
      imageFile: "material_final.png",
      imageSha256: imageHash,
      naturalWidth: dimensions.width,
      naturalHeight: dimensions.height,
    }), `${materialId}: TPS parser image binding failed`);
    const interaction = runInteractionQa(materialId, parsedMap);
    conversionResults.push({
      material_id: materialId,
      source_selection_sha256: sha256(sourceSelectionBytes),
      converted_selection_sha256: convertedSelectionHash,
      image_sha256: imageHash,
      width: dimensions.width,
      height: dimensions.height,
      cloud_metadata_available: Object.hasOwn(asset, "canonical_source"),
      ...audit,
      tps_parser: "PASS",
      image_binding: "PASS",
      generic_asset_contract: "PASS",
      staging_bundle_contract: "PASS",
      ...interaction,
    });
  }

  const manifestRoot = join(OUTPUT_ROOT, "manifests");
  await mkdir(manifestRoot);
  for (const [filename, value] of [
    ["RDL_CURRENT_GLOBAL_MANIFEST.local.json", currentGlobal],
    ["RDL_WORK_INCREMENTAL_MANIFEST.local.json", incremental],
    ["RDL_FINAL_RELEASE_MAP.local.json", finalMap],
  ]) {
    const localized = localize(structuredClone(value));
    localized.selection_conversion = { ...CONVERSION_RECORD, converted_asset_count: 46 };
    await writeJson(join(manifestRoot, filename), localized);
  }

  const localizedFinal = await json(join(manifestRoot, "RDL_FINAL_RELEASE_MAP.local.json"));
  const occurrenceKeys = localizedFinal.occurrences.map((row) => {
    const range = row.question_range ?? {};
    return JSON.stringify([row.source_label, row.module, row.rdl_index, range.start, range.end]);
  });
  assert(new Set(occurrenceKeys).size === occurrenceKeys.length, "localized final map has duplicate occurrence slots");
  assert(!localizedFinal.occurrences.some((row) => String(row.canonical_asset_id).startsWith("RDL-CAND-")), "candidate ID used as occurrence material ID");
  assert(
    JSON.stringify(localizedFinal.canonical_summary.retired_ids) === JSON.stringify(["RDL-105", "RDL-109"]),
    "retired ID declaration changed during localization",
  );

  const report = {
    schema_version: "travel-rdl-local-staging-qa-v1",
    status: "PASS",
    source_root: WORK_RDL_ROOT,
    staging_root: OUTPUT_ROOT,
    material_count: conversionResults.length,
    bundle_count: ids.length,
    tps_parser_passed: conversionResults.filter((row) => row.tps_parser === "PASS").length,
    selection_conversion: CONVERSION_RECORD,
    asset_contract: {
      schema_version: "rdl-production-asset-v1",
      required_fields: GENERIC_REQUIRED_FIELDS,
      optional_authoritative_fields: ["canonical_source"],
      historical_recovery_fields_required: false,
    },
    cloud_metadata_available_count: conversionResults.filter((row) => row.cloud_metadata_available).length,
    cloud_metadata_missing_count: conversionResults.filter((row) => !row.cloud_metadata_available).length,
    invariants: {
      material_png_bytes_unchanged: "PASS",
      selection_schema_v2: "PASS",
      image_hash_binding: "PASS",
      canvas_dimensions: "PASS",
      line_word_character_counts: "PASS",
      visible_text_exactly_preserved: "PASS",
      character_text: "PASS",
      character_bbox_exact: "PASS",
      normalized_bbox_bounds: "PASS",
      forward_reverse_character_order: "PASS",
      interaction_whole_word: "PASS",
      interaction_partial_word: "PASS",
      interaction_multi_word: "PASS",
      interaction_cross_line: "PASS",
      interaction_reverse: "PASS",
      interaction_scaled_display: "PASS",
      retired_ids_absent_from_bundles: ![...RETIRED_IDS].some((id) => ids.includes(id)),
      occurrence_mapping_unique: new Set(occurrenceKeys).size === occurrenceKeys.length,
      candidate_ids_absent_from_occurrence_material_id: true,
    },
    materials: conversionResults,
  };
  await writeJson(join(OUTPUT_ROOT, "staging-qa-report.json"), report);
  console.log(JSON.stringify({
    status: report.status,
    staging_root: report.staging_root,
    bundle_count: report.bundle_count,
    tps_parser_passed: report.tps_parser_passed,
    cloud_metadata_available_count: report.cloud_metadata_available_count,
    cloud_metadata_missing_count: report.cloud_metadata_missing_count,
    invariants: report.invariants,
  }, null, 2));
}

await main();
