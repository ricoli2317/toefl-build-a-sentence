#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { resolveReadingAssetUrl, readingRdlObjectKeys } from "../lib/reading/assets.ts";
import { READING_R2_CACHE_CONTROL, READING_R2_CORS_ORIGINS } from "../lib/reading/r2Manifest.ts";
import { parseRdlSelectionMap } from "../lib/reading/rdlSelection.ts";

const READING_ROOT = "/Users/rico/Desktop/真题/阅读";
const PRODUCTION_RDL = join(READING_ROOT, "production/rdl");
const MANIFEST_ROOT = join(READING_ROOT, "production/manifests");
const OUTPUT_ROOT = join(READING_ROOT, "_work/recovery/travel-rdl-r2-publish");
const INVENTORY_PATH = join(OUTPUT_ROOT, "r2-upload-inventory.json");
const DRY_RUN_PATH = join(OUTPUT_ROOT, "publish-dry-run-report.json");
const SQL_PATH = join(OUTPUT_ROOT, "register-travel-rdl-materials.sql");
const PUBLISH_REPORT_PATH = join(OUTPUT_ROOT, "r2-publish-report.json");
const POST_AUDIT_PATH = join(OUTPUT_ROOT, "r2-post-upload-audit.json");
const EXPECTED_IDS = [
  ...Array.from({ length: 18 }, (_, index) => `RDL-${String(87 + index).padStart(3, "0")}`),
  ...Array.from({ length: 3 }, (_, index) => `RDL-${String(106 + index).padStart(3, "0")}`),
  ...Array.from({ length: 25 }, (_, index) => `RDL-${String(110 + index).padStart(3, "0")}`),
];
const EXPECTED_ID_SET = new Set(EXPECTED_IDS);
const RETIRED_IDS = ["RDL-105", "RDL-109"];
const AUTHORITY_PATHS = [
  join(MANIFEST_ROOT, "material-index.json"),
  join(MANIFEST_ROOT, "selection-assets.json"),
  join(MANIFEST_ROOT, "canonical-catalog.json"),
  join(MANIFEST_ROOT, "RDL_FINAL_RELEASE_MAP.travel-local.json"),
];

