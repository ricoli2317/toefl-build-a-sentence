export function splitTextItems(value: string | null | undefined) {
  if (!value) return [];

  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  const delimiter = trimmed.includes("|") ? "|" : trimmed.includes("\n") ? "\n" : ",";
  return trimmed
    .split(delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinTextItems(items: string[]) {
  return JSON.stringify(items.map((item) => item.trim()).filter(Boolean));
}

export function formatTextItems(value: string | null | undefined) {
  return splitTextItems(value).join(" ");
}

export function normalizeChunkForCompare(chunk: string) {
  return chunk.trim().toLocaleLowerCase();
}

export function standardizeOrderTextCasing(
  submittedOrderText: string | null | undefined,
  optionsText: string | null | undefined,
  correctOrderText: string | null | undefined
) {
  const submittedChunks = splitTextItems(submittedOrderText);
  if (submittedChunks.length === 0) return "";

  const optionChunks = splitTextItems(optionsText);
  const correctChunks = splitTextItems(correctOrderText);
  const canonicalByKey = new Map<string, string[]>();

  for (const chunk of optionChunks) {
    const key = normalizeChunkForDisplayMatch(chunk);
    canonicalByKey.set(key, [...(canonicalByKey.get(key) ?? []), chunk]);
  }

  const correctOccurrenceByKey = new Map<string, number>();
  for (const chunk of correctChunks) {
    const key = normalizeChunkForDisplayMatch(chunk);
    const occurrence = correctOccurrenceByKey.get(key) ?? 0;
    const canonicalChunks = canonicalByKey.get(key) ?? [];
    canonicalChunks[occurrence] = chunk;
    canonicalByKey.set(key, canonicalChunks);
    correctOccurrenceByKey.set(key, occurrence + 1);
  }

  const usedOccurrenceByKey = new Map<string, number>();
  const standardizedChunks = submittedChunks.map((chunk) => {
    const key = normalizeChunkForDisplayMatch(chunk);
    const occurrence = usedOccurrenceByKey.get(key) ?? 0;
    usedOccurrenceByKey.set(key, occurrence + 1);
    return canonicalByKey.get(key)?.[occurrence] ?? normalizeInlineSpacing(chunk);
  });

  return joinTextItems(standardizedChunks);
}

function normalizeChunkForDisplayMatch(chunk: string) {
  return normalizeInlineSpacing(chunk).toLocaleLowerCase();
}

export function formatOptionChunk(chunk: string) {
  return normalizeInlineSpacing(chunk);
}

export function formatPlacedChunk(chunk: string, isSentenceStart: boolean) {
  const formatted = formatOptionChunk(chunk);
  if (!isSentenceStart) return formatted;

  return capitalizeFirstLowercaseEnglishLetter(formatted);
}

export function formatTemplateText(part: string, isSentenceStart: boolean) {
  return isSentenceStart ? capitalizeFirstLowercaseEnglishLetter(part) : part;
}

export function buildSentenceDisplay(
  template: string | null | undefined,
  orderText: string | null | undefined,
  fallbackSentence = ""
) {
  const chunks = splitTextItems(orderText);
  if (chunks.length === 0) return formatSentenceDisplayFromText(fallbackSentence);

  if (!template) {
    return capitalizeFirstLowercaseEnglishLetter(
      normalizeSentenceSpacing(chunks.map(formatOptionChunk).join(" "))
    );
  }

  const parts = splitSentenceTemplate(template);
  let blankIndex = 0;

  const sentence = parts
    .map((part) => {
      if (!isBlankToken(part)) {
        return part;
      }

      const chunk = chunks[blankIndex] ?? "";
      blankIndex += 1;
      return formatOptionChunk(chunk);
    })
    .join("");

  const formattedSentence = capitalizeFirstLowercaseEnglishLetter(
    normalizeSentenceSpacing(sentence)
  );
  return formattedSentence || formatSentenceDisplayFromText(fallbackSentence);
}

export function splitSentenceTemplate(template: string) {
  return template.split(/(___+|_{2,}|\[Blank\s*\d+\])/gi);
}

export function isBlankToken(value: string) {
  return /^(___+|_{2,}|\[Blank\s*\d+\])$/i.test(value.trim());
}

export function isTemplatePartSentenceStart(parts: string[], partIndex: number) {
  return parts.slice(0, partIndex).every((part) => {
    if (isBlankToken(part)) return false;
    return !/[A-Za-z]/.test(part);
  });
}

function formatSentenceDisplayFromText(sentence: string) {
  if (!sentence) return "";
  return capitalizeFirstLowercaseEnglishLetter(normalizeSentenceSpacing(sentence));
}

function normalizeInlineSpacing(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function capitalizeFirstLowercaseEnglishLetter(value: string) {
  const firstLetterIndex = value.search(/[A-Za-z]/);
  if (firstLetterIndex === -1) return value;

  const firstLetter = value[firstLetterIndex];
  if (!/[a-z]/.test(firstLetter)) return value;

  return `${value.slice(0, firstLetterIndex)}${firstLetter.toLocaleUpperCase()}${value.slice(
    firstLetterIndex + 1
  )}`;
}

function normalizeSentenceSpacing(sentence: string) {
  return sentence
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}
