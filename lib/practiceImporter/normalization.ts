import { createHash } from "node:crypto";
import type {
  AcademicDiscussionIdentityInput,
  BuildSentenceQuestionInput,
  EmailIdentityInput
} from "./types.ts";

const SMART_PUNCTUATION: Array<[string, string]> = [
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201c", '"'],
  ["\u201d", '"'],
  ["\u00b4", "'"],
  ["\u0060", "'"]
];

export function normalizeComparableText(value: unknown) {
  let normalized = String(value ?? "").normalize("NFKC");
  for (const [source, replacement] of SMART_PUNCTUATION) {
    normalized = normalized.split(source).join(replacement);
  }
  return normalized
    .replace(/['"]/g, "")
    .replace(/[.,!?;:()[\]{}\/\\_\-–—。！？；：、]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function parseTextArray(
  value: unknown,
  fieldName = "structured text",
  allowEmpty = false
) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (allowEmpty && !String(value ?? "").trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? ""));
  } catch {
    throw new Error(`${fieldName} must be a JSON array`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${fieldName} must be a JSON string array`);
  }
  return parsed;
}

export function normalizeOrderedTextArray(value: unknown, fieldName?: string) {
  return parseTextArray(value, fieldName).map(normalizeComparableText);
}

export function normalizeTextSet(value: unknown, fieldName?: string, allowEmpty = false) {
  return parseTextArray(value, fieldName, allowEmpty).map(normalizeComparableText).sort(compareText);
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      compareText(left, right)
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value: unknown) {
  return createHash("md5").update(stableSerialize(value), "utf8").digest("hex");
}

export function normalizeBuildSentenceQuestion(question: BuildSentenceQuestionInput) {
  return {
    sentenceTemplate: normalizeComparableText(question.sentenceTemplate),
    blankCount: question.blankCount,
    correctOrder: normalizeOrderedTextArray(question.correctOrderText, "correct_order_text"),
    options: normalizeTextSet(question.optionsText, "options_text"),
    distractors: normalizeTextSet(question.distractorsText, "distractors_text", true),
    finalSentence: normalizeComparableText(question.finalSentence)
  };
}

export function buildSentenceQuestionFingerprint(question: BuildSentenceQuestionInput) {
  return fingerprint(normalizeBuildSentenceQuestion(question));
}

export function buildSentenceSetFingerprint(questions: BuildSentenceQuestionInput[]) {
  return fingerprint(questions.map(buildSentenceQuestionFingerprint).sort(compareText));
}

export function normalizeEmailIdentity(input: EmailIdentityInput) {
  return {
    scenario: normalizeComparableText(input.scenario),
    taskInstruction: normalizeComparableText(input.taskInstruction),
    requirements: input.requirements.map(normalizeComparableText).sort(compareText),
    recipient: normalizeComparableText(input.recipient)
  };
}

export function emailFingerprint(input: EmailIdentityInput) {
  return fingerprint(normalizeEmailIdentity(input));
}

export function normalizeAcademicDiscussionIdentity(input: AcademicDiscussionIdentityInput) {
  return {
    professorPrompt: normalizeComparableText(input.professorPrompt),
    studentResponses: input.studentResponses.map(normalizeComparableText).sort(compareText)
  };
}

export function academicDiscussionFingerprint(input: AcademicDiscussionIdentityInput) {
  return fingerprint(normalizeAcademicDiscussionIdentity(input));
}

export function normalizedSimilarity(left: unknown, right: unknown) {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (a === b) return 1;
  if (!a || !b) return 0;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    const current = [aIndex];
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      current[bIndex] = Math.min(
        current[bIndex - 1] + 1,
        previous[bIndex] + 1,
        previous[bIndex - 1] + (a[aIndex - 1] === b[bIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
