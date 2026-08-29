import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rdlMaterialTypeFromInstruction, type RdlMaterialType } from "../lib/reading/materialTypes.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";

type MaterialIndex = {
  materials?: Array<{
    asset_id?: unknown;
    occurrences?: Array<{ rdl_type?: unknown }>;
  }>;
};

async function main() {
  const args = process.argv.slice(2);
  const manifestArgument = argument(args, "--manifest");
  if (!manifestArgument) {
    throw new Error("Usage: backfill-rdl-material-types.ts --manifest <production/material-index.json> [--apply|--emit-sql]");
  }
  const apply = args.includes("--apply");
  const emitSql = args.includes("--emit-sql");
  if (apply && emitSql) throw new Error("Choose either --apply or --emit-sql");

  const manifestPath = resolve(process.cwd(), manifestArgument);
  const index = JSON.parse(await readFile(manifestPath, "utf8")) as MaterialIndex;
  const recovered = recoverMaterialTypes(index);

  if (emitSql) {
    console.log(recovered.map(({ materialId, materialType }) =>
      `    ('${materialId}', '${materialType}')`
    ).join(",\n"));
    return;
  }

  if (!apply) {
    console.log(JSON.stringify({
      valid: true,
      write: false,
      materialCount: recovered.length,
      materialTypes: Array.from(new Set(recovered.map((row) => row.materialType))).sort()
    }, null, 2));
    return;
  }

  const db = createServiceSupabase();
  const { data: current, error: readError } = await db
    .from("reading_materials")
    .select("material_id,material_type")
    .order("material_id");
  if (readError) throw new Error(`Read reading_materials: ${readError.message}`);

  const expectedIds = recovered.map((row) => row.materialId);
  const currentIds = (current ?? []).map((row) => String(row.material_id));
  const missingInDatabase = expectedIds.filter((id) => !currentIds.includes(id));
  const missingInManifest = currentIds.filter((id) => !expectedIds.includes(id));
  if (missingInDatabase.length || missingInManifest.length) {
    throw new Error(
      `Material identity mismatch: database missing ${missingInDatabase.join(", ") || "none"}; `
      + `manifest missing ${missingInManifest.join(", ") || "none"}`
    );
  }

  for (const row of recovered) {
    const { error } = await db
      .from("reading_materials")
      .update({ material_type: row.materialType })
      .eq("material_id", row.materialId);
    if (error) throw new Error(`Update ${row.materialId}: ${error.message}`);
  }

  const { data: verified, error: verifyError } = await db
    .from("reading_materials")
    .select("material_id,material_type")
    .order("material_id");
  if (verifyError) throw new Error(`Verify reading_materials: ${verifyError.message}`);
  const recoveredById = new Map(recovered.map((row) => [row.materialId, row.materialType]));
  const mismatches = (verified ?? []).filter((row) =>
    recoveredById.get(String(row.material_id)) !== row.material_type
  );
  if (mismatches.length) {
    throw new Error(`Material type verification failed: ${mismatches.map((row) => row.material_id).join(", ")}`);
  }
  console.log(JSON.stringify({ valid: true, write: true, materialCount: recovered.length }, null, 2));
}

export function recoverMaterialTypes(index: MaterialIndex) {
  if (!Array.isArray(index.materials) || index.materials.length === 0) {
    throw new Error("material-index contains no materials");
  }
  const seen = new Set<string>();
  return index.materials.map((material) => {
    const materialId = typeof material.asset_id === "string" ? material.asset_id.trim() : "";
    if (!/^RDL-\d{3}$/.test(materialId)) throw new Error(`Invalid material ID: ${materialId || "missing"}`);
    if (seen.has(materialId)) throw new Error(`Duplicate material ID: ${materialId}`);
    seen.add(materialId);
    const instructions = Array.from(new Set((material.occurrences ?? []).map((occurrence) => {
      if (typeof occurrence.rdl_type !== "string" || !occurrence.rdl_type.trim()) {
        throw new Error(`${materialId}: occurrence is missing rdl_type`);
      }
      return occurrence.rdl_type.normalize("NFKC").replace(/\s+/g, " ").trim();
    })));
    if (instructions.length !== 1) {
      throw new Error(`${materialId}: conflicting rdl_type values: ${instructions.join(" | ") || "none"}`);
    }
    const materialType = rdlMaterialTypeFromInstruction(instructions[0]);
    if (!materialType) throw new Error(`${materialId}: unsupported source instruction ${instructions[0]}`);
    return { materialId, materialType } satisfies { materialId: string; materialType: RdlMaterialType };
  }).sort((left, right) => left.materialId.localeCompare(right.materialId));
}

function argument(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1]?.endsWith("backfill-rdl-material-types.ts")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