function assert(value, message) {
  if (!value) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function normalizeContentType(value) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function isNotFound(error) {
  return error?.name === "NoSuchKey"
    || error?.name === "NotFound"
    || error?.$metadata?.httpStatusCode === 404;
}

async function mapConcurrent(values, concurrency, task) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index], index);
    }
  }));
  return results;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function fileHashes(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, sha256(await readFile(path))])));
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function localIntegrityGate(inventory) {
  const [materialIndex, selectionAssets] = await Promise.all([
    json(join(MANIFEST_ROOT, "material-index.json")),
    json(join(MANIFEST_ROOT, "selection-assets.json")),
  ]);
  const materialById = new Map(materialIndex.materials.map((row) => [row.asset_id, row]));
  const selectionById = new Map(selectionAssets.assets.map((row) => [row.asset_id, row]));
  const byId = new Map();
  for (const object of inventory) {
    const rows = byId.get(object.material_id) ?? [];
    rows.push(object);
    byId.set(object.material_id, rows);
  }
  const records = [];
  for (const id of EXPECTED_IDS) {
    const rows = byId.get(id) ?? [];
    assert(rows.length === 2, `${id}: inventory must contain exactly two objects`);
    const packageFiles = (await readdir(join(PRODUCTION_RDL, id))).sort();
    assert(sameRecord(packageFiles, ["asset.json", "material_final.png", "selection_map.json"]), `${id}: production bundle structure changed`);
    const material = materialById.get(id);
    const selectionAuthority = selectionById.get(id);
    assert(material && selectionAuthority, `${id}: formal authority row missing`);
    const [asset, imageBytes, selectionBytes] = await Promise.all([
      json(join(PRODUCTION_RDL, id, "asset.json")),
      readFile(join(PRODUCTION_RDL, id, "material_final.png")),
      readFile(join(PRODUCTION_RDL, id, "selection_map.json")),
    ]);
    const selectionJson = JSON.parse(selectionBytes.toString("utf8"));
    parseRdlSelectionMap(selectionJson);
    const imageSha = sha256(imageBytes);
    const selectionSha = sha256(selectionBytes);
    const keys = readingRdlObjectKeys(id);
    const imageInventory = rows.find((row) => row.file_type === "material_image");
    const selectionInventory = rows.find((row) => row.file_type === "selection_map");
    assert(imageInventory && selectionInventory, `${id}: inventory pair kind mismatch`);
    assert(imageInventory.object_key === keys.imageObjectKey, `${id}: image object key changed`);
    assert(selectionInventory.object_key === keys.selectionMapObjectKey, `${id}: selection object key changed`);
    assert(imageInventory.local_source_path === join(PRODUCTION_RDL, id, "material_final.png"), `${id}: image source path changed`);
    assert(selectionInventory.local_source_path === join(PRODUCTION_RDL, id, "selection_map.json"), `${id}: selection source path changed`);
    assert(imageInventory.local_sha256 === imageSha && imageInventory.size === imageBytes.length, `${id}: image differs from frozen inventory`);
    assert(selectionInventory.local_sha256 === selectionSha && selectionInventory.size === selectionBytes.length, `${id}: selection differs from frozen inventory`);
    assert(imageInventory.mime_type === "image/png" && selectionInventory.mime_type === "application/json", `${id}: inventory MIME mismatch`);
    assert(asset.material_id === id, `${id}: asset material_id mismatch`);
    assert(asset.active_image === "material_final.png" && asset.active_selection === "selection_map.json", `${id}: asset active file mismatch`);
    assert(asset.image_sha256 === imageSha, `${id}: asset image_sha256 mismatch`);
    assert(asset.selection_sha256 === selectionSha, `${id}: asset selection_sha256 mismatch`);
    assert(asset.selection_image_sha256 === imageSha, `${id}: asset selection_image_sha256 mismatch`);
    assert(selectionJson.schema_version === 2 && selectionJson.image_sha256 === imageSha, `${id}: selection image binding mismatch`);
    assert(selectionAuthority.sha256 === imageSha, `${id}: selection-assets image SHA mismatch`);
    assert(material.material_final === `production/rdl/${id}/material_final.png`, `${id}: material-index image path mismatch`);
    assert(material.selection_map === `production/rdl/${id}/selection_map.json`, `${id}: material-index selection path mismatch`);
    records.push({ material_id: id, status: "LOCAL_INTEGRITY_PASS", image_sha256: imageSha, selection_sha256: selectionSha, parser: "PASS" });
  }
  return records;
}

async function getRemote(client, bucket, object) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: object.object_key }));
    if (!response.Body) throw new Error("remote response has no body");
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    return {
      exists: true,
      bytes,
      sha256: sha256(bytes),
      size: bytes.length,
      content_type: normalizeContentType(response.ContentType),
      cache_control: response.CacheControl ?? null,
      sha256_metadata: response.Metadata?.sha256 ?? null,
      etag: response.ETag ?? null,
    };
  } catch (error) {
    if (isNotFound(error)) return { exists: false };
    throw error;
  }
}

function classifyRemote(object, remote) {
  if (!remote.exists) return { status: "REMOTE_MISSING", reason: "object not found" };
  const mismatches = [];
  if (remote.sha256 !== object.local_sha256) mismatches.push("bytes_sha256");
  if (remote.size !== object.size) mismatches.push("content_length");
  if (remote.content_type !== object.mime_type) mismatches.push("content_type");
  if (remote.cache_control !== READING_R2_CACHE_CONTROL) mismatches.push("cache_control");
  if (remote.sha256_metadata !== null && remote.sha256_metadata !== object.local_sha256) mismatches.push("sha256_metadata");
  if (mismatches.length) return { status: "REMOTE_DIFFERENT", reason: `mismatch: ${mismatches.join(",")}` };
  return { status: "REMOTE_IDENTICAL", reason: "downloaded bytes, size, MIME and cache-control match" };
}

