import type { ReadingImportPackage } from "./types.ts";

export function buildReadingCatalogSearchText(packageData: ReadingImportPackage) {
  const values: string[] = [];
  for (const question of packageData.questions) {
    values.push(question.stem, question.rawDisplayText ?? "");
    if (question.questionType === "ctw") {
      const slots = new Map(question.payload.slots.map((slot) => [slot.slotId, slot]));
      for (const paragraph of question.payload.paragraphs) {
        values.push(paragraph.rawText);
        values.push(paragraph.segments.map((segment) =>
          segment.kind === "text" ? segment.text : slots.get(segment.slotId)?.answer ?? ""
        ).join(""));
      }
      values.push(...question.payload.slots.flatMap((slot) => [
        slot.answer,
        slot.displayText,
        slot.missingText
      ]));
    } else if (question.questionType === "rdl" || question.questionType === "rap_multiple_choice") {
      values.push(...question.payload.options.map((option) => option.text));
    } else if (question.questionType === "rap_sentence_insertion") {
      values.push(question.payload.insertSentence);
    }
  }
  values.push(...packageData.passages.flatMap((passage) =>
    passage.paragraphs.map((paragraph) => paragraph.text)
  ));
  values.push(...packageData.materials.map((material) => material.catalogSearchText ?? ""));
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).join(" ");
}
