import type { ReadingInsertionAnchor, ReadingPassage } from "./types.ts";

export type ReadingInsertionPhysicalPosition = {
  paragraphOrder: number;
  paragraphIndex: number;
  boundaryIndex: number;
  sentenceCount: number;
  resolutionStatus: "resolved" | "unresolved";
  resolutionReason: string | null;
  textOffset: number | null;
  normalizedOffset: number | null;
  normalizedParagraphLength: number;
  normalizedLeftContext: string | null;
  normalizedRightContext: string | null;
  semanticKey: string;
};

type NormalizedTextMapping = {
  characters: string[];
  sourceBoundaries: number[];
};

/**
 * Resolve an insertion anchor to an actual text boundary in its paragraph.
 * Sentence ordinals describe the source serialization only; an internal anchor
 * is located by finding its referenced sentence text uniquely in paragraph.text.
 */
export function resolveInsertionAnchorPhysicalPosition(
  passage: ReadingPassage,
  anchor: ReadingInsertionAnchor
): ReadingInsertionPhysicalPosition {
  const paragraphs = [...passage.paragraphs].sort((left, right) => left.paragraphOrder - right.paragraphOrder);
  const paragraphIndex = paragraphs.findIndex((paragraph) => paragraph.paragraphId === anchor.paragraphId);
  const paragraph = paragraphs[paragraphIndex];
  if (!paragraph) throw new Error(`Reading insertion position cannot resolve paragraph ${anchor.paragraphId}`);
  const sentences = [...paragraph.sentences].sort((left, right) => left.sentenceOrder - right.sentenceOrder);
  if (anchor.boundaryIndex < 0 || anchor.boundaryIndex > sentences.length) {
    throw new Error(`Reading insertion boundary ${anchor.boundaryIndex} is outside paragraph ${paragraph.paragraphOrder}`);
  }
  const expectedAfter = anchor.boundaryIndex === 0 ? null : sentences[anchor.boundaryIndex - 1]?.sentenceId ?? null;
  if (anchor.afterSentenceId !== expectedAfter) {
    throw new Error(`Reading insertion boundary ${anchor.boundaryIndex} has inconsistent afterSentenceId`);
  }

  const normalizedParagraph = normalizeInsertionBoundaryTextWithMapping(paragraph.text);
  let normalizedOffset: number | null;
  let textOffset: number | null;
  let resolutionReason: string | null = null;
  if (anchor.boundaryIndex === 0) {
    normalizedOffset = 0;
    textOffset = 0;
  } else if (anchor.boundaryIndex === sentences.length) {
    normalizedOffset = normalizedParagraph.characters.length;
    textOffset = Array.from(paragraph.text).length;
  } else {
    const referencedSentence = sentences[anchor.boundaryIndex - 1];
    const normalizedSentence = normalizeInsertionBoundaryTextWithMapping(referencedSentence.text).characters;
    const matches = findAllCharacterSequenceOffsets(normalizedParagraph.characters, normalizedSentence);
    if (normalizedSentence.length === 0) {
      normalizedOffset = null;
      textOffset = null;
      resolutionReason = "referenced sentence has no normalized text";
    } else if (matches.length !== 1) {
      normalizedOffset = null;
      textOffset = null;
      resolutionReason = matches.length === 0
        ? "referenced sentence text does not occur in paragraph text"
        : "referenced sentence text is not unique in paragraph text";
    } else {
      normalizedOffset = matches[0] + normalizedSentence.length;
      textOffset = normalizedParagraph.sourceBoundaries[normalizedOffset] ?? null;
      if (textOffset === null) resolutionReason = "normalized boundary cannot map back to paragraph text";
    }
  }

  const resolved = normalizedOffset !== null && textOffset !== null;
  const resolvedNormalizedOffset = normalizedOffset ?? 0;
  const normalizedLeft = resolved
    ? normalizedParagraph.characters.slice(0, resolvedNormalizedOffset).join("")
    : null;
  const normalizedRight = resolved
    ? normalizedParagraph.characters.slice(resolvedNormalizedOffset).join("")
    : null;
  return {
    paragraphOrder: paragraph.paragraphOrder,
    paragraphIndex,
    boundaryIndex: anchor.boundaryIndex,
    sentenceCount: sentences.length,
    resolutionStatus: resolved ? "resolved" : "unresolved",
    resolutionReason,
    textOffset,
    normalizedOffset,
    normalizedParagraphLength: normalizedParagraph.characters.length,
    normalizedLeftContext: normalizedLeft,
    normalizedRightContext: normalizedRight,
    semanticKey: resolved
      ? JSON.stringify([paragraph.paragraphOrder, normalizedLeft, normalizedRight])
      : JSON.stringify([
          "unresolved",
          paragraph.paragraphOrder,
          anchor.boundaryIndex,
          anchor.afterSentenceId,
          resolutionReason
        ])
  };
}

export function insertionPhysicalPositionsEqual(
  left: ReadingInsertionPhysicalPosition,
  right: ReadingInsertionPhysicalPosition
) {
  return left.resolutionStatus === "resolved"
    && right.resolutionStatus === "resolved"
    && left.semanticKey === right.semanticKey;
}

export function normalizeInsertionBoundaryText(value: string) {
  return normalizeInsertionBoundaryTextWithMapping(value).characters.join("");
}

function normalizeInsertionBoundaryTextWithMapping(value: string): NormalizedTextMapping {
  const sourceCharacters = Array.from(value);
  const characters: string[] = [];
  const sourceBoundaries = [0];
  let pendingWhitespaceBoundary: number | null = null;
  for (let sourceIndex = 0; sourceIndex < sourceCharacters.length; sourceIndex += 1) {
    const normalized = normalizeInsertionCharacter(sourceCharacters[sourceIndex]);
    for (const character of Array.from(normalized)) {
      if (/\s/.test(character)) {
        if (characters.length > 0) pendingWhitespaceBoundary = sourceIndex + 1;
        continue;
      }
      if (pendingWhitespaceBoundary !== null) {
        characters.push(" ");
        sourceBoundaries.push(pendingWhitespaceBoundary);
        pendingWhitespaceBoundary = null;
      }
      characters.push(character);
      sourceBoundaries.push(sourceIndex + 1);
    }
  }
  return { characters, sourceBoundaries };
}

function normalizeInsertionCharacter(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035\u275b\u275c\u02bc\uff07]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036\u275d\u275e\u301d-\u301f\uff02]/g, '"')
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    .replace(/\u2026/g, "...");
}

function findAllCharacterSequenceOffsets(haystack: string[], needle: string[]) {
  const offsets: number[] = [];
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((character, index) => haystack[start + index] === character)) offsets.push(start);
  }
  return offsets;
}
