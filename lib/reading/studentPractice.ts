import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { resolveReadingAssetUrl } from "./assets.ts";
import {
  parseRdlSelectionMap,
  validateRdlImageBinding,
  type RdlSelectionMap
} from "./rdlSelection.ts";
import {
  validateRapInsertionAnchors,
  validateRapSentenceTarget
} from "./rapInteraction.ts";
import type { ReadingImportPackage, ReadingModule, ReadingQuestion } from "./types.ts";
import { READING_PRODUCT_NAMES } from "./product.ts";
import { readingCatalogDisplayNumber } from "./catalog.ts";
import { isRdlMaterialType, type RdlMaterialType } from "./materialTypes.ts";

export { READING_PRODUCT_NAMES } from "./product.ts";

export type StudentCtwQuestion = {
  questionId: string;
  questionOrder: number;
  questionType: "ctw";
  stem: string;
  paragraphs: Array<{
    paragraphId: string;
    paragraphOrder: number;
    rawText: string;
    segments: Array<{ kind: "text"; text: string } | { kind: "blank"; slotId: string }>;
  }>;
  slots: Array<{
    slotId: string;
    slotOrder: number;
    paragraphId: string;
    prefix: string;
    missingLength: number;
  }>;
};

export type StudentChoiceOption = { optionId: string; optionOrder: number; text: string };

export type StudentRdlQuestion = {
  questionId: string;
  questionOrder: number;
  questionType: "rdl";
  stem: string;
  options: StudentChoiceOption[];
};

export type StudentRapQuestion =
  | {
      questionId: string;
      questionOrder: number;
      questionType: "rap_multiple_choice";
      stem: string;
      options: StudentChoiceOption[];
    }
  | {
      questionId: string;
      questionOrder: number;
      questionType: "rap_sentence_insertion";
      stem: string;
      insertSentence: string;
      anchors: Array<{
        anchorId: string;
        anchorOrder: number;
        paragraphId: string;
        boundaryIndex: number;
        afterSentenceId: string | null;
      }>;
    }
  | {
      questionId: string;
      questionOrder: number;
      questionType: "rap_sentence_selection";
      stem: string;
      targetParagraphId: string;
    };

export type StudentReadingPracticePayload = {
  item: {
    itemId: string;
    module: ReadingModule;
    productName: (typeof READING_PRODUCT_NAMES)[ReadingModule];
    title: string;
    questionCount: number;
    scoringPointCount: number;
  };
  material: null | {
    materialId: string;
    title: string;
    materialType: RdlMaterialType | null;
    imageUrl: string;
    selectionMapUrl: string;
    imageSha256: string | null;
    selectionMap: RdlSelectionMap | null;
  };
  passage: null | {
    passageId: string;
    title: string;
    paragraphs: Array<{
      paragraphId: string;
      paragraphOrder: number;
      text: string;
      rawText: string;
      sentences: Array<{ sentenceId: string; sentenceOrder: number; text: string }>;
    }>;
  };
  questions: Array<StudentCtwQuestion | StudentRdlQuestion | StudentRapQuestion>;
};

