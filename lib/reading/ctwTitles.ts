export const CTW_TITLE_MAX_WORDS = 5;

const ENGLISH_TITLE = /^(?=.*[A-Za-z])[\x20-\x7E]+$/;
const NUMBERED_LABEL = /\b(?:question|set|suite|no\.?)[\s#-]*\d+\b/i;

export function assertCanonicalCtwTitle(title: string, context = "CTW title") {
  const normalized = title.trim();
  if (!normalized) throw new Error(`${context} must not be empty`);
  const wordCount = normalized.split(/\s+/).length;
  if (wordCount > CTW_TITLE_MAX_WORDS) {
    throw new Error(`${context} must contain at most ${CTW_TITLE_MAX_WORDS} whitespace-separated words; received ${wordCount}`);
  }
  if (!ENGLISH_TITLE.test(normalized)) {
    throw new Error(`${context} must be an English title`);
  }
  return normalized;
}

export function assertIncomingCtwTitle(input: {
  title: string;
  sourceLabels: string[];
  occurrenceDates: string[];
  yearMonths: string[];
}, context = "CTW title") {
  const title = assertCanonicalCtwTitle(input.title, context);
  const lowerTitle = title.toLocaleLowerCase("en");
  const forbiddenValues = [...input.sourceLabels, ...input.occurrenceDates, ...input.yearMonths]
    .map((value) => value.trim().toLocaleLowerCase("en"))
    .filter(Boolean);
  if (/\bctw\b/i.test(title) || /套题|题目/.test(title) || NUMBERED_LABEL.test(title)) {
    throw new Error(`${context} must not contain CTW, a question number, or a suite number`);
  }
  if (forbiddenValues.some((value) => lowerTitle.includes(value))) {
    throw new Error(`${context} must not contain a source label or source date`);
  }
  return title;
}
