import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildReadingCatalogPayload, type ReadingCatalogItemRow } from "../lib/reading/catalog.ts";
import { assertCanonicalRdlTitle } from "../lib/reading/rdlTitles.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";

type AuditRow = {
  material_id: string;
  current_title: string;
  previous_title?: string;
  new_title: string;
};

type MaterialRow = { material_id: string; title: string | null };
type QuestionMaterialRow = { logical_item_id: string; material_id: string | null };

async function main() {
  const apply = process.argv.includes("--apply");
  const audit = JSON.parse(await readFile(
    resolve(process.cwd(), "data/reading/reports/rdl-title-audit.json"),
    "utf8"
  )) as { materials?: AuditRow[] };
  const auditRows = audit.materials ?? [];
  const targetByMaterialId = new Map(auditRows.map((row) => [row.material_id, row.new_title]));
  if (targetByMaterialId.size !== 86) throw new Error(`Expected 86 audited RDL materials; received ${targetByMaterialId.size}`);
  for (const row of auditRows) assertCanonicalRdlTitle(row.new_title, `audit title for ${row.material_id}`);

  const before = await loadSnapshot();
  verifyKnownMaterialInventory(before.materials, auditRows);
  const targetByLogicalItemId = logicalTargets(before.questions, targetByMaterialId);
  if (targetByLogicalItemId.size !== before.rdlItems.length) {
    throw new Error(`RDL logical mapping is incomplete: ${targetByLogicalItemId.size}/${before.rdlItems.length}`);
  }

  let materialUpdates = 0;
  let logicalUpdates = 0;
  if (apply) {
    const db = createServiceSupabase();
    for (const material of before.materials) {
      const title = targetByMaterialId.get(material.material_id)!;
      if (material.title === title) continue;
      const { error } = await db.from("reading_materials")
        .update({ title })
        .eq("material_id", material.material_id);
      if (error) throw new Error(`Update material ${material.material_id}: ${error.message}`);
      materialUpdates += 1;
    }
    for (const item of before.rdlItems) {
      const title = targetByLogicalItemId.get(item.logical_item_id)!;
      if (item.title === title) continue;
      const { error } = await db.from("reading_logical_items")
        .update({ title })
        .eq("logical_item_id", item.logical_item_id)
        .eq("module", "rdl");
      if (error) throw new Error(`Update logical item ${item.logical_item_id}: ${error.message}`);
      logicalUpdates += 1;
    }
  }

  const after = apply ? await loadSnapshot() : before;
  const report = consistencyReport(after, targetByMaterialId, targetByLogicalItemId);
  if (apply && JSON.stringify(before.rapItems) !== JSON.stringify(after.rapItems)) {
    throw new Error("RAP titles changed during the RDL-only backfill");
  }
  if (report.materialInvalid || report.logicalInvalid || report.catalogInvalid
    || report.materialLogicalMismatch || report.targetMismatch) {
    throw new Error(`RDL title consistency failed: ${JSON.stringify(report)}`);
  }
  console.log(JSON.stringify({
    valid: true,
    write: apply,
    materialUpdates,
    logicalUpdates,
    ...report,
    rapTitleChanges: 0
  }, null, 2));
}

async function loadSnapshot() {
  const db = createServiceSupabase();
  const [materials, rdlItems, questions, rapItems] = await Promise.all([
    db.from("reading_materials").select("material_id,title").like("material_id", "RDL-%").order("material_id"),
    db.from("reading_logical_items")
      .select("logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count,reading_source_occurrences(occurrence_date)")
      .eq("module", "rdl")
      .order("logical_item_id"),
    db.from("reading_questions").select("logical_item_id,material_id").eq("module", "rdl"),
    db.from("reading_logical_items").select("logical_item_id,title").eq("module", "rap").order("logical_item_id")
  ]);
  for (const [name, result] of [["materials", materials], ["RDL items", rdlItems], ["questions", questions], ["RAP items", rapItems]] as const) {
    if (result.error) throw new Error(`Read ${name}: ${result.error.message}`);
  }
  return {
    materials: (materials.data ?? []) as MaterialRow[],
    rdlItems: (rdlItems.data ?? []) as ReadingCatalogItemRow[],
    questions: (questions.data ?? []) as QuestionMaterialRow[],
    rapItems: (rapItems.data ?? []) as Array<{ logical_item_id: string; title: string | null }>
  };
}

