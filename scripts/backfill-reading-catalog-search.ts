import { resolveReadingAssetUrl } from "../lib/reading/assets.ts";
import { buildReadingCatalogSearchText } from "../lib/reading/catalogSearchText.ts";
import { loadHistoricalReadingPackages } from "../lib/reading/historicalDedup.ts";
import { parseRdlSelectionMap } from "../lib/reading/rdlSelection.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";

async function main() {
  const write = process.argv.includes("--write");
  const db = createServiceSupabase();
  const { data: materials, error: materialError } = await db
    .from("reading_materials")
    .select("material_id,hitbox_data_path")
    .not("hitbox_data_path", "is", null)
    .order("material_id");
  if (materialError) throw new Error(`Read RDL materials: ${materialError.message}`);

  const materialText = new Map<string, string>();
  for (const material of materials ?? []) {
    const response = await fetch(resolveReadingAssetUrl(String(material.hitbox_data_path)), { cache: "no-store" });
    if (!response.ok) throw new Error(`${material.material_id}: selection map returned ${response.status}`);
    const selectionMap = parseRdlSelectionMap(await response.json());
    materialText.set(
      String(material.material_id),
      selectionMap.lines.map((line) => line.words.map((word) => word.text).join(" ")).join("\n")
    );
  }

  const packages = await loadHistoricalReadingPackages(db, ["ctw", "rdl", "rap"]);
  const itemUpdates = packages.map((packageData) => {
    const enriched = packageData.item.module === "rdl"
      ? {
          ...packageData,
          materials: packageData.materials.map((material) => ({
            ...material,
            catalogSearchText: materialText.get(material.materialId) ?? ""
          }))
        }
      : packageData;
    return {
      logical_item_id: packageData.item.logicalItemId,
      catalog_search_text: buildReadingCatalogSearchText(enriched)
    };
  });
  console.log(JSON.stringify({ write, materialCount: materialText.size, itemCount: itemUpdates.length }, null, 2));
  if (!write) return;

  for (const [materialId, catalogSearchText] of Array.from(materialText.entries())) {
    const { error } = await db
      .from("reading_materials")
      .update({ catalog_search_text: catalogSearchText })
      .eq("material_id", materialId);
    if (error) throw new Error(`Write RDL searchable text for ${materialId}: ${error.message}`);
  }
  for (const item of itemUpdates) {
    const { error } = await db
      .from("reading_logical_items")
      .update({ catalog_search_text: item.catalog_search_text })
      .eq("logical_item_id", item.logical_item_id);
    if (error) throw new Error(`Write Reading catalog searchable text for ${item.logical_item_id}: ${error.message}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
