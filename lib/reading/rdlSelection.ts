export type RdlNormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RdlSelectionCharacter = {
  id: string;
  lineIndex: number;
  wordIndex: number;
  wordId: string;
  charIndex: number;
  globalIndex: number;
  char: string;
  bbox: RdlNormalizedRect;
};

export type RdlSelectionWord = {
  id: string;
  lineIndex: number;
  wordIndex: number;
  text: string;
  bbox: RdlNormalizedRect;
  characters: RdlSelectionCharacter[];
};

export type RdlSelectionLine = {
  lineIndex: number;
  text: string;
  bbox: RdlNormalizedRect;
  words: RdlSelectionWord[];
};

export type RdlSelectionMap = {
  schemaVersion: 2;
  imageFile: string;
  imageSha256: string;
  canvasWidth: number;
  canvasHeight: number;
  coordinateSpace: "normalized_top_left_xywh_0_1";
  lines: RdlSelectionLine[];
};

export type RdlSelectionRange = { startIndex: number; endIndex: number };

export type RdlContainRect = {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
};

export type RdlImageBinding = {
  imageFile: string;
  imageSha256: string;
  naturalWidth: number;
  naturalHeight: number;
};

export function parseRdlSelectionMap(input: unknown): RdlSelectionMap {
  const source = record(input, "selection map");
  if (source.schema_version !== 2) throw new Error("Unsupported RDL selection-map schema");
  if (source.coordinate_space !== "normalized_top_left_xywh_0_1") {
    throw new Error("Unsupported RDL selection-map coordinate space");
  }
  const imageFile = nonEmptyString(source.image_file, "image_file");
  const imageSha256 = nonEmptyString(source.image_sha256, "image_sha256");
  if (!/^[a-f0-9]{64}$/i.test(imageSha256)) throw new Error("Invalid RDL image SHA-256");
  const canvasWidth = positiveInteger(source.canvas_width, "canvas_width");
  const canvasHeight = positiveInteger(source.canvas_height, "canvas_height");
  if (!Array.isArray(source.lines) || source.lines.length === 0) throw new Error("RDL selection map has no lines");

  const lines = source.lines.map((lineInput, expectedLineIndex) => {
    const line = record(lineInput, `lines[${expectedLineIndex}]`);
    const lineIndex = nonNegativeInteger(line.line_index, `lines[${expectedLineIndex}].line_index`);
    if (lineIndex !== expectedLineIndex) throw new Error("RDL line order is inconsistent");
    if (!Array.isArray(line.words) || line.words.length === 0) throw new Error("RDL selection line has no words");
    const words = line.words.map((wordInput, expectedWordIndex) => {
      const word = record(wordInput, `lines[${lineIndex}].words[${expectedWordIndex}]`);
      const wordIndex = nonNegativeInteger(word.word_index, "word_index");
      if (wordIndex !== expectedWordIndex) throw new Error("RDL word order is inconsistent");
      const wordId = nonEmptyString(word.id, "word.id");
      const wordText = nonEmptyString(word.text, "word.text");
      if (!Array.isArray(word.chars) || word.chars.length === 0) throw new Error("RDL selection word has no characters");
      const characters = word.chars.map((charInput, expectedCharIndex) => {
        const character = record(charInput, `${wordId}.chars[${expectedCharIndex}]`);
        const charIndex = nonNegativeInteger(character.char_index, "char_index");
        if (charIndex !== expectedCharIndex) throw new Error("RDL character order is inconsistent");
        const char = nonEmptyString(character.char, "char");
        return {
          id: nonEmptyString(character.id, "character.id"),
          lineIndex,
          wordIndex,
          wordId,
          charIndex,
          globalIndex: nonNegativeInteger(character.global_index, "global_index"),
          char,
          bbox: normalizedRect(character.bbox, "character.bbox")
        };
      });
      if (characters.map((character) => character.char).join("") !== wordText) {
        throw new Error("RDL word text does not match its characters");
      }
      return {
        id: wordId,
        lineIndex,
        wordIndex,
        text: wordText,
        bbox: normalizedRect(word.bbox, "word.bbox"),
        characters
      };
    });
    return {
      lineIndex,
      text: nonEmptyString(line.text, "line.text"),
      bbox: normalizedRect(line.bbox, "line.bbox"),
      words
    };
  });

  const characters = lines.flatMap((line) => line.words.flatMap((word) => word.characters));
  const identities = new Set(characters.map((character) => character.id));
  const globalIndexes = new Set(characters.map((character) => character.globalIndex));
  if (identities.size !== characters.length || globalIndexes.size !== characters.length) {
    throw new Error("RDL selection-map character identities are not unique");
  }
  if (characters.some((character, index) => index > 0 && character.globalIndex <= characters[index - 1].globalIndex)) {
    throw new Error("RDL selection-map global character order is inconsistent");
  }

  return {
    schemaVersion: 2,
    imageFile,
    imageSha256: imageSha256.toLowerCase(),
    canvasWidth,
    canvasHeight,
    coordinateSpace: "normalized_top_left_xywh_0_1",
    lines
  };
}