async function auditOne(client, bucket, object) {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.object_key }));
    const remote = await getRemote(client, bucket, object);
    const classification = classifyRemote(object, remote);
    return {
      material_id: object.material_id,
      object_key: object.object_key,
      ...classification,
      local: { sha256: object.local_sha256, size: object.size, content_type: object.mime_type, cache_control: READING_R2_CACHE_CONTROL },
      remote: remote.exists ? {
        sha256: remote.sha256,
        size: remote.size,
        content_type: remote.content_type,
        cache_control: remote.cache_control,
        sha256_metadata: remote.sha256_metadata,
        etag: remote.etag ?? head.ETag ?? null,
      } : null,
    };
  } catch (error) {
    if (isNotFound(error)) {
      return { material_id: object.material_id, object_key: object.object_key, status: "REMOTE_MISSING", reason: "HeadObject returned not found" };
    }
    return {
      material_id: object.material_id,
      object_key: object.object_key,
      status: "REMOTE_UNVERIFIABLE",
      reason: `${error?.name ?? "Error"}: ${error?.message ?? "remote verification failed"}`,
    };
  }
}

function statusCounts(records) {
  const statuses = ["REMOTE_MISSING", "REMOTE_IDENTICAL", "REMOTE_DIFFERENT", "REMOTE_UNVERIFIABLE"];
  return Object.fromEntries(statuses.map((status) => [status, records.filter((row) => row.status === status).length]));
}

async function uploadMissingObject(client, bucket, object) {
  const bytes = await readFile(object.local_source_path);
  assert(bytes.length === object.size && sha256(bytes) === object.local_sha256, `${object.object_key}: local bytes changed before PUT`);
  const startedAt = new Date().toISOString();
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: object.object_key,
      Body: bytes,
      ContentType: object.mime_type,
      CacheControl: READING_R2_CACHE_CONTROL,
      Metadata: { sha256: object.local_sha256 },
      IfNoneMatch: "*",
    }));
  } catch (error) {
    const statusCode = error?.$metadata?.httpStatusCode;
    if (statusCode === 409 || statusCode === 412 || error?.name === "PreconditionFailed") {
      const remote = await getRemote(client, bucket, object);
      const classification = classifyRemote(object, remote);
      return {
        material_id: object.material_id,
        object_key: object.object_key,
        action: classification.status === "REMOTE_IDENTICAL" ? "SKIPPED_RACE_IDENTICAL" : "BLOCKED_CONDITIONAL_WRITE",
        immediate_verification: classification.status,
        error: `conditional PUT was not performed: ${error?.name ?? statusCode}`,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      };
    }
    return {
      material_id: object.material_id,
      object_key: object.object_key,
      action: "UPLOAD_FAILED",
      immediate_verification: "REMOTE_UNVERIFIABLE",
      error: `${error?.name ?? "Error"}: ${error?.message ?? "PUT failed"}`,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
  }
  const remote = await getRemote(client, bucket, object);
  const classification = classifyRemote(object, remote);
  return {
    material_id: object.material_id,
    object_key: object.object_key,
    action: "UPLOADED",
    immediate_verification: classification.status,
    local_sha256: object.local_sha256,
    remote_sha256: remote.sha256 ?? null,
    local_size: object.size,
    remote_size: remote.size ?? null,
    content_type: remote.content_type ?? null,
    cache_control: remote.cache_control ?? null,
    sha256_metadata: remote.sha256_metadata ?? null,
    error: classification.status === "REMOTE_IDENTICAL" ? null : classification.reason,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}

function pngIsValid(bytes) {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

async function publicVerify(object, baseUrl) {
  const url = resolveReadingAssetUrl(object.object_key, baseUrl);
  try {
    const response = await fetch(url, { cache: "no-store" });
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const actualSha = sha256(bytes);
    if (!response.ok) throw new Error(`GET returned ${response.status}`);
    if (actualSha !== object.local_sha256 || bytes.length !== object.size) throw new Error("public bytes differ from local inventory");
    if (contentType !== object.mime_type) throw new Error(`public Content-Type is ${contentType ?? "missing"}`);
    if (object.file_type === "material_image" && !pngIsValid(bytes)) throw new Error("public response is not a valid PNG signature");
    if (object.file_type === "selection_map") parseRdlSelectionMap(JSON.parse(bytes.toString("utf8")));
    return {
      material_id: object.material_id,
      object_key: object.object_key,
      url,
      status: "PASS",
      http_status: response.status,
      sha256: actualSha,
      size: bytes.length,
      content_type: contentType,
      cache_control: response.headers.get("cache-control"),
      tps_parser: object.file_type === "selection_map" ? "PASS" : null,
    };
  } catch (error) {
    return { material_id: object.material_id, object_key: object.object_key, url, status: "FAIL", error: error?.message ?? String(error) };
  }
}

async function corsVerify(object, baseUrl, origin) {
  const url = resolveReadingAssetUrl(object.object_key, baseUrl);
  try {
    const response = await fetch(url, { method: "GET", headers: { Origin: origin }, cache: "no-store" });
    const bytes = Buffer.from(await response.arrayBuffer());
    const allowedOrigin = response.headers.get("access-control-allow-origin");
    const allowed = allowedOrigin === "*" || allowedOrigin === origin;
    const bytesPass = response.ok && bytes.length === object.size && sha256(bytes) === object.local_sha256;
    if (object.file_type === "selection_map" && bytesPass) parseRdlSelectionMap(JSON.parse(bytes.toString("utf8")));
    return {
      origin,
      object_key: object.object_key,
      file_type: object.file_type,
      status: allowed && bytesPass ? "PASS" : "FAIL",
      http_status: response.status,
      access_control_allow_origin: allowedOrigin,
      bytes_verified: bytesPass,
    };
  } catch (error) {
    return { origin, object_key: object.object_key, file_type: object.file_type, status: "FAIL", error: error?.message ?? String(error) };
  }
}

async function retiredAudit(client, bucket) {
  const rows = [];
  for (const id of RETIRED_IDS) {
    const prefix = `reading/rdl/${id}/`;
    try {
      const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 10 }));
      const keys = (response.Contents ?? []).map((row) => row.Key).filter(Boolean);
      rows.push({ material_id: id, prefix, status: keys.length === 0 ? "ABSENT" : "PRESENT", object_keys: keys });
    } catch (error) {
      rows.push({ material_id: id, prefix, status: "UNVERIFIABLE", error: error?.message ?? String(error) });
    }
  }
  return rows;
}

