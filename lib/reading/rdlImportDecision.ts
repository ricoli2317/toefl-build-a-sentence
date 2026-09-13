import type { PreparedReadingImportPackage } from "./importer.ts";

export type RdlImportDecisionAction =
  | "reuse_existing"
  | "create_new"
  | "pending_resolution";

export type RdlImportGroupDecision = {
  sourceLabel: string;
  sourceModule: string;
  sourceOrder: number;
  sourceQuestionStart: number;
  sourceQuestionEnd: number;
  materialId: string;
  materialMatchKind: PreparedReadingImportPackage["materialMatchKind"];
  matchedMaterialId: string | null;
  materialAction: RdlImportDecisionAction;
  logicalItemAction: RdlImportDecisionAction;
  matchedLogicalItemId: string | null;
  reasonCode:
    | "reuse_existing_logical_item"
    | "registered_material_first_question_set"
    | "pending_duplicate_resolution";
  reason: string;
};

export function buildRdlImportGroupDecision(
  prepared: PreparedReadingImportPackage
): RdlImportGroupDecision {
  if (prepared.packageData.item.module !== "rdl") {
    throw new Error("RDL import decision requires an RDL package");
  }
  const occurrence = prepared.packageData.occurrences[0];
  const materialId = prepared.packageData.materials[0]?.materialId;
  if (!occurrence || !materialId) {
    throw new Error("RDL import decision requires one source occurrence and material");
  }

  const materialPending = prepared.materialMatchKind === "possible_material_duplicate";
  const logicalPending = materialPending || prepared.possibleDuplicateLogicalItemIds.length > 0;
  const materialAction: RdlImportDecisionAction = materialPending
    ? "pending_resolution"
    : prepared.materialMatchKind === "exact_material" || prepared.materialMatchKind === "semantic_material"
      ? "reuse_existing"
      : "create_new";
  const logicalItemAction: RdlImportDecisionAction = logicalPending
    ? "pending_resolution"
    : prepared.existingItem
      ? "reuse_existing"
      : "create_new";

  const explanation = logicalPending
    ? {
        reasonCode: "pending_duplicate_resolution" as const,
        reason: "素材或题组存在未决的重复候选，需先完成人工确认。"
      }
    : prepared.existingItem
      ? {
          reasonCode: "reuse_existing_logical_item" as const,
          reason: "该 material_id 已关联历史 RDL logical item，本次复用题组并新增来源。"
        }
      : {
          reasonCode: "registered_material_first_question_set" as const,
          reason: "素材已在 reading_materials 注册，但尚无历史 RDL logical item 使用该 material_id；本次首次创建题组。"
        };

  return {
    sourceLabel: occurrence.sourceLabel,
    sourceModule: occurrence.sourceModule,
    sourceOrder: occurrence.sourceOrder,
    sourceQuestionStart: occurrence.sourceQuestionStart,
    sourceQuestionEnd: occurrence.sourceQuestionEnd,
    materialId,
    materialMatchKind: prepared.materialMatchKind,
    matchedMaterialId: materialAction === "reuse_existing" ? materialId : null,
    materialAction,
    logicalItemAction,
    matchedLogicalItemId: prepared.existingItem?.logicalItemId ?? null,
    ...explanation
  };
}
