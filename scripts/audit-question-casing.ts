import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";

type QuestionTextModule = typeof import("../lib/questionText");
type CsvModule = typeof import("../lib/csv");

let questionText: QuestionTextModule | null = null;
let csvModule: CsvModule | null = null;

type QuestionRow = {
  source_file: string;
  question_id: string;
  set_id: string;
  set_title: string;
  question_order: number;
  sentence_template: string | null;
  options_text: string | null;
  correct_order_text: string | null;
  distractors_text: string | null;
  final_sentence: string | null;
};

type AuditedField =
  | "sentence_template"
  | "options_text"
  | "correct_order_text"
  | "distractors_text"
  | "final_sentence";

type Finding = {
  source_file: string;
  question_id: string;
  set_id: string;
  set_title: string;
  question_order: number;
  category: "casing_issue" | "distractor_case_review";
  field: AuditedField;
  stored_value: string;
  reference_value: string;
  reason: string;
  suggested_value: string;
};

type TextOccurrence = {
  field: AuditedField;
  text: string;
  sentenceInitial: boolean;
};

type WordOccurrence = TextOccurrence & {
  word: string;
};

const DEFAULT_INPUT_PATH = "/Users/rico/Documents/下载/组句标准题库";
const OUTPUT_PATH = resolve(process.cwd(), "question-casing-audit.csv");
const REQUIRED_COLUMNS = [
  "question_id",
  "set_id",
  "set_title",
  "question_order",
  "sentence_template",
  "options_text",
  "correct_order_text",
  "distractors_text",
  "final_sentence"
];

async function main() {
  const questionTextModulePath = "../lib/questionText.ts";
  const csvModulePath = "../lib/csv.ts";
  questionText = (await import(questionTextModulePath)) as QuestionTextModule;
  csvModule = (await import(csvModulePath)) as CsvModule;

  const inputPath = resolve(process.argv[2] ?? DEFAULT_INPUT_PATH);
  const sourceFiles = collectCsvFiles(inputPath);
  if (sourceFiles.length === 0) {
    throw new Error(`No CSV files found at: ${inputPath}`);
  }

  const questions = sourceFiles.flatMap(loadQuestionsFromCsv);
  const findings = questions.flatMap(auditQuestion);

  writeFileSync(OUTPUT_PATH, toCsv(findings), "utf8");

  console.log(`CSV files read: ${sourceFiles.length}`);
  console.log(`Audited questions: ${questions.length}`);
  console.log(`Suspicious records: ${findings.length}`);
  console.log(
    `distractor_case_review: ${
      findings.filter((finding) => finding.category === "distractor_case_review").length
    }`
  );
  console.log(`CSV report: ${OUTPUT_PATH}`);
  printStorageFormats(questions);
  console.log(
    "Manual review still required: proper nouns or names that use the same incorrect " +
      "casing in every field cannot be detected automatically."
  );
}