export class StudentReadingLoadError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(message: string, publicMessage: string, status = 500) {
    super(message);
    this.name = "StudentReadingLoadError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

/** Explicit full-domain -> student-safe boundary used by tests and future sources. */
export function toStudentReadingPracticePayload(
  packageData: ReadingImportPackage,
  assetBaseUrl = process.env.READING_ASSET_BASE_URL
): StudentReadingPracticePayload {
  const taskType = packageData.item.module;
  const material = packageData.materials[0];
  const canonicalRdlTitle = taskType === "rdl"
    ? requiredStoredRdlTitle(material?.title, material?.materialId ?? packageData.item.logicalItemId)
    : null;
  return {
    item: {
      itemId: packageData.item.logicalItemId,
      module: taskType,
      productName: READING_PRODUCT_NAMES[taskType],
      title: taskType === "ctw"
        ? "套题001"
        : taskType === "rdl"
          ? canonicalRdlTitle!
          : packageData.item.title ?? READING_PRODUCT_NAMES[taskType],
      questionCount: packageData.item.questionCount,
      scoringPointCount: packageData.item.scoredItemCount
    },
    material: taskType === "rdl" && material?.imageAssetPath && material.hitboxDataPath
      ? {
          materialId: material.materialId,
          title: canonicalRdlTitle!,
          materialType: material.materialType,
          imageUrl: resolveReadingAssetUrl(material.imageAssetPath, assetBaseUrl),
          selectionMapUrl: resolveReadingAssetUrl(material.hitboxDataPath, assetBaseUrl),
          imageSha256: null,
          selectionMap: null
        }
      : null,
    passage: packageData.passages[0]
      ? {
          passageId: packageData.passages[0].passageId,
          title: packageData.passages[0].title,
          paragraphs: packageData.passages[0].paragraphs
        }
      : null,
    questions: packageData.questions.map(toStudentQuestion)
  };
}

function toStudentQuestion(question: ReadingQuestion): StudentReadingPracticePayload["questions"][number] {
  const common = {
    questionId: question.questionId,
    questionOrder: question.questionOrder,
    stem: question.stem
  };
  switch (question.questionType) {
    case "ctw":
      return {
        ...common,
        questionType: "ctw",
        paragraphs: question.payload.paragraphs,
        slots: question.payload.slots.map((slot) => ({
          slotId: slot.slotId,
          slotOrder: slot.slotOrder,
          paragraphId: slot.paragraphId,
          prefix: slot.prefix,
          missingLength: slot.missingLength
        }))
      };
    case "rdl":
      return { ...common, questionType: "rdl", options: question.payload.options };
    case "rap_multiple_choice":
      return { ...common, questionType: "rap_multiple_choice", options: question.payload.options };
    case "rap_sentence_insertion":
      return {
        ...common,
        questionType: "rap_sentence_insertion",
        insertSentence: question.payload.insertSentence,
        anchors: question.payload.anchors
      };
    case "rap_sentence_selection":
      return {
        ...common,
        questionType: "rap_sentence_selection",
        targetParagraphId: question.payload.targetParagraphId
      };
  }
}

export async function loadStudentReadingPractice(
  db: SupabaseClient,
  itemId: string,
  assetBaseUrl = process.env.READING_ASSET_BASE_URL
): Promise<StudentReadingPracticePayload> {
  if (!/^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/.test(itemId)) {
    throw new StudentReadingLoadError("invalid Reading item identity", "这个阅读练习链接无效。", 400);
  }
  const { data: item, error: itemError } = await db
    .from("reading_logical_items")
    .select("logical_item_id,module,title,question_count,scored_item_count")
    .eq("logical_item_id", itemId)
    .maybeSingle();
  if (itemError) throw databaseLoadError("item", itemError);
  if (!item) throw new StudentReadingLoadError(`Reading item not found: ${itemId}`, "没有找到这个阅读练习。", 404);
  if (!isReadingModule(item.module)) {
    throw new StudentReadingLoadError(`unsupported module ${String(item.module)}`, "这个阅读练习暂时无法打开。", 422);
  }

  const taskType = item.module;
  let ctwDisplayNumber: string | null = null;
  if (taskType === "ctw") {
    const { data: ctwItems, error: ctwItemsError } = await db
      .from("reading_logical_items")
      .select("logical_item_id,first_seen_date,first_seen_source_label,first_seen_source_order")
      .eq("module", "ctw");
    if (ctwItemsError) throw databaseLoadError("Complete the Words display number", ctwItemsError);
    ctwDisplayNumber = readingCatalogDisplayNumber(
      (ctwItems ?? []).map((ctwItem) => ({
        logical_item_id: String(ctwItem.logical_item_id),
        first_seen_date: String(ctwItem.first_seen_date),
        first_seen_source_label: String(ctwItem.first_seen_source_label),
        first_seen_source_order: Number(ctwItem.first_seen_source_order)
      })),
      itemId
    );
    if (!ctwDisplayNumber) {
      throw new StudentReadingLoadError(`CTW display rank missing for ${itemId}`, "这个阅读练习暂时无法打开。", 422);
    }
  }
  const { data: questionRows, error: questionError } = await db
    .from("reading_questions")
    .select("question_id,question_order,module,question_type,stem,passage_id,material_id,insert_sentence,target_paragraph_id")
    .eq("logical_item_id", itemId)
    .order("question_order", { ascending: true });
  if (questionError) throw databaseLoadError("questions", questionError);
  if (!questionRows?.length || questionRows.length !== Number(item.question_count)) {
    throw new StudentReadingLoadError(`incomplete question group for ${itemId}`, "这个阅读练习的数据尚未准备完整。", 422);
  }
  if (questionRows.some((question) => question.module !== taskType)) {
    throw new StudentReadingLoadError(`question module mismatch for ${itemId}`, "这个阅读练习的数据尚未准备完整。", 422);
  }
  const questionIds = questionRows.map((question) => String(question.question_id));
  const baseItem = {
    itemId,
    module: taskType,
    productName: READING_PRODUCT_NAMES[taskType],
    title: taskType === "ctw"
      ? `套题${ctwDisplayNumber}`
      : taskType === "rdl"
        ? ""
        : String(item.title || READING_PRODUCT_NAMES[taskType]),
    questionCount: Number(item.question_count),
    scoringPointCount: Number(item.scored_item_count)
  };

  if (taskType === "ctw") {
    const [paragraphResult, segmentResult, slotResult] = await Promise.all([
      db.from("reading_ctw_paragraphs").select("question_id,paragraph_id,paragraph_order,raw_text").in("question_id", questionIds).order("paragraph_order"),
      db.from("reading_ctw_segments").select("question_id,paragraph_id,segment_order,segment_type,text_content,slot_id").in("question_id", questionIds).order("segment_order"),
      db.from("reading_ctw_slots").select("question_id,slot_id,slot_order,paragraph_id,prefix,missing_length").in("question_id", questionIds).order("slot_order")
    ]);
    if (paragraphResult.error || segmentResult.error || slotResult.error) {
      throw databaseLoadError("Complete the Words structure", paragraphResult.error || segmentResult.error || slotResult.error!);
    }
    const paragraphs = (paragraphResult.data ?? []).map((paragraph) => ({
      paragraphId: String(paragraph.paragraph_id),
      paragraphOrder: Number(paragraph.paragraph_order),
      rawText: String(paragraph.raw_text),
      segments: (segmentResult.data ?? [])
        .filter((segment) => segment.question_id === paragraph.question_id && segment.paragraph_id === paragraph.paragraph_id)
        .map((segment) => segment.segment_type === "text"
          ? { kind: "text" as const, text: String(segment.text_content ?? "") }
          : { kind: "blank" as const, slotId: String(segment.slot_id) })
    }));
    const slots = (slotResult.data ?? []).map((slot) => ({
      slotId: String(slot.slot_id),
      slotOrder: Number(slot.slot_order),
      paragraphId: String(slot.paragraph_id),
      prefix: String(slot.prefix),
      missingLength: Number(slot.missing_length)
    }));
    const renderedSlotIds = paragraphs.flatMap((paragraph) => paragraph.segments
      .filter((segment): segment is { kind: "blank"; slotId: string } => segment.kind === "blank")
      .map((segment) => segment.slotId));
    if (
      paragraphs.length === 0 ||
      paragraphs.some((paragraph) => paragraph.segments.length === 0) ||
      slots.length !== Number(item.scored_item_count) ||
      renderedSlotIds.length !== slots.length ||
      new Set(renderedSlotIds).size !== slots.length ||
      slots.some((slot) => !renderedSlotIds.includes(slot.slotId))
    ) {
      throw new StudentReadingLoadError(`incomplete CTW structure for ${itemId}`, "这个 Complete the Words 练习尚未准备完整。", 422);
    }
    return {
      item: baseItem,
      material: null,
      passage: null,
      questions: [{
        questionId: questionIds[0],
        questionOrder: Number(questionRows[0].question_order),
        questionType: "ctw",
        stem: String(questionRows[0].stem),
        paragraphs,
        slots
      }]
    };
  }

  const { data: optionRows, error: optionError } = await db
    .from("reading_question_options")
    .select("question_id,option_id,option_order,option_text")
    .in("question_id", questionIds)
    .order("option_order", { ascending: true });
  if (optionError) throw databaseLoadError("question options", optionError);
  const optionsFor = (questionId: string): StudentChoiceOption[] => (optionRows ?? [])
    .filter((option) => option.question_id === questionId)
    .map((option) => ({
      optionId: String(option.option_id),
      optionOrder: Number(option.option_order),
      text: String(option.option_text)
    }));

  if (taskType === "rdl") {
    const materialId = String(questionRows[0].material_id ?? "");
    if (!materialId || questionRows.some((question) => question.question_type !== "rdl" || question.material_id !== materialId)) {
      throw new StudentReadingLoadError(`broken material reference for ${itemId}`, "这个 Read in Daily Life 练习的材料尚未准备完整。", 422);
    }
    const { data: material, error: materialError } = await db
      .from("reading_materials")
      .select("material_id,title,material_type,binding_status,image_asset_path,hitbox_data_path")
      .eq("material_id", materialId)
      .maybeSingle();
    if (materialError) throw databaseLoadError("material", materialError);
    if (!material || material.binding_status !== "bound" || !material.image_asset_path || !material.hitbox_data_path) {
      throw new StudentReadingLoadError(`unready material ${materialId}`, "这个 Read in Daily Life 练习的材料尚未准备完整。", 422);
    }
    const questions: StudentRdlQuestion[] = questionRows.map((question) => ({
      questionId: String(question.question_id),
      questionOrder: Number(question.question_order),
      questionType: "rdl",
      stem: String(question.stem),
      options: optionsFor(String(question.question_id))
    }));
    if (questions.some((question) => question.options.length === 0)) {
      throw new StudentReadingLoadError(`missing RDL options for ${itemId}`, "这个 Read in Daily Life 练习的题目尚未准备完整。", 422);
    }
    const imageUrl = resolveReadingAssetUrl(String(material.image_asset_path), assetBaseUrl);
    const selectionMapUrl = resolveReadingAssetUrl(String(material.hitbox_data_path), assetBaseUrl);
    const verifiedSelection = await loadVerifiedRdlSelectionMap(
      imageUrl,
      selectionMapUrl,
      String(material.image_asset_path)
    ).catch((error) => {
      console.error("RDL runtime selection binding verification failed", { error, materialId });
      return null;
    });
    const materialType = isRdlMaterialType(material.material_type) ? material.material_type : null;
    if (!materialType && process.env.NODE_ENV !== "production") {
      console.error("RDL material type is missing or invalid", { materialId });
    }
    const canonicalRdlTitle = requiredStoredRdlTitle(material.title, materialId);
    return {
      item: { ...baseItem, title: canonicalRdlTitle },
      material: {
        materialId,
        title: canonicalRdlTitle,
        materialType,
        imageUrl,
        selectionMapUrl,
        imageSha256: verifiedSelection?.imageSha256 ?? null,
        selectionMap: verifiedSelection?.selectionMap ?? null
      },
      passage: null,
      questions
    };
  }

  const passageId = String(questionRows[0].passage_id ?? "");
  if (!passageId || questionRows.some((question) => question.passage_id !== passageId)) {
    throw new StudentReadingLoadError(`broken passage reference for ${itemId}`, "这个 Read an Academic Passage 练习的文章尚未准备完整。", 422);
  }
  const [passageResult, paragraphResult, sentenceResult, anchorResult] = await Promise.all([
    db.from("reading_passages").select("passage_id,title").eq("passage_id", passageId).maybeSingle(),
    db.from("reading_passage_paragraphs").select("passage_id,paragraph_id,paragraph_order,paragraph_text,raw_text").eq("passage_id", passageId).order("paragraph_order"),
    db.from("reading_passage_sentences").select("passage_id,paragraph_id,sentence_id,sentence_order,sentence_text").eq("passage_id", passageId).order("sentence_order"),
    db.from("reading_rap_insertion_anchors").select("question_id,anchor_id,anchor_order,paragraph_id,boundary_index,after_sentence_id").in("question_id", questionIds).order("anchor_order")
  ]);
  if (passageResult.error || paragraphResult.error || sentenceResult.error || anchorResult.error) {
    throw databaseLoadError("academic passage", passageResult.error || paragraphResult.error || sentenceResult.error || anchorResult.error!);
  }
  if (!passageResult.data || !paragraphResult.data?.length) {
    throw new StudentReadingLoadError(`missing passage ${passageId}`, "这个 Read an Academic Passage 练习的文章尚未准备完整。", 422);
  }
  const passage = {
    passageId,
    title: String(passageResult.data.title),
    paragraphs: paragraphResult.data.map((paragraph) => ({
      paragraphId: String(paragraph.paragraph_id),
      paragraphOrder: Number(paragraph.paragraph_order),
      text: String(paragraph.paragraph_text),
      rawText: String(paragraph.raw_text),
      sentences: (sentenceResult.data ?? [])
        .filter((sentence) => sentence.paragraph_id === paragraph.paragraph_id)
        .map((sentence) => ({
          sentenceId: String(sentence.sentence_id),
          sentenceOrder: Number(sentence.sentence_order),
          text: String(sentence.sentence_text)
        }))
    }))
  };
  if (passage.paragraphs.some((paragraph) => paragraph.sentences.length === 0)) {
    throw new StudentReadingLoadError(`missing sentence structure for ${passageId}`, "这个 Read an Academic Passage 练习的文章尚未准备完整。", 422);
  }
  const questions: StudentRapQuestion[] = questionRows.map((question) => {
    const common = {
      questionId: String(question.question_id),
      questionOrder: Number(question.question_order),
      stem: String(question.stem)
    };
    if (question.question_type === "rap_multiple_choice") {
      const options = optionsFor(common.questionId);
      if (options.length === 0) {
        throw new StudentReadingLoadError(`missing RAP options for ${common.questionId}`, "这个阅读题尚未准备完整。", 422);
      }
      return { ...common, questionType: "rap_multiple_choice", options };
    }
    if (question.question_type === "rap_sentence_insertion") {
      const anchors = (anchorResult.data ?? [])
        .filter((anchor) => anchor.question_id === question.question_id)
        .map((anchor) => ({
          anchorId: String(anchor.anchor_id),
          anchorOrder: Number(anchor.anchor_order),
          paragraphId: String(anchor.paragraph_id),
          boundaryIndex: Number(anchor.boundary_index),
          afterSentenceId: anchor.after_sentence_id === null ? null : String(anchor.after_sentence_id)
        }));
      const anchorValidation = validateRapInsertionAnchors(passage, anchors);
      if (!anchorValidation.valid) {
        throw new StudentReadingLoadError(
          `invalid insertion anchors for ${common.questionId}: ${anchorValidation.reason}`,
          "这个阅读题尚未准备完整。",
          422
        );
      }
      return { ...common, questionType: "rap_sentence_insertion", insertSentence: String(question.insert_sentence), anchors };
    }
    if (question.question_type === "rap_sentence_selection") {
      const targetParagraphId = String(question.target_paragraph_id);
      const targetValidation = validateRapSentenceTarget(passage, targetParagraphId);
      if (targetValidation.valid) {
        return { ...common, questionType: "rap_sentence_selection", targetParagraphId };
      }
      throw new StudentReadingLoadError(
        `invalid sentence-selection target for ${common.questionId}: ${targetValidation.reason}`,
        "这个阅读题尚未准备完整。",
        422
      );
    }
    throw new StudentReadingLoadError(`unsupported or incomplete RAP question ${common.questionId}`, "这个阅读题尚未准备完整。", 422);
  });
  return { item: baseItem, material: null, passage, questions };
}

function requiredStoredRdlTitle(value: unknown, materialId: string): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (title) return title;
  if (process.env.NODE_ENV !== "production") {
    console.error("RDL canonical title is missing", { materialId });
  }
  throw new StudentReadingLoadError(
    `RDL canonical title is missing for ${materialId}`,
    "这个 Read in Daily Life 练习的标题数据尚未准备完整。",
    422
  );
}