async function corsPolicy(client, bucket) {
  try {
    const response = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
    return {
      status: "READ_PASS",
      rules: (response.CORSRules ?? []).map((rule) => ({
        allowed_origins: rule.AllowedOrigins ?? [],
        allowed_methods: rule.AllowedMethods ?? [],
        allowed_headers: rule.AllowedHeaders ?? [],
        expose_headers: rule.ExposeHeaders ?? [],
        max_age_seconds: rule.MaxAgeSeconds ?? null,
      })),
    };
  } catch (error) {
    return { status: "READ_UNAVAILABLE", error: `${error?.name ?? "Error"}: ${error?.message ?? "GetBucketCors failed"}` };
  }
}

async function readOnlyDatabaseAudit(expectedRows) {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { status: "UNAVAILABLE", target_count: null, counts: null, writes: 0 };
  }
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const fields = ["title", "material_type", "source", "source_date", "year_month", "binding_status", "image_asset_path", "hitbox_data_path"];
  const { data, error } = await db.from("reading_materials")
    .select(`material_id,${fields.join(",")}`)
    .in("material_id", EXPECTED_IDS)
    .order("material_id");
  if (error) return { status: "READ_FAILED", error: error.message, target_count: null, counts: null, writes: 0 };
  const current = new Map((data ?? []).map((row) => [row.material_id, row]));
  const records = expectedRows.map((expected) => {
    const existing = current.get(expected.material_id);
    if (!existing) return { material_id: expected.material_id, status: "DB_MISSING" };
    const differences = fields.filter((field) => (existing[field] ?? null) !== (expected[field] ?? null));
    return { material_id: expected.material_id, status: differences.length ? "DB_EXISTS_DIFFERENT" : "DB_EXISTS_SAME", differing_fields: differences };
  });
  return {
    status: "READ_ONLY_PASS",
    target_count: records.length,
    counts: Object.fromEntries(["DB_MISSING", "DB_EXISTS_SAME", "DB_EXISTS_DIFFERENT"].map((status) => [status, records.filter((row) => row.status === status).length])),
    writes: 0,
    records,
  };
}

