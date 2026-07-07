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

export function formatOptionChunk(chunk: string) {
  return formatSentenceText(chunk);
}

export function formatPlacedChunk(chunk: string, isSentenceStart: boolean) {
  const formatted = formatOptionChunk(chunk);
  if (!isSentenceStart) return formatted;

  return capitalizeFirstEnglishLetter(formatted);
}

export function formatTemplateText(part: string, isSentenceStart: boolean) {
  const formatted = formatSentenceText(part);
  return isSentenceStart ? capitalizeFirstEnglishLetter(formatted) : formatted;
}

export function buildSentenceDisplay(
  template: string | null | undefined,
  orderText: string | null | undefined,
  fallbackSentence = ""
) {
  const chunks = splitTextItems(orderText);
  if (chunks.length === 0) return formatSentenceDisplayFromText(fallbackSentence);

  if (!template) {
    return normalizeSentenceSpacing(
      chunks.map((chunk, index) => formatPlacedChunk(chunk, index === 0)).join(" ")
    );
  }

  const parts = splitSentenceTemplate(template);
  let blankIndex = 0;

  const sentence = parts
    .map((part, partIndex) => {
      if (!isBlankToken(part)) {
        return formatTemplateText(part, isTemplatePartSentenceStart(parts, partIndex));
      }

      const chunk = chunks[blankIndex] ?? "";
      const formatted = formatPlacedChunk(
        chunk,
        isTemplatePartSentenceStart(parts, partIndex)
      );
      blankIndex += 1;
      return formatted;
    })
    .join("");

  return normalizeSentenceSpacing(sentence) || formatSentenceDisplayFromText(fallbackSentence);
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
  return normalizeSentenceSpacing(capitalizeFirstEnglishLetter(formatSentenceText(sentence)));
}

function formatSentenceText(text: string) {
  let previousWordWasTitle = false;

  return text
    .split(/(\s+)/)
    .map((part) => {
      if (!part.trim()) return part;

      const formatted = previousWordWasTitle && isTitleCaseWord(part)
        ? part
        : formatWordForMiddle(part);
      previousWordWasTitle = isTitleWord(formatted);
      return formatted;
    })
    .join("");
}

function capitalizeFirstEnglishLetter(value: string) {
  const firstLetterIndex = value.search(/[A-Za-z]/);
  if (firstLetterIndex === -1) return value;

  return `${value.slice(0, firstLetterIndex)}${value[firstLetterIndex].toLocaleUpperCase()}${value.slice(
    firstLetterIndex + 1
  )}`;
}

function normalizeSentenceSpacing(sentence: string) {
  return sentence
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

function formatWordForMiddle(word: string) {
  const canonicalWord = formatCanonicalWord(word);
  if (canonicalWord) return canonicalWord;
  if (shouldPreserveCapitalization(word)) return word;
  return word.toLocaleLowerCase();
}

const CANONICAL_WORDS: Record<string, string> = {
  ai: "AI",
  america: "America",
  american: "American",
  australia: "Australia",
  australian: "Australian",
  britain: "Britain",
  british: "British",
  canada: "Canada",
  canadian: "Canadian",
  china: "China",
  chinese: "Chinese",
  english: "English",
  french: "French",
  german: "German",
  i: "I",
  ielts: "IELTS",
  japanese: "Japanese",
  mr: "Mr",
  ms: "Ms",
  dr: "Dr",
  sat: "SAT",
  spanish: "Spanish",
  toefl: "TOEFL",
  uk: "UK",
  usa: "USA"
};

const CANONICAL_I_CONTRACTIONS: Record<string, string> = {
  "i'd": "I'd",
  "i'll": "I'll",
  "i'm": "I'm",
  "i've": "I've",
  "i’d": "I’d",
  "i’ll": "I’ll",
  "i’m": "I’m",
  "i’ve": "I’ve"
};

function formatCanonicalWord(word: string) {
  const match = word.match(/^([^A-Za-z]*)([A-Za-z][A-Za-z'’]*)([^A-Za-z]*)$/);
  if (!match) return null;

  const [, leading, core, trailing] = match;
  const lowerCore = core.toLocaleLowerCase();
  const canonicalCore = CANONICAL_I_CONTRACTIONS[lowerCore] ?? CANONICAL_WORDS[lowerCore];

  return canonicalCore ? `${leading}${canonicalCore}${trailing}` : null;
}

function shouldPreserveCapitalization(word: string) {
  const lettersOnly = word.replace(/[^A-Za-z]/g, "");
  if (!lettersOnly) return false;
  if (lettersOnly === "I") return true;
  if (/^I(['’](m|d|ll|ve))?$/i.test(word.replace(/[.,!?;:]$/, ""))) return true;
  if (lettersOnly.length > 1 && lettersOnly === lettersOnly.toLocaleUpperCase()) return true;
  if (/[A-Z].*[A-Z]/.test(word) && /[a-z]/.test(word)) return true;
  return false;
}

function isTitleWord(word: string) {
  return /^(Mr|Ms|Dr)\.?$/i.test(word.replace(/^[^A-Za-z]*/, "").replace(/[^A-Za-z.]*$/, ""));
}

function isTitleCaseWord(word: string) {
  const lettersOnly = word.replace(/[^A-Za-z]/g, "");
  return /^[A-Z][a-z]+$/.test(lettersOnly);
}
