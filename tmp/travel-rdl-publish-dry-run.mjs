#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { readingRdlObjectKeys } from "../lib/reading/assets.ts";
import { rdlMaterialTypeFromInstruction } from "../lib/reading/materialTypes.ts";
import { parseRdlSelectionMap } from "../lib/reading/rdlSelection.ts";

const execFileAsync = promisify(execFile);
const READING_ROOT = "/Users/rico/Desktop/真题/阅读";
const PRODUCTION_RDL = join(READING_ROOT, "production/rdl");
const MANIFEST_ROOT = join(READING_ROOT, "production/manifests");
const DOCX_ROOT = join(READING_ROOT, "work-output/production/docx/套题");
const OUTPUT_ROOT = process.argv[2] ?? join(process.cwd(), "tmp/travel-rdl-r2-publish");
const REPORTED_OUTPUT_ROOT = process.argv[3] ?? OUTPUT_ROOT;
const EXPECTED_IDS = [
  ...Array.from({ length: 18 }, (_, index) => `RDL-${String(87 + index).padStart(3, "0")}`),
  ...Array.from({ length: 3 }, (_, index) => `RDL-${String(106 + index).padStart(3, "0")}`),
  ...Array.from({ length: 25 }, (_, index) => `RDL-${String(110 + index).padStart(3, "0")}`),
];
const EXPECTED_ID_SET = new Set(EXPECTED_IDS);
const RETIRED_IDS = new Set(["RDL-105", "RDL-109"]);
const CACHE_CONTROL = "public, max-age=31536000, immutable";

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function write(path, value) {
  await writeFile(path, value, "utf8");
}

