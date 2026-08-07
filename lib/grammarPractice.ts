import type { PublicQuestion } from "@/lib/types";

export type GrammarQuestionRow = PublicQuestion & {
  final_sentence: string | null;
};

export type GrammarTagSummary = {
  tag: string;
  questionCount: number;
};

export function parseGrammarTags(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized === "[]") return [];

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (Array.isArray(parsed)) {
        return uniqueTags(parsed.map((tag) => String(tag)));
      }
    } catch {
      return [];
    }
  }

  return uniqueTags(normalized.split(";"));
}

export function normalizeFinalSentence(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function compareGrammarQuestions(
  left: Pick<GrammarQuestionRow, "set_id" | "question_order" | "question_id">,
  right: Pick<GrammarQuestionRow, "set_id" | "question_order" | "question_id">
) {
  return (
    left.set_id.localeCompare(right.set_id) ||
    left.question_order - right.question_order ||
    left.question_id.localeCompare(right.question_id)
  );
}

export function dedupeGrammarQuestions(questions: GrammarQuestionRow[]) {
  const uniqueBySentence = new Map<string, GrammarQuestionRow>();

  for (const question of [...questions].sort(compareGrammarQuestions)) {
    const sentence = normalizeFinalSentence(question.final_sentence);
    const key = sentence
      ? `sentence:${sentence}`
      : `question:${question.question_id}`;
    if (!uniqueBySentence.has(key)) uniqueBySentence.set(key, question);
  }

  return Array.from(uniqueBySentence.values());
}

export function getGrammarTagSummaries(questions: GrammarQuestionRow[]) {
  const questionsByTag = new Map<string, GrammarQuestionRow[]>();

  for (const question of questions) {
    for (const tag of parseGrammarTags(question.grammar_tags_text)) {
      questionsByTag.set(tag, [...(questionsByTag.get(tag) ?? []), question]);
    }
  }

  return Array.from(questionsByTag, ([tag, taggedQuestions]) => ({
    tag,
    questionCount: dedupeGrammarQuestions(taggedQuestions).length
  })).sort((left, right) => left.tag.localeCompare(right.tag));
}

export function questionHasGrammarTag(
  question: Pick<GrammarQuestionRow, "grammar_tags_text">,
  selectedTag: string
) {
  return parseGrammarTags(question.grammar_tags_text).includes(selectedTag);
}

export function shuffleQuestions<T>(questions: T[]) {
  const shuffled = [...questions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function uniqueTags(tags: string[]) {
  return Array.from(
    new Set(tags.map((tag) => tag.replace(/\s+/g, " ").trim()).filter(Boolean))
  );
}
