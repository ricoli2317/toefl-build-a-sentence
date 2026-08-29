export const RDL_TITLE_MAX_ENGLISH_WORDS = 5;

export type RdlTitleAction = "KEEP_ORIGINAL" | "GENERATE_SHORT_TITLE";

export type RdlTitleDecisionInput = {
  explicitOriginalTitle: boolean;
  originalTitle: string | null;
  generatedTitle: string | null;
  sourceOpeningText?: string | null;
};

export type RdlTitleDecision = {
  action: RdlTitleAction;
  title: string;
  originalTitleWordCount: number;
};

const ENGLISH_WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const FORBIDDEN_GENERIC_TITLE = /^(?:reading|material|passage|question)$/i;

export function countEnglishTitleWords(value: string): number {
  return value.match(ENGLISH_WORD)?.length ?? 0;
}

export function canonicalizeRdlTitleCapitalization(title: string): string {
  return title.trim().replace(ENGLISH_WORD, (token) =>
    token.split("-").map((part) =>
      `${part.charAt(0).toLocaleUpperCase("en")}${part.slice(1).toLocaleLowerCase("en")}`
    ).join("-")
  );
}

export function assertCanonicalRdlTitle(title: string, context = "RDL title"): string {
  const normalized = title.trim();
  if (!normalized) throw new Error(`${context} must not be empty`);
  const wordCount = countEnglishTitleWords(normalized);
  if (wordCount === 0 || wordCount > RDL_TITLE_MAX_ENGLISH_WORDS) {
    throw new Error(
      `${context} must contain 1-${RDL_TITLE_MAX_ENGLISH_WORDS} English words; received ${wordCount}`
    );
  }
  if (normalized.includes("…") || normalized.includes("...")) {
    throw new Error(`${context} must not use an ellipsis`);
  }
  if (FORBIDDEN_GENERIC_TITLE.test(normalized)) {
    throw new Error(`${context} must not be a generic placeholder`);
  }
  const canonical = canonicalizeRdlTitleCapitalization(normalized);
  if (canonical !== normalized) {
    throw new Error(
      `${context} must capitalize every English word with an uppercase first letter and lowercase remainder; expected ${canonical}`
    );
  }
  return normalized;
}

export function decideRdlProductionTitle(input: RdlTitleDecisionInput): RdlTitleDecision {
  const originalTitle = input.originalTitle?.trim() || null;
  if (input.explicitOriginalTitle !== Boolean(originalTitle)) {
    throw new Error("explicitOriginalTitle must match the presence of originalTitle");
  }
  const originalTitleWordCount = originalTitle ? countEnglishTitleWords(originalTitle) : 0;
  if (originalTitle && originalTitleWordCount <= RDL_TITLE_MAX_ENGLISH_WORDS) {
    const title = canonicalizeRdlTitleCapitalization(originalTitle);
    return {
      action: "KEEP_ORIGINAL",
      title: assertCanonicalRdlTitle(title, "explicit RDL original title"),
      originalTitleWordCount
    };
  }

  const title = assertCanonicalRdlTitle(
    canonicalizeRdlTitleCapitalization(input.generatedTitle ?? ""),
    "generated RDL title"
  );
  rejectOpeningCopy(title, input.sourceOpeningText);
  rejectOriginalTruncation(title, originalTitle);
  return { action: "GENERATE_SHORT_TITLE", title, originalTitleWordCount };
}

function rejectOpeningCopy(title: string, sourceOpeningText?: string | null) {
  if (!sourceOpeningText?.trim()) return;
  const titleWords = englishWords(title);
  const openingWords = englishWords(sourceOpeningText).slice(0, titleWords.length);
  if (titleWords.length > 1 && sameWords(titleWords, openingWords)) {
    throw new Error("generated RDL title must not copy the opening words of the material body");
  }
}

function rejectOriginalTruncation(title: string, originalTitle: string | null) {
  if (!originalTitle) return;
  const titleWords = englishWords(title);
  const originalWords = englishWords(originalTitle).slice(0, titleWords.length);
  if (titleWords.length > 1 && sameWords(titleWords, originalWords)) {
    throw new Error("generated RDL title must not truncate the original title");
  }
}

function englishWords(value: string): string[] {
  return (value.match(ENGLISH_WORD) ?? []).map((word) => word.toLocaleLowerCase("en"));
}

function sameWords(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}
