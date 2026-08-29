// Historical Batch 1B-R2 release verification. TPS runtime itself depends only
// on reading_materials references and lib/reading/assets.ts.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveReadingAssetUrl } from "../lib/reading/assets.ts";
import { validateRdlAssetManifest } from "../lib/reading/r2Manifest.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";

const specialMaterialIds = new Set(["RDL-003", "RDL-084", "RDL-085", "RDL-086"]);

async function main() {
  const manifestPath = resolve(
    process.cwd(),
    argument(process.argv.slice(2), "--manifest") ?? "data/reading/r2/rdl-asset-manifest.json"
  );
  const manifest = validateRdlAssetManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.publishStatus !== "verified") throw new Error("RDL asset manifest is not verified");
  const baseUrl = process.env.READING_ASSET_BASE_URL;
  if (!baseUrl) throw new Error("Missing READING_ASSET_BASE_URL");
  const db = createServiceSupabase();
  const { data, error } = await db
    .from("reading_materials")
    .select("material_id,image_asset_path,hitbox_data_path,binding_status")
    .order("material_id");
  if (error) throw new Error(`Read reading_materials: ${error.message}`);
  if (data?.length !== manifest.materialCount) {
    throw new Error(`Expected ${manifest.materialCount} database materials, found ${data?.length ?? 0}`);
  }
  const manifestById = new Map(manifest.materials.map((material) => [material.materialId, material]));
  const verifiedSpecial: string[] = [];

  await mapWithConcurrency(data, 6, async (row) => {
    const material = manifestById.get(String(row.material_id));
    if (!material) throw new Error(`${row.material_id}: missing production manifest entry`);
    if (row.binding_status !== "bound"
      || row.image_asset_path !== material.imageObjectKey
      || row.hitbox_data_path !== material.selectionMapObjectKey) {
      throw new Error(`${row.material_id}: database does not contain manifest object keys`);
    }
    const [image, selection] = await Promise.all([
      getVerified(resolveReadingAssetUrl(row.image_asset_path, baseUrl), "image/png", material.imageSha256),
      getVerified(
        resolveReadingAssetUrl(row.hitbox_data_path, baseUrl),
        "application/json",
        material.selectionMapSha256
      )
    ]);
    const map = JSON.parse(new TextDecoder().decode(selection)) as { image_sha256?: string };
    if (map.image_sha256 !== material.selectionBinding.selectionImageSha256) {
      throw new Error(`${row.material_id}: selection-map frozen image binding changed`);
    }
    if (material.selectionBinding.status === "exact_image_sha256"
      && map.image_sha256 !== createHash("sha256").update(image).digest("hex")) {
      throw new Error(`${row.material_id}: exact selection binding does not match runtime image`);
    }
    if (specialMaterialIds.has(String(row.material_id))) verifiedSpecial.push(String(row.material_id));
  });

  console.log(JSON.stringify({
    valid: true,
    databaseMaterialCount: data.length,
    imageUrlVerifiedCount: data.length,
    selectionMapUrlVerifiedCount: data.length,
    specialMaterialsVerified: verifiedSpecial.sort()
  }, null, 2));
}

async function getVerified(url: string, expectedContentType: string, expectedSha256: string) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: GET returned ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== expectedContentType) throw new Error(`${url}: incorrect Content-Type`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error(`${url}: runtime checksum mismatch`);
  return bytes;
}

function argument(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function mapWithConcurrency<T>(values: T[], concurrency: number, task: (value: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await task(values[index]);
    }
  }));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
