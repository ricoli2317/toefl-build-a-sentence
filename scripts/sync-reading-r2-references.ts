// Historical Batch 1B-R2 database-reference switch. Do not use this as the
// handoff path for future Reading assets.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { asReadingAssetObjectKey } from "../lib/reading/assets.ts";
import { validateRdlAssetManifest, type RdlAssetManifest } from "../lib/reading/r2Manifest.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";

const defaultManifestPath = "data/reading/r2/rdl-asset-manifest.json";

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const manifestPath = resolve(process.cwd(), argument(args, "--manifest") ?? defaultManifestPath);
  const manifest = validateRdlAssetManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  assertReleaseReady(manifest);

  const db = createServiceSupabase();
  const { data, error } = await db.from("reading_materials").select("*").order("material_id");
  if (error) throw new Error(`Read reading_materials: ${error.message}`);
  const rows = data ?? [];
  if (rows.length !== manifest.materialCount) {
    throw new Error(`Expected ${manifest.materialCount} database materials, found ${rows.length}`);
  }
  const manifestById = new Map(manifest.materials.map((material) => [material.materialId, material]));
  const databaseIds = new Set(rows.map((row) => String(row.material_id)));
  const missingInDatabase = manifest.materials.filter((material) => !databaseIds.has(material.materialId));
  const missingInManifest = rows.filter((row) => !manifestById.has(String(row.material_id)));
  if (missingInDatabase.length || missingInManifest.length) {
    throw new Error(
      `Material identity mismatch: database missing ${missingInDatabase.length}, manifest missing ${missingInManifest.length}`
    );
  }

  const updates = rows.map((row) => {
    const material = manifestById.get(String(row.material_id));
    if (!material) throw new Error(`${row.material_id}: missing manifest material`);
    return {
      material_id: row.material_id,
      title: row.title,
      source: row.source,
      source_date: row.source_date,
      year_month: row.year_month,
      binding_status: "bound",
      image_asset_path: asReadingAssetObjectKey(material.imageObjectKey),
      hitbox_data_path: asReadingAssetObjectKey(material.selectionMapObjectKey)
    };
  });
  const changed = updates.filter((row, index) =>
    row.image_asset_path !== rows[index].image_asset_path
    || row.hitbox_data_path !== rows[index].hitbox_data_path
  ).length;

  if (!write) {
    console.log(JSON.stringify({ valid: true, write: false, materialCount: rows.length, changed }, null, 2));
    return;
  }
  const { error: writeError } = await db.from("reading_materials").upsert(updates, {
    onConflict: "material_id"
  });
  if (writeError) throw new Error(`Update reading_materials: ${writeError.message}`);

  const { data: verified, error: verifyError } = await db
    .from("reading_materials")
    .select("material_id,image_asset_path,hitbox_data_path,binding_status")
    .order("material_id");
  if (verifyError) throw new Error(`Verify reading_materials: ${verifyError.message}`);
  for (const row of verified ?? []) {
    const material = manifestById.get(String(row.material_id));
    if (!material || row.binding_status !== "bound"
      || row.image_asset_path !== material.imageObjectKey
      || row.hitbox_data_path !== material.selectionMapObjectKey) {
      throw new Error(`${row.material_id}: database object-key verification failed`);
    }
  }
  console.log(JSON.stringify({ valid: true, write: true, materialCount: verified?.length ?? 0, changed }, null, 2));
}

function assertReleaseReady(manifest: RdlAssetManifest) {
  if (manifest.schemaVersion !== 1 || manifest.protocol !== "tps-reading-rdl-assets-v1") {
    throw new Error("Unsupported RDL production asset manifest");
  }
  if (manifest.publishStatus !== "verified") {
    throw new Error("RDL manifest has not completed the production release gate");
  }
  if (manifest.publication.checksumVerifiedCount !== manifest.objectCount
    || manifest.publication.contentTypeVerifiedCount !== manifest.objectCount
    || manifest.publication.cacheControlVerifiedCount !== manifest.objectCount
    || manifest.publication.publicRuntimeVerifiedCount !== manifest.objectCount
    || !manifest.publication.corsVerified) {
    throw new Error("RDL manifest remote/public verification is incomplete");
  }
  for (const material of manifest.materials) {
    asReadingAssetObjectKey(material.imageObjectKey);
    asReadingAssetObjectKey(material.selectionMapObjectKey);
    if (!material.remote) throw new Error(`${material.materialId}: remote verification is missing`);
  }
}

function argument(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
