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
  return chunk
    .split(/(\s+)/)
    .map((part) => (part.trim() ? formatWordForMiddle(part) : part))
    .join("");
}

export function formatPlacedChunk(chunk: string, isSentenceStart: boolean) {
  const formatted = formatOptionChunk(chunk);
  if (!isSentenceStart) return formatted;

  const firstLetterIndex = formatted.search(/[A-Za-z]/);
  if (firstLetterIndex === -1) return formatted;

  return `${formatted.slice(0, firstLetterIndex)}${formatted[firstLetterIndex].toLocaleUpperCase()}${formatted.slice(firstLetterIndex + 1)}`;
}

function formatWordForMiddle(word: string) {
  const canonicalWord = formatCanonicalWord(word);
  if (canonicalWord) return canonicalWord;
  if (shouldPreserveCapitalization(word)) return word;
  return word.toLocaleLowerCase();
}

const CANONICAL_WORDS: Record<string, string> = {
  ai: "AI",
  chinese: "Chinese",
  english: "English",
  french: "French",
  german: "German",
  i: "I",
  ielts: "IELTS",
  japanese: "Japanese",
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