function verifyKnownMaterialInventory(materials: MaterialRow[], auditRows: AuditRow[]) {
  if (materials.length !== auditRows.length) {
    throw new Error(`RDL material inventory mismatch: database=${materials.length} audit=${auditRows.length}`);
  }
  const auditById = new Map(auditRows.map((row) => [row.material_id, row]));
  for (const material of materials) {
    const audit = auditById.get(material.material_id);
    if (!audit) throw new Error(`Unaudited RDL material ${material.material_id}`);
    const known = new Set([audit.current_title, audit.previous_title, audit.new_title]);
    if (!material.title || !known.has(material.title)) {
      throw new Error(`${material.material_id} has an unexpected current title: ${material.title ?? "<empty>"}`);
    }
  }
}

function logicalTargets(
  questions: QuestionMaterialRow[],
  targetByMaterialId: Map<string, string>
) {
  const materialIdsByLogicalItem = new Map<string, Set<string>>();
  for (const question of questions) {
    if (!question.material_id) throw new Error(`${question.logical_item_id} has an RDL question without material_id`);
    const materialIds = materialIdsByLogicalItem.get(question.logical_item_id) ?? new Set<string>();
    materialIds.add(question.material_id);
    materialIdsByLogicalItem.set(question.logical_item_id, materialIds);
  }
  return new Map(Array.from(materialIdsByLogicalItem, ([logicalItemId, materialIds]) => {
    if (materialIds.size !== 1) throw new Error(`${logicalItemId} maps to ${materialIds.size} RDL materials`);
    const materialId = Array.from(materialIds)[0];
    const title = targetByMaterialId.get(materialId);
    if (!title) throw new Error(`${logicalItemId} maps to unaudited material ${materialId}`);
    return [logicalItemId, title];
  }));
}

function consistencyReport(
  snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
  targetByMaterialId: Map<string, string>,
  targetByLogicalItemId: Map<string, string>
) {
  const invalid = (title: string | null, context: string) => {
    try {
      assertCanonicalRdlTitle(title ?? "", context);
      return false;
    } catch {
      return true;
    }
  };
  const materialTitleById = new Map(snapshot.materials.map((row) => [row.material_id, row.title]));
  const materialIdByLogicalItem = new Map(snapshot.questions.map((row) => [row.logical_item_id, row.material_id]));
  const catalog = buildReadingCatalogPayload({ taskType: "rdl", items: snapshot.rdlItems, attempts: [] });
  return {
    materialCount: snapshot.materials.length,
    logicalItemCount: snapshot.rdlItems.length,
    catalogItemCount: catalog.items.length,
    materialInvalid: snapshot.materials.filter((row) => invalid(row.title, row.material_id)).length,
    logicalInvalid: snapshot.rdlItems.filter((row) => invalid(row.title, row.logical_item_id)).length,
    catalogInvalid: catalog.items.filter((row) => invalid(row.title, row.itemId)).length,
    materialLogicalMismatch: snapshot.rdlItems.filter((row) =>
      row.title !== materialTitleById.get(materialIdByLogicalItem.get(row.logical_item_id) ?? "")
    ).length,
    targetMismatch:
      snapshot.materials.filter((row) => row.title !== targetByMaterialId.get(row.material_id)).length
      + snapshot.rdlItems.filter((row) => row.title !== targetByLogicalItemId.get(row.logical_item_id)).length,
    emptyOccurrenceDates: catalog.items.filter((row) => row.occurrenceDates.length === 0).length,
    rapItemCount: snapshot.rapItems.length
  };
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