async function loadVerifiedRdlSelectionMap(
  imageUrl: string,
  selectionMapUrl: string,
  imageObjectKey: string
): Promise<{ imageSha256: string; selectionMap: RdlSelectionMap }> {
  const [imageResponse, selectionMapResponse] = await Promise.all([
    fetch(imageUrl, { cache: "force-cache" }),
    fetch(selectionMapUrl, { cache: "force-cache" })
  ]);
  if (!imageResponse.ok || !selectionMapResponse.ok) {
    throw new Error(`RDL runtime assets unavailable: image ${imageResponse.status}, map ${selectionMapResponse.status}`);
  }
  const [imageBytes, selectionMapJson] = await Promise.all([
    imageResponse.arrayBuffer(),
    selectionMapResponse.json()
  ]);
  const selectionMap = parseRdlSelectionMap(selectionMapJson);
  const imageSha256 = createHash("sha256").update(new Uint8Array(imageBytes)).digest("hex");
  const dimensions = pngDimensions(new Uint8Array(imageBytes));
  const imageFile = imageObjectKey.split("/").pop() ?? "";
  if (!validateRdlImageBinding(selectionMap, {
    imageFile,
    imageSha256,
    naturalWidth: dimensions.width,
    naturalHeight: dimensions.height
  })) {
    throw new Error("RDL runtime image and selection map do not match");
  }
  return { imageSha256, selectionMap };
}

function pngDimensions(bytes: Uint8Array) {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || pngSignature.some((byte, index) => bytes[index] !== byte)
    || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) {
    throw new Error("RDL runtime image is not a valid PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) throw new Error("RDL runtime PNG dimensions are invalid");
  return { width, height };
}

function isReadingModule(value: unknown): value is ReadingModule {
  return value === "ctw" || value === "rdl" || value === "rap";
}

function databaseLoadError(area: string, error: { message?: string }) {
  return new StudentReadingLoadError(`${area}: ${error.message ?? "database error"}`, "阅读练习加载失败，请稍后重试。", 500);
}