export function flattenRdlCharacters(map: RdlSelectionMap): RdlSelectionCharacter[] {
  return map.lines.flatMap((line) => line.words.flatMap((word) => word.characters));
}

export function calculateRdlContainRect(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number
): RdlContainRect {
  if ([containerWidth, containerHeight, imageWidth, imageHeight].some((value) => !Number.isFinite(value) || value <= 0)) {
    return { left: 0, top: 0, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
    scale
  };
}

export function validateRdlImageBinding(map: RdlSelectionMap, image: RdlImageBinding): boolean {
  return map.imageSha256 === image.imageSha256.toLowerCase()
    && map.canvasWidth === image.naturalWidth
    && map.canvasHeight === image.naturalHeight;
}

export function normalizeRdlSelectionRange(anchorIndex: number, focusIndex: number): RdlSelectionRange {
  return {
    startIndex: Math.min(anchorIndex, focusIndex),
    endIndex: Math.max(anchorIndex, focusIndex)
  };
}

export function rdlWordRangeAt(map: RdlSelectionMap, characterIndex: number): RdlSelectionRange | null {
  const characters = flattenRdlCharacters(map);
  const character = characters[characterIndex];
  if (!character) return null;
  const indexes = characters
    .map((candidate, index) => candidate.wordId === character.wordId ? index : -1)
    .filter((index) => index >= 0);
  return indexes.length ? { startIndex: indexes[0], endIndex: indexes[indexes.length - 1] } : null;
}

export function rdlSelectedCharacters(
  map: RdlSelectionMap,
  range: RdlSelectionRange | null
): RdlSelectionCharacter[] {
  if (!range) return [];
  return flattenRdlCharacters(map).slice(range.startIndex, range.endIndex + 1);
}

export function rdlSelectedText(map: RdlSelectionMap, range: RdlSelectionRange | null): string {
  const characters = rdlSelectedCharacters(map, range);
  return characters.reduce((text, character, index) => {
    if (index === 0) return character.char;
    const previous = characters[index - 1];
    return `${text}${previous.wordId === character.wordId ? "" : " "}${character.char}`;
  }, "");
}

export function hitTestRdlCharacter(
  map: RdlSelectionMap,
  normalizedX: number,
  normalizedY: number,
  allowNearest = false
): number | null {
  const characters = flattenRdlCharacters(map);
  const exactIndex = characters.findIndex((character) => containsPoint(character.bbox, normalizedX, normalizedY));
  if (exactIndex >= 0) return exactIndex;

  for (const line of map.lines) {
    if (!containsPoint(line.bbox, normalizedX, normalizedY)) continue;
    const word = line.words.find((candidate) => containsPoint(candidate.bbox, normalizedX, normalizedY));
    if (!word) break;
    return nearestCharacterIndex(characters, normalizedX, normalizedY, word.id);
  }
  return allowNearest ? nearestCharacterIndex(characters, normalizedX, normalizedY) : null;
}

export function createRdlLookupRequest(query: string): { query: string } | null {
  const normalized = query.trim().replace(/\s+/g, " ");
  return normalized ? { query: normalized } : null;
}

function nearestCharacterIndex(
  characters: RdlSelectionCharacter[],
  x: number,
  y: number,
  wordId?: string
) {
  let bestIndex: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  characters.forEach((character, index) => {
    if (wordId && character.wordId !== wordId) return;
    const dx = axisDistance(x, character.bbox.x, character.bbox.x + character.bbox.width);
    const dy = axisDistance(y, character.bbox.y, character.bbox.y + character.bbox.height);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function axisDistance(value: number, start: number, end: number) {
  if (value < start) return start - value;
  if (value > end) return value - end;
  return 0;
}

function containsPoint(rect: RdlNormalizedRect, x: number, y: number) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function normalizedRect(input: unknown, label: string): RdlNormalizedRect {
  const source = record(input, label);
  const values = {
    x: finiteNumber(source.x, `${label}.x`),
    y: finiteNumber(source.y, `${label}.y`),
    width: finiteNumber(source.width, `${label}.width`),
    height: finiteNumber(source.height, `${label}.height`)
  };
  if (values.x < 0 || values.y < 0 || values.width <= 0 || values.height <= 0
    || values.x + values.width > 1.000001 || values.y + values.height > 1.000001) {
    throw new Error(`${label} is outside the normalized image bounds`);
  }
  return values;
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
  return input as Record<string, unknown>;
}

function nonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error(`${label} must be a non-empty string`);
  return input;
}

function finiteNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) throw new Error(`${label} must be a finite number`);
  return input;
}

function positiveInteger(input: unknown, label: string): number {
  const value = finiteNumber(input, label);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(input: unknown, label: string): number {
  const value = finiteNumber(input, label);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