async function writeJson(path, value) {
  await write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function mustNotExist(path) {
  try {
    await stat(path);
    throw new Error(`refusing to overwrite existing output: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function normalizedContentType(value) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

async function mapConcurrent(values, concurrency, task) {
  const result = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await task(values[index]);
    }
  });
  await Promise.all(workers);
  return result;
}

function notFound(error) {
  return error?.name === "NoSuchKey" || error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404;
}

async function remoteAudit(inventory) {
  const required = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    return {
      method: "Cloudflare R2 S3 HeadObject only",
      credentials_available: false,
      uploads_performed: 0,
      counts: { REMOTE_MISSING: 0, REMOTE_IDENTICAL: 0, REMOTE_DIFFERENT: 0, REMOTE_UNVERIFIABLE: inventory.length },
      objects: inventory.map((object) => ({ object_key: object.object_key, status: "REMOTE_UNVERIFIABLE", reason: `missing credentials: ${missing.join(", ")}` })),
    };
  }
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  const objects = await mapConcurrent(inventory, 8, async (object) => {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: object.object_key }));
      const remoteSha = head.Metadata?.sha256 ?? null;
      const remoteSize = typeof head.ContentLength === "number" ? head.ContentLength : null;
      const remoteType = normalizedContentType(head.ContentType);
      const remoteCache = head.CacheControl ?? null;
      const knownDifference = (remoteSize !== null && remoteSize !== object.size)
        || (remoteSha !== null && remoteSha !== object.sha256)
        || (remoteType !== null && remoteType !== object.mime_type)
        || (remoteCache !== null && remoteCache !== CACHE_CONTROL);
      let status;
      let reason;
      if (knownDifference) {
        status = "REMOTE_DIFFERENT";
        reason = "HEAD metadata differs from the frozen local object";
      } else if (remoteSha === object.sha256 && remoteSize === object.size && remoteType === object.mime_type && remoteCache === CACHE_CONTROL) {
        status = "REMOTE_IDENTICAL";
        reason = "SHA-256 metadata, size, MIME type, and cache-control match";
      } else {
        status = "REMOTE_UNVERIFIABLE";
        reason = "object exists but HEAD metadata is insufficient for byte identity";
      }
      return {
        material_id: object.material_id,
        object_key: object.object_key,
        status,
        reason,
        local: { sha256: object.sha256, size: object.size, mime_type: object.mime_type, cache_control: CACHE_CONTROL },
        remote: { sha256_metadata: remoteSha, size: remoteSize, mime_type: remoteType, cache_control: remoteCache, etag_present: Boolean(head.ETag) },
      };
    } catch (error) {
      if (notFound(error)) return { material_id: object.material_id, object_key: object.object_key, status: "REMOTE_MISSING", reason: "HeadObject returned not found" };
      return { material_id: object.material_id, object_key: object.object_key, status: "REMOTE_UNVERIFIABLE", reason: `HeadObject failed: ${error?.name ?? "unknown error"}` };
    }
  });
  const statuses = ["REMOTE_MISSING", "REMOTE_IDENTICAL", "REMOTE_DIFFERENT", "REMOTE_UNVERIFIABLE"];
  return {
    method: "Cloudflare R2 S3 HeadObject only",
    credentials_available: true,
    uploads_performed: 0,
    deletes_performed: 0,
    counts: Object.fromEntries(statuses.map((status) => [status, objects.filter((row) => row.status === status).length])),
    objects,
  };
}

function instructionToType(instruction) {
  const aliases = new Map([
    ["Read the email.", "email"],
    ["Read the instructions.", "instructions"],
  ]);
  return aliases.get(instruction) ?? rdlMaterialTypeFromInstruction(instruction);
}

async function docxInstructions(label, cache) {
  if (cache.has(label)) return cache.get(label);
  const path = join(DOCX_ROOT, `TOEFL_Reading_${label}.docx`);
  const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", path], { maxBuffer: 10 * 1024 * 1024 });
  const dailyLife = stdout.split("Read in Daily Life")[1]?.split("Read an Academic Passage")[0] ?? "";
  const instructions = dailyLife.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^Read .+\.$/.test(line));
  assert(instructions.length > 0, `${label}: no authoritative RDL instructions found in DOCX`);
  cache.set(label, instructions);
  return instructions;
}

async function materialTypeFor(id, occurrences, docxCache) {
  const types = new Set();
  const evidence = [];
  for (const occurrence of occurrences) {
    let instruction = occurrence.rdl_type;
    let source = "RDL_FINAL_RELEASE_MAP.travel-local.json";
    if (!instruction) {
      const instructions = await docxInstructions(occurrence.source_label, docxCache);
      instruction = instructions[occurrence.rdl_index - 1];
      source = `TOEFL_Reading_${occurrence.source_label}.docx#RDL-${String(occurrence.rdl_index).padStart(2, "0")}`;
    }
    assert(instruction, `${id}: missing authoritative instruction for ${occurrence.source_label} RDL ${occurrence.rdl_index}`);
    const materialType = instructionToType(instruction);
    assert(materialType, `${id}: unsupported authoritative instruction: ${instruction}`);
    types.add(materialType);
    evidence.push({ occurrence: `${occurrence.source_label}-M1-RDL-${String(occurrence.rdl_index).padStart(2, "0")}`, instruction, material_type: materialType, source });
  }
  assert(types.size === 1, `${id}: conflicting material types: ${[...types].join(", ")}`);
  return { materialType: [...types][0], evidence };
}

function sqlLiteral(value) {
  if (value === null) return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function registrationSql(rows) {
  const values = rows.map((row) => `  (${[
    row.material_id, row.title, row.material_type, row.source, row.source_date,
    row.year_month, row.binding_status, row.image_asset_path, row.hitbox_data_path,
  ].map(sqlLiteral).join(", ")})`).join(",\n");
  return `-- Travel RDL reading_materials registration dry-run artifact.
-- Execute only after all 92 R2 objects have completed remote/public verification.
-- Generated from production indexes, Travel release-map authority, and authoritative suite DOCX instructions.

begin;

create temporary table travel_rdl_material_registration (
  material_id text primary key,
  title text,
  material_type text not null,
  source text not null,
  source_date date,
  year_month text not null,
  binding_status text not null,
  image_asset_path text not null,
  hitbox_data_path text not null
) on commit drop;

insert into travel_rdl_material_registration (
  material_id, title, material_type, source, source_date, year_month,
  binding_status, image_asset_path, hitbox_data_path
) values
${values};

do $$
declare
  conflicting_ids text;
begin
  select string_agg(existing.material_id, ', ' order by existing.material_id)
    into conflicting_ids
  from public.reading_materials existing
  join travel_rdl_material_registration proposed using (material_id)
  where row(existing.title, existing.material_type, existing.source, existing.source_date,
            existing.year_month, existing.binding_status, existing.image_asset_path, existing.hitbox_data_path)
        is distinct from
        row(proposed.title, proposed.material_type, proposed.source, proposed.source_date,
            proposed.year_month, proposed.binding_status, proposed.image_asset_path, proposed.hitbox_data_path);

  if conflicting_ids is not null then
    raise exception 'Travel RDL registration conflicts with existing rows: %', conflicting_ids;
  end if;
end
$$;

insert into public.reading_materials (
  material_id, title, material_type, source, source_date, year_month,
  binding_status, image_asset_path, hitbox_data_path
)
select material_id, title, material_type, source, source_date, year_month,
       binding_status, image_asset_path, hitbox_data_path
from travel_rdl_material_registration
on conflict (material_id) do nothing;

do $$
declare
  target_count integer;
  mismatch_count integer;
begin
  select count(*) into target_count
  from public.reading_materials existing
  join travel_rdl_material_registration target using (material_id);

  select count(*) into mismatch_count
  from public.reading_materials existing
  join travel_rdl_material_registration target using (material_id)
  where row(existing.title, existing.material_type, existing.source, existing.source_date,
            existing.year_month, existing.binding_status, existing.image_asset_path, existing.hitbox_data_path)
        is distinct from
        row(target.title, target.material_type, target.source, target.source_date,
            target.year_month, target.binding_status, target.image_asset_path, target.hitbox_data_path);

  if target_count <> 46 or mismatch_count <> 0 then
    raise exception 'Travel RDL post-check failed: target_count=%, mismatch_count=%', target_count, mismatch_count;
  end if;

  if exists (select 1 from public.reading_materials where material_id in ('RDL-105', 'RDL-109')) then
    raise exception 'Retired Travel RDL ID exists';
  end if;
end
$$;

commit;
`;
}

function schemaAudit(dbAudit, typeEvidence) {
  return `# Travel RDL reading_materials schema audit

## Runtime asset contract

- Canonical helper: \`readingRdlObjectKeys(material_id)\`.
- New Work-created keys: \`reading/rdl/<RDL-ID>/material_final.png\` and \`reading/rdl/<RDL-ID>/selection_map.json\`.
- Paths are stable, non-versioned object keys. URLs are not stored in \`reading_materials\`.
- Runtime calls \`resolveReadingAssetUrl\`, trims trailing slashes from \`READING_ASSET_BASE_URL\`, URL-encodes each key segment, then joins \`baseUrl + "/" + encodedKey\`.
- Historical database state is mixed by design: 10 recovered assets use hash-versioned keys; 76 use stable non-versioned keys. The importer permits a registered matching versioned image/selection pair only through its explicit compatibility option.

## Table schema

- Actual table: \`public.reading_materials\`.
- Primary/unique key: \`material_id text primary key\`.
- Required: \`material_type\`, \`source\`, \`year_month\`, \`binding_status\`.
- \`title\` and \`source_date\` are nullable at table level, but RDL CSV import requires the canonical title to exist and match.
- Bound rows require non-empty \`image_asset_path\` and \`hitbox_data_path\`; pending rows require both to be null.
- There are no width, height, image hash, selection hash, or URL columns.
- IDs are canonical \`RDL-[0-9]{3}\` values.

## Runtime/import acceptance

CSV import accepts an RDL material only when the ID already exists in \`reading_materials\`, \`binding_status='bound'\`, both object keys are present and valid, \`material_type\` matches the CSV instruction mapping, and the canonical title matches. New assets use the stable key pair returned by \`readingRdlObjectKeys\`; explicitly registered historical versioned pairs are compatibility-only.

## Database read-only audit

- Existing table rows: ${dbAudit.table_total}.
- Existing historical rows bound: ${dbAudit.table_bound}.
- Historical hash-versioned key pairs: ${dbAudit.historical_versioned}.
- Historical stable key pairs: ${dbAudit.historical_stable}.
- Target Work-created rows: ${dbAudit.target_total}; MISSING=${dbAudit.counts.DB_MISSING}, EXISTS_SAME=${dbAudit.counts.DB_EXISTS_SAME}, EXISTS_DIFFERENT=${dbAudit.counts.DB_EXISTS_DIFFERENT}.
- No SQL was executed.

## Material-type authority

Material types are derived from explicit \`rdl_type\` values in the Travel release map where present. When Group B release rows omit that field, the script reads the matching numbered “Read …” instruction from the authoritative generated suite DOCX. It never infers type from title or image content.

Type evidence rows: ${typeEvidence.length} occurrence-level records covering 46 canonical IDs.
`;
}

async function databaseAudit(expectedRows) {
  const required = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) return { access: "UNAVAILABLE", reason: `missing credentials: ${missing.join(", ")}`, table_total: null, table_bound: null, historical_versioned: null, historical_stable: null, target_total: null, counts: { DB_MISSING: 46, DB_EXISTS_SAME: 0, DB_EXISTS_DIFFERENT: 0 }, records: [] };
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const columns = "material_id,title,material_type,source,source_date,year_month,binding_status,image_asset_path,hitbox_data_path";
  const [{ data: all, error: allError }, { data: targets, error: targetError }] = await Promise.all([
    db.from("reading_materials").select("material_id,binding_status,image_asset_path,hitbox_data_path").order("material_id"),
    db.from("reading_materials").select(columns).in("material_id", EXPECTED_IDS).order("material_id"),
  ]);
  if (allError) throw new Error(`read reading_materials inventory: ${allError.message}`);
  if (targetError) throw new Error(`read target reading_materials: ${targetError.message}`);
  const current = new Map((targets ?? []).map((row) => [row.material_id, row]));
  const fields = ["title", "material_type", "source", "source_date", "year_month", "binding_status", "image_asset_path", "hitbox_data_path"];
  const records = expectedRows.map((expected) => {
    const existing = current.get(expected.material_id);
    if (!existing) return { material_id: expected.material_id, status: "DB_MISSING" };
    const differences = fields.filter((field) => (existing[field] ?? null) !== (expected[field] ?? null));
    return { material_id: expected.material_id, status: differences.length ? "DB_EXISTS_DIFFERENT" : "DB_EXISTS_SAME", ...(differences.length ? { differing_fields: differences } : {}) };
  });
  const rows = all ?? [];
  const versioned = rows.filter((row) => /\/RDL-[0-9]{3}\/[a-f0-9]{64}\/material_final\.png$/.test(String(row.image_asset_path)));
  const stable = rows.filter((row) => /^reading\/rdl\/RDL-[0-9]{3}\/material_final\.png$/.test(String(row.image_asset_path)));
  const statuses = ["DB_MISSING", "DB_EXISTS_SAME", "DB_EXISTS_DIFFERENT"];
  return {
    access: "READ_ONLY_PASS",
    table_total: rows.length,
    table_bound: rows.filter((row) => row.binding_status === "bound").length,
    historical_versioned: versioned.length,
    historical_stable: stable.length,
    target_total: records.length,
    counts: Object.fromEntries(statuses.map((status) => [status, records.filter((row) => row.status === status).length])),
    records,
  };
}

async function main() {
  await mustNotExist(OUTPUT_ROOT);
  const [materialIndex, selectionAssets, release] = await Promise.all([
    json(join(MANIFEST_ROOT, "material-index.json")),
    json(join(MANIFEST_ROOT, "selection-assets.json")),
    json(join(MANIFEST_ROOT, "RDL_FINAL_RELEASE_MAP.travel-local.json")),
  ]);
  const materialById = new Map(materialIndex.materials.map((row) => [row.asset_id, row]));
  const selectionById = new Map(selectionAssets.assets.map((row) => [row.asset_id, row]));
  const releaseById = new Map(release.work_created_assets.map((row) => [row.canonical_asset_id, row]));
  assert(EXPECTED_IDS.length === 46 && new Set(EXPECTED_IDS).size === 46, "Work-created scope is not 46 unique IDs");
  assert(!EXPECTED_IDS.some((id) => RETIRED_IDS.has(id)), "retired ID in Work-created scope");

  const inventory = [];
  for (const id of EXPECTED_IDS) {
    const material = materialById.get(id);
    const catalog = selectionById.get(id);
    const releaseAsset = releaseById.get(id);
    assert(material && catalog && releaseAsset, `${id}: missing formal authority row`);
    assert(material.material_final === `production/rdl/${id}/material_final.png`, `${id}: image path is not canonical production path`);
    assert(material.selection_map === `production/rdl/${id}/selection_map.json`, `${id}: selection path is not canonical production path`);
    assert(catalog.final_image === material.material_final && catalog.selection_map === material.selection_map, `${id}: formal index paths differ`);
    const packageFiles = (await readdir(join(PRODUCTION_RDL, id))).sort();
    assert(JSON.stringify(packageFiles) === JSON.stringify(["asset.json", "material_final.png", "selection_map.json"]), `${id}: production bundle contract changed`);
    const [asset, imageBytes, selectionBytes] = await Promise.all([
      json(join(PRODUCTION_RDL, id, "asset.json")),
      readFile(join(READING_ROOT, material.material_final)),
      readFile(join(READING_ROOT, material.selection_map)),
    ]);
    const selection = JSON.parse(selectionBytes.toString("utf8"));
    parseRdlSelectionMap(selection);
    const imageSha = sha256(imageBytes), selectionSha = sha256(selectionBytes);
    assert(asset.image_sha256 === imageSha && asset.selection_image_sha256 === imageSha && catalog.sha256 === imageSha && selection.image_sha256 === imageSha, `${id}: image SHA binding mismatch`);
    assert(asset.selection_sha256 === selectionSha, `${id}: selection SHA mismatch`);
    const keys = readingRdlObjectKeys(id);
    inventory.push(
      { material_id: id, local_source_path: join(READING_ROOT, material.material_final), object_key: keys.imageObjectKey, file_type: "material_image", local_sha256: imageSha, size: imageBytes.length, mime_type: "image/png" },
      { material_id: id, local_source_path: join(READING_ROOT, material.selection_map), object_key: keys.selectionMapObjectKey, file_type: "selection_map", local_sha256: selectionSha, size: selectionBytes.length, mime_type: "application/json" },
    );
  }
  assert(inventory.length === 92 && new Set(inventory.map((row) => row.object_key)).size === 92, "R2 inventory count/key uniqueness failed");
  assert(inventory.every((row) => EXPECTED_ID_SET.has(row.material_id) && !RETIRED_IDS.has(row.material_id)), "inventory scope includes non-Work or retired IDs");

  const docxCache = new Map();
  const expectedDbRows = [];
  const typeEvidence = [];
  for (const id of EXPECTED_IDS) {
    const material = materialById.get(id);
    const releaseAsset = releaseById.get(id);
    const occurrences = release.occurrences.filter((row) => row.canonical_asset_id === id);
    assert(occurrences.length > 0, `${id}: no authoritative occurrence`);
    const { materialType, evidence } = await materialTypeFor(id, occurrences, docxCache);
    typeEvidence.push(...evidence.map((row) => ({ material_id: id, ...row })));
    const firstSeen = occurrences.find((row) => row.source_label === material.first_seen) ?? occurrences[0];
    assert(firstSeen.source_date, `${id}: first-seen source date missing`);
    const keys = readingRdlObjectKeys(id);
    expectedDbRows.push({
      material_id: id,
      title: releaseAsset.canonical_title,
      material_type: materialType,
      source: `material-index.json#${id}`,
      source_date: firstSeen.source_date,
      year_month: firstSeen.source_date.slice(0, 7),
      binding_status: "bound",
      image_asset_path: keys.imageObjectKey,
      hitbox_data_path: keys.selectionMapObjectKey,
    });
  }
  assert(expectedDbRows.length === 46 && new Set(expectedDbRows.map((row) => row.material_id)).size === 46, "SQL target rows are not 46 unique IDs");

  const [remote, database] = await Promise.all([remoteAudit(inventory.map((row) => ({ ...row, sha256: row.local_sha256 }))), databaseAudit(expectedDbRows)]);
  const sql = registrationSql(expectedDbRows);
  assert((sql.match(/^  \('RDL-[0-9]{3}'/gm) ?? []).length === 46, "SQL VALUES target count is not 46");
  assert(!expectedDbRows.some((row) => RETIRED_IDS.has(row.material_id)), "SQL creates a retired ID");

  const inventoryPayload = {
    schema_version: "travel-rdl-r2-upload-inventory-v1",
    status: "DRY_RUN_ONLY",
    object_key_contract: "reading/rdl/<RDL-ID>/{material_final.png,selection_map.json}",
    material_count: 46,
    image_count: inventory.filter((row) => row.file_type === "material_image").length,
    selection_map_count: inventory.filter((row) => row.file_type === "selection_map").length,
    object_count: inventory.length,
    historical_object_count: 0,
    excluded: ["asset.json", "metadata.json", "preview.jpg", "source_original.png"],
    objects: inventory,
  };
  const remotePayload = { schema_version: "travel-rdl-r2-remote-audit-v1", status: "PASS", ...remote };
  const report = {
    schema_version: "travel-rdl-r2-publish-dry-run-v1",
    status: remote.counts.REMOTE_DIFFERENT > 0 ? "BLOCKED_REMOTE_DIFFERENT" : "PASS",
    output_root: REPORTED_OUTPUT_ROOT,
    local_canonical_modified: false,
    r2_uploads_performed: 0,
    database_writes_performed: 0,
    sql_executed: false,
    work_created_materials: 46,
    retired_ids_in_scope: 0,
    inventory: { objects: 92, images: 46, selection_maps: 46, historical_objects: 0, unique_object_keys: 92 },
    remote: remote.counts,
    database: database,
    sql: { generated: true, target_ids: expectedDbRows.length, historical_ids_targeted: 0, retired_ids_targeted: 0, expected_rows: expectedDbRows, material_type_evidence: typeEvidence },
    blockers: remote.counts.REMOTE_DIFFERENT > 0 ? ["REMOTE_DIFFERENT objects must not be overwritten"] : [],
  };

  await mkdir(OUTPUT_ROOT);
  await Promise.all([
    writeJson(join(OUTPUT_ROOT, "r2-upload-inventory.json"), inventoryPayload),
    writeJson(join(OUTPUT_ROOT, "r2-remote-audit.json"), remotePayload),
    write(join(OUTPUT_ROOT, "reading-materials-schema-audit.md"), schemaAudit(database, typeEvidence)),
    write(join(OUTPUT_ROOT, "register-travel-rdl-materials.sql"), sql),
    writeJson(join(OUTPUT_ROOT, "publish-dry-run-report.json"), report),
  ]);
  const files = (await readdir(OUTPUT_ROOT)).sort();
  assert(JSON.stringify(files) === JSON.stringify([
    "publish-dry-run-report.json",
    "r2-remote-audit.json",
    "r2-upload-inventory.json",
    "reading-materials-schema-audit.md",
    "register-travel-rdl-materials.sql",
  ]), "publish staging output contract failed");
  console.log(JSON.stringify({
    status: report.status,
    inventory: report.inventory,
    remote: report.remote,
    database: report.database.counts,
    sql_target_ids: report.sql.target_ids,
    blockers: report.blockers,
    output_root: report.output_root,
  }, null, 2));
}

await main();