function collectCsvFiles(inputPath: string): string[] {
  const inputStats = statSync(inputPath);
  if (inputStats.isFile()) {
    return extname(inputPath).toLocaleLowerCase() === ".csv" ? [inputPath] : [];
  }
  if (!inputStats.isDirectory()) return [];

  return readdirSync(inputPath, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = resolve(inputPath, entry.name);
      if (entry.isDirectory()) return collectCsvFiles(entryPath);
      return entry.isFile() && extname(entry.name).toLocaleLowerCase() === ".csv"
        ? [entryPath]
        : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function loadQuestionsFromCsv(sourceFile: string): QuestionRow[] {
  const rows = getCsvModule().parseCsv(readFileSync(sourceFile, "utf8"));
  if (rows.length === 0) return [];

  const missingColumns = REQUIRED_COLUMNS.filter((column) => !(column in rows[0]));
  if (missingColumns.length > 0) {
    throw new Error(
      `CSV headers do not match in ${sourceFile}. Missing: ${missingColumns.join(", ")}`
    );
  }

  return rows.map((row, index) => {
    const questionOrder = Number(row.question_order);
    if (!row.question_id) {
      throw new Error(`Missing question_id in ${sourceFile}, CSV row ${index + 2}`);
    }
    if (!Number.isFinite(questionOrder)) {
      throw new Error(
        `Invalid question_order in ${sourceFile}, CSV row ${index + 2}: ${row.question_order}`
      );
    }

    return {
      source_file: sourceFile,
      question_id: row.question_id,
      set_id: row.set_id,
      set_title: row.set_title,
      question_order: questionOrder,
      sentence_template: row.sentence_template,
      options_text: row.options_text,
      correct_order_text: row.correct_order_text,
      distractors_text: row.distractors_text,
      final_sentence: row.final_sentence
    };
  });
}

function auditQuestion(question: QuestionRow) {
  const findings: Finding[] = [];
  const findingKeys = new Set<string>();
  const options = getQuestionText().splitTextItems(question.options_text);
  const correct = getQuestionText().splitTextItems(question.correct_order_text);
  const distractors = getQuestionText().splitTextItems(question.distractors_text);
  const finalSentence = normalizeSpacing(question.final_sentence ?? "");
  const firstCorrectIsSentenceInitial = isFirstBlankAtSentenceStart(
    question.sentence_template ?? ""
  );

  function addFinding(
    field: AuditedField,
    storedValue: string,
    referenceValue: string,
    reason: string,
    category: Finding["category"] = "casing_issue",
    suggestedValue = referenceValue
  ) {
    const key = [category, field, storedValue, referenceValue].join("\u0000");
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push({
      source_file: question.source_file,
      question_id: String(question.question_id),
      set_id: String(question.set_id),
      set_title: question.set_title ?? "",
      question_order: question.question_order ?? 0,
      category,
      field,
      stored_value: storedValue,
      reference_value: referenceValue,
      reason,
      suggested_value: suggestedValue
    });
  }

  if (finalSentence && startsWithLowercaseEnglishLetter(finalSentence)) {
    addFinding(
      "final_sentence",
      question.final_sentence ?? "",
      capitalizeFirstLowercaseEnglishLetter(finalSentence),
      "Complete sentence starts with a lowercase English letter"
    );
  }

  for (const occurrence of buildTextOccurrences(
    question,
    options,
    correct,
    distractors,
    firstCorrectIsSentenceInitial
  )) {
    auditLowercaseI(occurrence, addFinding);
    auditLowercaseNameAfterTitle(occurrence, addFinding);
  }

  auditDistractorCaseReview(distractors, addFinding);

  compareCorrectChunksWithFinal(
    correct,
    options,
    finalSentence,
    firstCorrectIsSentenceInitial,
    addFinding
  );
  compareChunkCollections(
    options,
    "options_text",
    correct,
    "correct_order_text",
    "options_text and correct_order_text contain the same chunk with different casing",
    addFinding
  );
  compareChunkCollections(
    distractors,
    "distractors_text",
    correct,
    "correct_order_text",
    "distractors_text and correct_order_text contain the same chunk with different casing",
    addFinding
  );
  compareChunkCollections(
    distractors,
    "distractors_text",
    options,
    "options_text",
    "distractors_text and options_text contain the same chunk with different casing",
    addFinding
  );

  auditTemplateAndFinalWordCasing(question, addFinding);

  return findings;
}

function auditDistractorCaseReview(
  distractors: string[],
  addFinding: (
    field: AuditedField,
    storedValue: string,
    referenceValue: string,
    reason: string,
    category?: Finding["category"],
    suggestedValue?: string
  ) => void
) {
  for (const distractor of distractors) {
    const firstWord = distractor.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/)?.[0] ?? "";
    if (!/^[A-Z]/.test(firstWord) || hasIntrinsicLeadingCapitalization(firstWord)) continue;

    addFinding(
      "distractors_text",
      distractor,
      "",
      "Distractor starts with an uppercase word but has no correct-answer sentence context; review neutral casing manually",
      "distractor_case_review",
      ""
    );
  }
}

function hasIntrinsicLeadingCapitalization(word: string) {
  if (/^I(?:['’](?:m|ve|ll|d))?$/i.test(word)) return true;
  if (/^[A-Z]{2,}$/.test(word)) return true;
  return /^(?:Mr|Ms|Mrs|Dr)\.?$/i.test(word);
}

function buildTextOccurrences(
  question: QuestionRow,
  options: string[],
  correct: string[],
  distractors: string[],
  firstCorrectIsSentenceInitial: boolean
): TextOccurrence[] {
  const occurrences: TextOccurrence[] = [];
  const template = question.sentence_template ?? "";
  const templateStartsWithText = startsWithTextBeforeFirstBlank(template);

  if (template) {
    occurrences.push({
      field: "sentence_template",
      text: template,
      sentenceInitial: templateStartsWithText
    });
  }
  if (question.final_sentence) {
    occurrences.push({
      field: "final_sentence",
      text: question.final_sentence,
      sentenceInitial: true
    });
  }
  options.forEach((text) => {
    occurrences.push({
      field: "options_text",
      text,
      sentenceInitial:
        firstCorrectIsSentenceInitial &&
        correct.some((chunk, index) => index === 0 && sameIgnoringCase(chunk, text))
    });
  });
  correct.forEach((text, index) => {
    occurrences.push({
      field: "correct_order_text",
      text,
      sentenceInitial: index === 0 && firstCorrectIsSentenceInitial
    });
  });
  distractors.forEach((text) => {
    occurrences.push({ field: "distractors_text", text, sentenceInitial: false });
  });

  return occurrences;
}

function auditLowercaseI(
  occurrence: TextOccurrence,
  addFinding: (
    field: AuditedField,
    storedValue: string,
    referenceValue: string,
    reason: string
  ) => void
) {
  const standaloneI = /\bi\b(?!['’](?:m|ve|ll|d)\b)/g;
  for (const match of Array.from(occurrence.text.matchAll(standaloneI))) {
    addFinding(
      occurrence.field,
      match[0],
      "I",
      "Standalone first-person pronoun is lowercase"
    );
  }

  const contraction = /\bi(['’])(m|ve|ll|d)\b/g;
  for (const match of Array.from(occurrence.text.matchAll(contraction))) {
    addFinding(
      occurrence.field,
      match[0],
      `I${match[1]}${match[2]}`,
      "First-person contraction starts with lowercase i"
    );
  }
}

function auditLowercaseNameAfterTitle(
  occurrence: TextOccurrence,
  addFinding: (
    field: AuditedField,
    storedValue: string,
    referenceValue: string,
    reason: string
  ) => void
) {
  const titleAndName = /\b(Mr|Ms|Mrs|Dr)\.\s+([a-z][A-Za-z'’.-]*)/g;
  for (const match of Array.from(occurrence.text.matchAll(titleAndName))) {
    addFinding(
      occurrence.field,
      match[0],
      `${match[1]}. ${capitalizeFirstLowercaseEnglishLetter(match[2])}`,
      `${match[1]}. is followed by a name beginning with a lowercase letter`
    );
  }
}

function compareCorrectChunksWithFinal(
  correct: string[],
  options: string[],
  finalSentence: string,
  firstCorrectIsSentenceInitial: boolean,
  addFinding: (
    field: AuditedField,
    storedValue: string,
    referenceValue: string,
    reason: string
  ) => void
) {
  if (!finalSentence) return;

  correct.forEach((storedChunk, index) => {
    const chunk = normalizeSpacing(storedChunk);
    if (!chunk) return;
    const matches = findIgnoringCase(finalSentence, chunk);
    if (matches.length === 0 || matches.some((match) => match.value === chunk)) return;

    const reference = matches[0];
    const allowedSentenceInitialDifference =
      index === 0 &&
      firstCorrectIsSentenceInitial &&
      reference.firstEnglishIndex === firstEnglishLetterIndex(finalSentence) &&
      differsOnlyBySentenceInitial(chunk, reference.value);

    if (!allowedSentenceInitialDifference) {
      addFinding(
        "correct_order_text",
        storedChunk,
        reference.value,
        "correct_order_text chunk matches final_sentence only when casing is ignored"
      );
      for (const option of options.filter((item) => sameCase(item, storedChunk))) {
        addFinding(
          "options_text",
          option,
          reference.value,
          "options_text chunk uses the same inconsistent casing as correct_order_text relative to final_sentence"
        );
      }
    }
  });
}

function compareChunkCollections(
  storedItems: string[],
  storedField: AuditedField,
  referenceItems: string[],
  _referenceField: AuditedField,
  reason: string,
  addFinding: (
    field: AuditedField,
    storedValue: string,
    referenceValue: string,
    reason: string
  ) => void
) {
  for (const storedItem of storedItems) {
    const references = referenceItems.filter((reference) =>
      sameIgnoringCase(storedItem, reference)
    );
    if (references.length === 0 || references.some((reference) => sameCase(storedItem, reference))) {
      continue;
    }
    addFinding(storedField, storedItem, references[0], reason);
  }
}

function auditTemplateAndFinalWordCasing(
  question: QuestionRow,
  addFinding: (
    field: AuditedField,
    storedValue: string,
    referenceValue: string,
    reason: string
  ) => void
) {
  const textOccurrences = ([
    {
      field: "sentence_template",
      text: question.sentence_template ?? "",
      sentenceInitial: startsWithTextBeforeFirstBlank(question.sentence_template ?? "")
    },
    {
      field: "final_sentence",
      text: question.final_sentence ?? "",
      sentenceInitial: true
    }
  ] satisfies TextOccurrence[]).filter((occurrence) => Boolean(occurrence.text));
  const wordsByNormalizedForm = new Map<string, WordOccurrence[]>();

  for (const occurrence of textOccurrences) {
    const words = Array.from(occurrence.text.matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g));
    words.forEach((match, index) => {
      const word = match[0];
      const key = word.toLocaleLowerCase();
      const entries = wordsByNormalizedForm.get(key) ?? [];
      entries.push({
        ...occurrence,
        word,
        sentenceInitial: occurrence.sentenceInitial && index === 0
      });
      wordsByNormalizedForm.set(key, entries);
    });
  }

  for (const occurrences of Array.from(wordsByNormalizedForm.values())) {
    if (new Set(occurrences.map((item) => item.field)).size < 2) continue;
    if (new Set(occurrences.map((item) => item.word)).size < 2) continue;

    for (const occurrence of occurrences) {
      if (occurrence.field === "final_sentence") continue;
      const references = occurrences.filter((item) => item.field === "final_sentence");
      if (references.some((item) => item.word === occurrence.word)) continue;
      const reference = references[0];
      if (isAllowedSentenceInitialWordDifference(occurrence, reference)) continue;

      addFinding(
        occurrence.field,
        occurrence.word,
        reference.word,
        `Word casing differs between ${occurrence.field} and ${reference.field}`
      );
    }
  }
}

function isAllowedSentenceInitialWordDifference(
  occurrence: WordOccurrence,
  reference: WordOccurrence
) {
  const [lowercase, capitalized] = /^[a-z]/.test(occurrence.word)
    ? [occurrence, reference]
    : [reference, occurrence];

  return Boolean(
    lowercase.sentenceInitial &&
      capitalized.sentenceInitial &&
      differsOnlyBySentenceInitial(lowercase.word, capitalized.word)
  );
}

function findIgnoringCase(haystack: string, needle: string) {
  const matches: Array<{ value: string; firstEnglishIndex: number }> = [];
  const lowerHaystack = haystack.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  let from = 0;

  while (from <= haystack.length - needle.length) {
    const index = lowerHaystack.indexOf(lowerNeedle, from);
    if (index === -1) break;
    const value = haystack.slice(index, index + needle.length);
    matches.push({
      value,
      firstEnglishIndex: index + firstEnglishLetterIndex(value)
    });
    from = index + 1;
  }

  return matches;
}

function isFirstBlankAtSentenceStart(template: string) {
  if (!template) return true;
  const { isBlankToken, splitSentenceTemplate } = getQuestionText();
  const parts = splitSentenceTemplate(template);
  const firstBlankIndex = parts.findIndex(isBlankToken);
  if (firstBlankIndex === -1) return false;
  return parts.slice(0, firstBlankIndex).every((part) => !/[A-Za-z]/.test(part));
}

function startsWithTextBeforeFirstBlank(template: string) {
  if (!template) return false;
  const { isBlankToken, splitSentenceTemplate } = getQuestionText();
  const parts = splitSentenceTemplate(template);
  const firstBlankIndex = parts.findIndex(isBlankToken);
  const fixedPrefix = firstBlankIndex === -1 ? template : parts.slice(0, firstBlankIndex).join("");
  return /[A-Za-z]/.test(fixedPrefix);
}

function startsWithLowercaseEnglishLetter(value: string) {
  const index = firstEnglishLetterIndex(value);
  return index >= 0 && /[a-z]/.test(value[index]);
}

function firstEnglishLetterIndex(value: string) {
  return value.search(/[A-Za-z]/);
}

function capitalizeFirstLowercaseEnglishLetter(value: string) {
  const index = firstEnglishLetterIndex(value);
  if (index === -1 || !/[a-z]/.test(value[index])) return value;
  return `${value.slice(0, index)}${value[index].toLocaleUpperCase()}${value.slice(index + 1)}`;
}

function differsOnlyBySentenceInitial(stored: string, reference: string) {
  const left = normalizeSpacing(stored);
  const right = normalizeSpacing(reference);
  if (left.length !== right.length || left.toLocaleLowerCase() !== right.toLocaleLowerCase()) {
    return false;
  }

  const leftIndex = firstEnglishLetterIndex(left);
  const rightIndex = firstEnglishLetterIndex(right);
  if (leftIndex === -1 || leftIndex !== rightIndex) return false;
  if (!/[a-z]/.test(left[leftIndex]) || !/[A-Z]/.test(right[rightIndex])) return false;

  return (
    left.slice(0, leftIndex) === right.slice(0, rightIndex) &&
    left.slice(leftIndex + 1) === right.slice(rightIndex + 1)
  );
}

function sameIgnoringCase(left: string, right: string) {
  return normalizeSpacing(left).toLocaleLowerCase() === normalizeSpacing(right).toLocaleLowerCase();
}

function sameCase(left: string, right: string) {
  return normalizeSpacing(left) === normalizeSpacing(right);
}

function normalizeSpacing(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function getQuestionText() {
  if (!questionText) throw new Error("Question text parser is not initialized.");
  return questionText;
}

function getCsvModule() {
  if (!csvModule) throw new Error("CSV parser is not initialized.");
  return csvModule;
}

function toCsv(findings: Finding[]) {
  const columns: Array<keyof Finding> = [
    "source_file",
    "question_id",
    "set_id",
    "set_title",
    "question_order",
    "category",
    "field",
    "stored_value",
    "reference_value",
    "reason",
    "suggested_value"
  ];
  const rows = findings.map((finding) =>
    columns.map((column) => csvCell(String(finding[column] ?? ""))).join(",")
  );
  return `${columns.join(",")}\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function printStorageFormats(questions: QuestionRow[]) {
  for (const field of ["options_text", "correct_order_text", "distractors_text"] as const) {
    const counts = new Map<string, number>();
    for (const question of questions) {
      const format = detectStorageFormat(question[field]);
      counts.set(format, (counts.get(format) ?? 0) + 1);
    }
    console.log(
      `${field} formats: ${Array.from(counts.entries())
        .map(([format, count]) => `${format}=${count}`)
        .join(", ")}`
    );
  }
}

function detectStorageFormat(value: string | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "empty";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      return Array.isArray(JSON.parse(trimmed)) ? "json-array" : "json-other";
    } catch {
      return "invalid-json-like";
    }
  }
  if (trimmed.includes("|")) return "pipe-delimited";
  if (trimmed.includes("\n")) return "newline-delimited";
  if (trimmed.includes(",")) return "comma-delimited";
  return "single-value";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