function materialPairs(inventory, postAudit, publicRecords) {
  const remoteByKey = new Map(postAudit.map((row) => [row.object_key, row]));
  const publicByKey = new Map(publicRecords.map((row) => [row.object_key, row]));
  return EXPECTED_IDS.map((id) => {
    const rows = inventory.filter((row) => row.material_id === id);
    const image = rows.find((row) => row.file_type === "material_image");
    const selection = rows.find((row) => row.file_type === "selection_map");
    const imageRemote = remoteByKey.get(image.object_key)?.status === "REMOTE_IDENTICAL";
    const selectionRemote = remoteByKey.get(selection.object_key)?.status === "REMOTE_IDENTICAL";
    const imagePublic = publicByKey.get(image.object_key)?.status === "PASS";
    const selectionPublic = publicByKey.get(selection.object_key)?.status === "PASS";
    return {
      material_id: id,
      image_status: imageRemote ? "PUBLISHED_VERIFIED" : "FAIL",
      selection_status: selectionRemote ? "PUBLISHED_VERIFIED" : "FAIL",
      public_image_status: imagePublic ? "PASS" : "FAIL",
      public_selection_status: selectionPublic ? "PASS" : "FAIL",
      pair_status: imageRemote && selectionRemote && imagePublic && selectionPublic ? "R2_PAIR_VERIFIED" : "INCOMPLETE",
    };
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  const requiredEnv = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "READING_ASSET_BASE_URL"];
  const missingEnv = requiredEnv.filter((name) => !process.env[name]);
  assert(missingEnv.length === 0, `missing environment: ${missingEnv.join(", ")}`);
  const [inventoryPayload, dryRun, sqlBytes] = await Promise.all([
    json(INVENTORY_PATH),
    json(DRY_RUN_PATH),
    readFile(SQL_PATH),
  ]);
  const inventory = inventoryPayload.objects;
  assert(inventoryPayload.status === "DRY_RUN_ONLY", "inventory is not the approved dry-run inventory");
  assert(inventory.length === 92 && new Set(inventory.map((row) => row.object_key)).size === 92, "inventory must contain 92 unique keys");
  assert(EXPECTED_IDS.length === 46 && new Set(EXPECTED_IDS).size === 46, "expected material scope is invalid");
  assert(sameRecord([...new Set(inventory.map((row) => row.material_id))].sort(), [...EXPECTED_IDS].sort()), "inventory canonical scope changed");
  assert(inventory.every((row) => EXPECTED_ID_SET.has(row.material_id) && !RETIRED_IDS.includes(row.material_id)), "inventory includes historical or retired IDs");
  assert(inventory.every((row) => row.object_key === `reading/rdl/${row.material_id}/${row.file_type === "material_image" ? "material_final.png" : "selection_map.json"}`), "inventory object-key contract changed");

  const sqlShaBefore = sha256(sqlBytes);
  const authorityHashesBefore = await fileHashes(AUTHORITY_PATHS);
  const localIntegrity = await localIntegrityGate(inventory);
  const accountEndpoint = `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new S3Client({
    region: "auto",
    endpoint: accountEndpoint,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    maxAttempts: 1,
  });
  const bucket = process.env.R2_BUCKET_NAME;
  const preflightObjects = await mapConcurrent(inventory, 6, (object) => auditOne(client, bucket, object));
  const preflight = { counts: statusCounts(preflightObjects), objects: preflightObjects };
  const missingKeys = new Set(preflightObjects.filter((row) => row.status === "REMOTE_MISSING").map((row) => row.object_key));
  const blockers = preflightObjects.filter((row) => row.status === "REMOTE_DIFFERENT" || row.status === "REMOTE_UNVERIFIABLE");
  const uploadRecords = [];
  for (const object of inventory) {
    const preflightRow = preflightObjects.find((row) => row.object_key === object.object_key);
    if (preflightRow.status === "REMOTE_IDENTICAL") {
      uploadRecords.push({ material_id: object.material_id, object_key: object.object_key, action: "SKIPPED_IDENTICAL", immediate_verification: "REMOTE_IDENTICAL", error: null });
      continue;
    }
    if (!missingKeys.has(object.object_key)) {
      uploadRecords.push({ material_id: object.material_id, object_key: object.object_key, action: "BLOCKED_PREFLIGHT", immediate_verification: preflightRow.status, error: preflightRow.reason });
      continue;
    }
    uploadRecords.push(await uploadMissingObject(client, bucket, object));
  }

  const postObjects = await mapConcurrent(inventory, 6, (object) => auditOne(client, bucket, object));
  const postAudit = { counts: statusCounts(postObjects), objects: postObjects };
  const publicRecords = await mapConcurrent(inventory, 4, (object) => publicVerify(object, process.env.READING_ASSET_BASE_URL));
  const sampleImage = inventory.find((row) => row.file_type === "material_image");
  const sampleSelection = inventory.find((row) => row.file_type === "selection_map");
  const corsRecords = [];
  for (const origin of READING_R2_CORS_ORIGINS) {
    corsRecords.push(await corsVerify(sampleImage, process.env.READING_ASSET_BASE_URL, origin));
    corsRecords.push(await corsVerify(sampleSelection, process.env.READING_ASSET_BASE_URL, origin));
  }
  const pairs = materialPairs(inventory, postObjects, publicRecords);
  const [retired, bucketCors, database, authorityHashesAfter, sqlBytesAfter] = await Promise.all([
    retiredAudit(client, bucket),
    corsPolicy(client, bucket),
    readOnlyDatabaseAudit(dryRun.sql.expected_rows),
    fileHashes(AUTHORITY_PATHS),
    readFile(SQL_PATH),
  ]);
  const localIntegrityAfter = await localIntegrityGate(inventory);
  const sqlShaAfter = sha256(sqlBytesAfter);
  const publicPass = publicRecords.filter((row) => row.status === "PASS").length;
  const remoteParserPass = publicRecords.filter((row) => row.tps_parser === "PASS").length;
  const corsPass = corsRecords.every((row) => row.status === "PASS");
  const completePairs = pairs.filter((row) => row.pair_status === "R2_PAIR_VERIFIED").length;
  const uploaded = uploadRecords.filter((row) => row.action === "UPLOADED");
  const uploadedVerified = uploaded.filter((row) => row.immediate_verification === "REMOTE_IDENTICAL");
  const uploadedImages = uploadedVerified.filter((row) => row.object_key.endsWith("/material_final.png")).length;
  const uploadedSelections = uploadedVerified.filter((row) => row.object_key.endsWith("/selection_map.json")).length;
  const skipIdentical = uploadRecords.filter((row) => row.action === "SKIPPED_IDENTICAL" || row.action === "SKIPPED_RACE_IDENTICAL").length;
  const localUnchanged = sameRecord(authorityHashesBefore, authorityHashesAfter) && sqlShaBefore === sqlShaAfter
    && localIntegrityAfter.length === 46;
  const retiredPass = retired.every((row) => row.status === "ABSENT");
  const dbSafe = database.status === "READ_ONLY_PASS" && database.counts.DB_EXISTS_DIFFERENT === 0;
  const allPass = postAudit.counts.REMOTE_IDENTICAL === 92
    && postAudit.counts.REMOTE_MISSING === 0
    && postAudit.counts.REMOTE_DIFFERENT === 0
    && postAudit.counts.REMOTE_UNVERIFIABLE === 0
    && publicPass === 92
    && remoteParserPass === 46
    && corsPass
    && completePairs === 46
    && retiredPass
    && localUnchanged
    && dbSafe;
  const errors = [
    ...blockers.map((row) => ({ phase: "preflight", object_key: row.object_key, error: row.reason })),
    ...uploadRecords.filter((row) => row.error).map((row) => ({ phase: "upload", object_key: row.object_key, error: row.error })),
    ...postObjects.filter((row) => row.status !== "REMOTE_IDENTICAL").map((row) => ({ phase: "post_audit", object_key: row.object_key, error: row.reason })),
    ...publicRecords.filter((row) => row.status !== "PASS").map((row) => ({ phase: "public_runtime", object_key: row.object_key, error: row.error })),
    ...corsRecords.filter((row) => row.status !== "PASS").map((row) => ({ phase: "cors", object_key: row.object_key, origin: row.origin, error: row.error ?? "CORS response mismatch" })),
  ];

  const report = {
    schema_version: "travel-rdl-r2-publish-v1",
    status: allPass ? "PASS" : "BLOCKED",
    published_at: new Date().toISOString(),
    started_at: startedAt,
    bucket_identity: { bucket_name: bucket, endpoint_host: new URL(accountEndpoint).hostname, public_base_origin: new URL(process.env.READING_ASSET_BASE_URL).origin },
    scope: { material_ids: EXPECTED_IDS, material_count: 46, object_count: 92, historical_upload_count: 0, retired_ids: RETIRED_IDS },
    preflight: preflight.counts,
    publication: {
      actual_uploaded_objects: uploaded.length,
      uploaded_and_immediately_verified: uploadedVerified.length,
      skipped_identical: skipIdentical,
      uploaded_images: uploadedImages,
      uploaded_selection_maps: uploadedSelections,
      complete_pairs: completePairs,
      retries: 0,
      deletes: 0,
      historical_uploads: 0,
    },
    post_upload: postAudit.counts,
    verification: {
      remote_checksum_and_bytes: postAudit.counts.REMOTE_IDENTICAL,
      public_runtime_urls: publicPass,
      remote_tps_parser: remoteParserPass,
      cors: corsPass ? "PASS" : "FAIL",
      retired_invariant: retiredPass ? "PASS" : "FAIL",
      local_authorities_unchanged: localUnchanged,
      database_writes: 0,
      sql_executed: false,
      sql_sha256_before: sqlShaBefore,
      sql_sha256_after: sqlShaAfter,
      sql_still_directly_executable: allPass && dbSafe && sqlShaBefore === sqlShaAfter,
    },
    material_pairs: pairs,
    upload_records: uploadRecords,
    cors: { required_origins: [...READING_R2_CORS_ORIGINS], bucket_policy: bucketCors, runtime_checks: corsRecords },
    retired_remote_audit: retired,
    database_read_only_audit: database,
    local_integrity: { before: localIntegrity, after: localIntegrityAfter, authority_hashes_before: authorityHashesBefore, authority_hashes_after: authorityHashesAfter },
    errors,
    blockers: errors,
  };
  const postPayload = {
    schema_version: "travel-rdl-r2-post-upload-audit-v1",
    status: allPass ? "PASS" : "BLOCKED",
    audited_at: new Date().toISOString(),
    bucket_identity: report.bucket_identity,
    counts: postAudit.counts,
    objects: postObjects.map((row) => ({
      ...row,
      public_runtime: publicRecords.find((candidate) => candidate.object_key === row.object_key),
      pair_status: pairs.find((pair) => pair.material_id === row.material_id)?.pair_status,
    })),
    pairs,
    cors: report.cors,
    retired_remote_audit: retired,
    historical_upload_count: 0,
    database_writes: 0,
    sql_executed: false,
  };
  await writeJsonAtomic(POST_AUDIT_PATH, postPayload);
  await writeJsonAtomic(PUBLISH_REPORT_PATH, report);
  console.log(JSON.stringify({
    status: report.status,
    preflight: report.preflight,
    publication: report.publication,
    post_upload: report.post_upload,
    verification: report.verification,
    database: database.counts,
    errors: errors.length,
    reports: [PUBLISH_REPORT_PATH, POST_AUDIT_PATH],
  }, null, 2));
  if (!allPass) process.exitCode = 2;
}

await main();
