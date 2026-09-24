import type { RdlSelectionMap } from "../../reading/rdlSelection.ts";
import type { CanonicalLexicalBlock, RdlCanonicalCharacter } from "../types.ts";

export type RdlLexicalInput = {
  sourceItemId: string;
  materialId: string;
  selectionMap: RdlSelectionMap;
  questions: Array<{
    questionId: string;
    questionOrder: number;
    stem: string;
    options: Array<{ optionId: string; optionOrder: number; optionText: string }>;
  }>;
};

export type RdlCanonicalMaterial = {
  text: string;
  characters: RdlCanonicalCharacter[];
};

export function reconstructRdlCanonicalMaterial(map: RdlSelectionMap): RdlCanonicalMaterial {
  let text = "";
  let flatIndex = 0;
  const characters: RdlCanonicalCharacter[] = [];
  for (const line of [...map.lines].sort((left, right) => left.lineIndex - right.lineIndex)) {
    if (line.breakAfter === "unknown") {
      throw new Error("RDL canonical extraction requires a resolved break_after; normalize legacy selection maps before enumeration.");
    }
    const words = [...line.words].sort((left, right) => left.wordIndex - right.wordIndex);
    for (let wordPosition = 0; wordPosition < words.length; wordPosition += 1) {
      const word = words[wordPosition];
      if (wordPosition > 0) text += " ";
      for (const character of [...word.characters].sort((left, right) => left.charIndex - right.charIndex)) {
        const startOffset = text.length;
        text += character.char;
        characters.push({
          charId: character.id,
          wordId: word.id,
          globalIndex: character.globalIndex,
          flatIndex: flatIndex++,
          startOffset,
          endOffset: text.length,
          needsReview: character.needsReview || word.needsReview
        });
      }
    }
    text += line.breakAfter === "space" ? " " : line.breakAfter === "paragraph" ? "\n\n" : "";
  }
  return { text, characters };
}

export function rdlInclusiveSelectionToLexicalRange(
  material: RdlCanonicalMaterial,
  startFlatIndex: number,
  endFlatIndex: number
) {
  const start = material.characters[startFlatIndex];
  const end = material.characters[endFlatIndex];
  if (!start || !end || startFlatIndex > endFlatIndex) throw new Error("Invalid inclusive RDL selection range.");
  return { startOffset: start.startOffset, endOffset: end.endOffset };
}

export function enumerateRdlBlocks(input: RdlLexicalInput): CanonicalLexicalBlock[] {
  const material = reconstructRdlCanonicalMaterial(input.selectionMap);
  const wordRanges = new Map<string, { startOffset: number; endOffset: number; needsReview: boolean }>();
  for (const character of material.characters) {
    const range = wordRanges.get(character.wordId);
    wordRanges.set(character.wordId, {
      startOffset: range?.startOffset ?? character.startOffset,
      endOffset: character.endOffset,
      needsReview: (range?.needsReview ?? false) || character.needsReview
    });
  }
  const materialAnchors: NonNullable<CanonicalLexicalBlock["anchors"]> = [
    ...Array.from(wordRanges, ([anchorId, range]) => ({
      anchorId,
      anchorKind: "rdl_word" as const,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      metadata: { needsReview: range.needsReview ? 1 : 0 },
      expectedText: material.text.slice(range.startOffset, range.endOffset)
    })),
    ...material.characters.map((character) => ({
      anchorId: character.charId,
      anchorKind: "rdl_character" as const,
      startOffset: character.startOffset,
      endOffset: character.endOffset,
      expectedText: material.text.slice(character.startOffset, character.endOffset),
      metadata: {
        wordId: character.wordId,
        globalIndex: character.globalIndex,
        flatIndex: character.flatIndex,
        needsReview: character.needsReview ? 1 : 0
      }
    }))
  ];
  return [{
    sourceType: "rdl",
    sourceItemId: input.sourceItemId,
    contentBlockId: `material:${input.materialId}`,
    blockKind: "rdl_material",
    text: material.text,
    anchors: materialAnchors
  }, ...[...input.questions].sort((left, right) => left.questionOrder - right.questionOrder).flatMap((question) => [
    {
      sourceType: "rdl" as const,
      sourceItemId: input.sourceItemId,
      contentBlockId: `question:${question.questionId}:stem`,
      blockKind: "rdl_question_stem",
      text: question.stem
    },
    ...[...question.options].sort((left, right) => left.optionOrder - right.optionOrder).map((option) => ({
      sourceType: "rdl" as const,
      sourceItemId: input.sourceItemId,
      contentBlockId: `question:${question.questionId}:option:${option.optionId}`,
      blockKind: "rdl_question_option",
      text: option.optionText
    }))
  ])];
}
